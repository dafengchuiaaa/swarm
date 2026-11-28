"""Silent friction probe: 记一次工具抖动，但绝不让主任务为此付代价。

设计约束（对应"四不原则"第 1 条）：
- 不调用任何模型、不做反思、不等网络——只做脱敏 + 算指纹 + 一条 INSERT；
- 任何内部异常一律 fail-open（返回 False），探针坏了不能拖垮业务；
- 脱敏与指纹全部复用 `execution_review`，不另造一套正则（避免两套规则打架）。
"""
import json
import threading
from datetime import datetime, timezone

from execution_review import REDACTED, safe_fingerprint, sanitize, sanitize_text

SCHEMA = '''
CREATE TABLE IF NOT EXISTS tool_friction_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  detail TEXT NOT NULL,
  workspace TEXT,
  event_id TEXT,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  issue_id TEXT,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS friction_by_fingerprint ON tool_friction_events(project,fingerprint,seq);
CREATE INDEX IF NOT EXISTS friction_unaggregated ON tool_friction_events(project,issue_id,seq);
'''

# 同一条执行事件只允许记一次账。手动调 record_tool_friction 时 event_id 为 NULL，
# 不进这个部分唯一索引，仍然可以一条事件记多条（不同工具同名调用等）。
MIGRATIONS = '''
CREATE UNIQUE INDEX IF NOT EXISTS friction_event_once
  ON tool_friction_events(project,event_id) WHERE event_id IS NOT NULL;
'''

MAX_DETAIL_CHARS = 1500
MAX_ARGS = 32


def _now():
    return datetime.now(timezone.utc).isoformat()


def _as_arg_list(args):
    """把任意形态的参数压成稳定的字符串列表，保证同一问题算出同一个指纹。"""
    if args is None:
        return []
    if isinstance(args, (list, tuple)):
        return [str(item) for item in args][:MAX_ARGS]
    if isinstance(args, dict):
        return [f'{key}={args[key]}' for key in sorted(args, key=str)][:MAX_ARGS]
    return [str(args)]


def _fingerprint(tool_name, safe_args, workspace):
    """复用 execution_review 的语义指纹：同工具、同参数、同目录，才算同一处暗礁。

    注意这里喂的是脱敏后的参数——既避免密钥进哈希，也顺带把"同一错误但
    token 每次都不同"的调用聚成一组，这正是我们要的聚类效果。
    """
    event = {
        'tool_name': tool_name,
        'parameters_summary': {'command': str(tool_name or ''), 'args': _as_arg_list(safe_args)},
        'cwd': workspace,
        'operation': 'execute',
    }
    return safe_fingerprint(event)


def _excerpt(value, limit=MAX_DETAIL_CHARS):
    text = sanitize_text(value if value is not None else '', limit)
    # 脱敏结果里若出现被替换掉的密钥占位，说明原文确实带了敏感信息——保留占位是有意为之，
    # 后续排查需要知道"这里被脱敏过"，而不是看到一个干净得可疑的空串。
    return text


class FrictionTracer:
    """挂在某个 MemoryStore 上的记账器。不含任何决策逻辑。"""

    def __init__(self, store, project):
        self.store = store
        self.project = project
        self._ensure_schema()

    def _ensure_schema(self):
        with self.store.lock:
            self.store.db.executescript(SCHEMA)
            # 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段
            columns = {row['name'] for row in
                       self.store.db.execute('PRAGMA table_info(tool_friction_events)')}
            if 'event_id' not in columns:
                self.store.db.execute('ALTER TABLE tool_friction_events ADD COLUMN event_id TEXT')
            self.store.db.executescript(MIGRATIONS)

    def record(self, tool_name, args, error_output, exit_code, duration_ms=None, workspace=None,
               event_id=None):
        """返回 True 表示这次摩擦/自愈被记账，False 表示按规则忽略或内部出错。

        这里再包一层 try 是刻意的：即使调用方绕开模块级钩子直接拿 tracer 用，
        探针也不能把异常抛回业务线程。
        """
        try:
            return self._record(tool_name, args, error_output, exit_code, duration_ms, workspace,
                                event_id)
        except Exception:
            return False

    def _record(self, tool_name, args, error_output, exit_code, duration_ms, workspace, event_id=None):
        if not tool_name:
            return False
        ok = self._normalize_exit(exit_code)
        if ok == 0:
            return self._record_recovery(tool_name, args, workspace)
        if ok is None and not str(error_output or '').strip():
            # 既没有退出码也没有错误输出：这不是摩擦，是调用方没给信息，不记
            return False
        return self._record_failure(tool_name, args, error_output, ok, duration_ms, workspace,
                                    event_id)

    @staticmethod
    def _normalize_exit(exit_code):
        if exit_code is None or exit_code == '':
            return None
        try:
            return int(exit_code)
        except (TypeError, ValueError):
            return None

    def _record_failure(self, tool_name, args, error_output, exit_code, duration_ms, workspace,
                        event_id=None):
        safe_args = sanitize(args) if not isinstance(args, (str, bytes)) else sanitize_text(args, 400)
        safe_error = _excerpt(error_output)
        fingerprint = _fingerprint(tool_name, safe_args, workspace)
        detail = json.dumps({'args': safe_args, 'error': safe_error}, ensure_ascii=False, sort_keys=True)
        with self.store.lock:
            with self.store.db:
                # INSERT OR IGNORE + 部分唯一索引 = 同一条执行事件重复上报只留一条
                cursor = self.store.db.execute(
                    'INSERT OR IGNORE INTO tool_friction_events'
                    '(project,tool_name,fingerprint,exit_code,duration_ms,detail,workspace,'
                    'event_id,resolved_count,created)'
                    ' VALUES(?,?,?,?,?,?,?,?,0,?)',
                    (self.project, str(tool_name), fingerprint, exit_code,
                     int(duration_ms) if isinstance(duration_ms, (int, float)) else None,
                     detail, str(workspace or ''), event_id, _now()))
        return cursor.rowcount == 1

    def _record_recovery(self, tool_name, args, workspace):
        """退出码为 0：说明上一次同指纹失败被重试救回来了，给那条记录记一次自愈。

        不新增行——"重试才成功"的价值在于给失败次数打上"可自愈"标记，
        而不是在账本里再堆一条成功流水。
        """
        safe_args = sanitize(args) if not isinstance(args, (str, bytes)) else sanitize_text(args, 400)
        fingerprint = _fingerprint(tool_name, safe_args, workspace)
        with self.store.lock:
            row = self.store.db.execute(
                'SELECT seq FROM tool_friction_events'
                ' WHERE project=? AND fingerprint=? AND issue_id IS NULL'
                ' ORDER BY seq DESC LIMIT 1', (self.project, fingerprint)).fetchone()
            if not row:
                return False
            with self.store.db:
                self.store.db.execute(
                    'UPDATE tool_friction_events SET resolved_count=resolved_count+1 WHERE seq=?',
                    (row['seq'],))
        return True


# --- 模块级钩子：业务 Agent 直接调用，不需要持有 store -----------------------

_TRACERS = {}
_DEFAULT = object()
_REGISTRY_LOCK = threading.Lock()


def install_tracer(store, project):
    """注册一个项目的记账器；重复注册会覆盖。返回 tracer 便于直接调用。"""
    tracer = FrictionTracer(store, project)
    with _REGISTRY_LOCK:
        _TRACERS[project] = tracer
        _TRACERS[_DEFAULT] = tracer
    return tracer


def uninstall_store(store):
    """移除引用给定 store 实例的全部注册项（MemoryStore.close 时调用）。

    复核缺口 HIGH-3：项目关闭重开后，注册表里的旧 tracer 仍指向已关库实例，
    "注册表非空"会把新实例永久挡在门外，摩擦账本停写。close 时主动摘除
    自己的注册，重开后的首次事件收口即可惰性装回新实例。
    """
    with _REGISTRY_LOCK:
        stale = [key for key, tracer in _TRACERS.items()
                 if getattr(tracer, 'store', None) is store]
        for key in stale:
            _TRACERS.pop(key, None)
        if _TRACERS.get(_DEFAULT) is None:
            remaining = [tracer for key, tracer in _TRACERS.items() if key is not _DEFAULT]
            if remaining:
                _TRACERS[_DEFAULT] = remaining[-1]


def uninstall_tracer(project=None):
    with _REGISTRY_LOCK:
        if project is None:
            _TRACERS.clear()
            return
        _TRACERS.pop(project, None)
        if _TRACERS.get(_DEFAULT) is not None:
            remaining = [v for k, v in _TRACERS.items() if k is not _DEFAULT]
            if remaining:
                _TRACERS[_DEFAULT] = remaining[-1]
            else:
                _TRACERS.pop(_DEFAULT, None)


def get_tracer(project=None):
    with _REGISTRY_LOCK:
        if project is not None:
            return _TRACERS.get(project)
        return _TRACERS.get(_DEFAULT)


def record_tool_friction(tool_name, args=None, error_output='', exit_code=None,
                         duration_ms=None, workspace=None, project=None, event_id=None):
    """业务侧唯一需要知道的入口。

    调用方只管把它塞进工具的失败分支；这个函数保证不抛异常、不阻塞、不改动任何入参。
    """
    try:
        tracer = get_tracer(project)
        if tracer is None:
            return False
        return tracer.record(tool_name, args, error_output, exit_code, duration_ms, workspace,
                             event_id)
    except Exception:
        # fail-open：探针自身故障不能演变成业务故障
        return False


def record_from_execution_event(event, project=None):
    """把一条已规范化的 execution_event 折算成一次摩擦记账。

    这是挂在 `MemoryStore.record_execution_event` 上的收口函数：那里是全部工具执行
    事件的唯一汇聚点（UI、workflow、headless 都经过它），在这里挂一次就全覆盖，
    不必去每个 adapter 里插桩。

    刻意不做的两件事：不改事件本身、不推断根因——只把工具名/参数/错误/退出码搬过来。
    """
    try:
        if not isinstance(event, dict):
            return False

        tool_name = str(event.get('tool_name') or '').strip()
        if not tool_name or tool_name == 'unknown':
            return False

        params = event.get('parameters_summary') or {}
        args = params.get('args')
        if not isinstance(args, (list, tuple)) or not args:
            command = params.get('command') or params.get('command_line')
            args = [command] if command else []

        error_output = event.get('error_summary') or event.get('result_summary') or ''
        exit_code = event.get('exit_code')
        if exit_code is None:
            event_type = event.get('event_type')
            if event_type == 'tool_failed':
                exit_code = 1
            elif event.get('event_type') == 'tool_cancelled':
                return False  # 用户主动取消不算踩坑
            elif event.get('result') == 'succeeded':
                exit_code = 0
            else:
                return False  # 结果未知，不臆测成失败

        return record_tool_friction(
            tool_name, args, error_output, exit_code,
            event.get('duration_ms'),
            event.get('workspace') or params.get('cwd'),
            project=project,
            event_id=event.get('event_id'),
        )
    except Exception:
        return False
