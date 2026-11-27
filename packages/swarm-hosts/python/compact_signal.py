"""宿主压缩信号解析：只认宿主自己发出的压缩事件，不靠 token 回落猜。

依据（2026-11-20 对安装版宿主可执行的只读核验）：
- CodeBuddy 1.4.4 在 ACP `session/update` 上广播压缩生命周期，判别键是 `_meta` 的
  `codebuddy.ai/isCompactInternal`，`messageId` 形如 `compact-maxtoken-<会话>-<时间戳>`，
  正文是 `<conversation_history_summary><summary>…`。开始时只有半个标签，完成时才闭合。
- 压缩类型写在 `codebuddy.ai/compactType`，取值 `auto` / `manual`。用户手敲 `/compact`
  是 manual，不能算成容量压力。
- 取消、触顶走 `session_info_update`，分别带 `codebuddy.ai/compact-cancelled` 与
  `codebuddy.ai/compact-limit-reached`。
- Antigravity 1.5.13 只上报 `usage_update`，没有压缩广播；那里只能估算，见调用方。

历史重放（session/load 回放旧摘要）会再次出现闭合的压缩正文，因此必须带 `path` 标记，
由上层按 `replay` 丢弃，绝不能把回放当成新的一次压缩。
"""

COMPACT_INTERNAL_KEY = 'codebuddy.ai/isCompactInternal'
COMPACT_TYPE_KEY = 'codebuddy.ai/compactType'
COMPACT_CANCELLED_KEY = 'codebuddy.ai/compact-cancelled'
COMPACT_LIMIT_REACHED_KEY = 'codebuddy.ai/compact-limit-reached'
SUMMARY_OPEN = '<conversation_history_summary>'
SUMMARY_CLOSE = '</conversation_history_summary>'
MESSAGE_PREFIX = 'compact-maxtoken-'


def _meta(update):
    meta = update.get('_meta')
    return meta if isinstance(meta, dict) else {}


def _text(update):
    """取正文：CodeBuddy 用列表包 content，其他宿主可能是字符串。"""
    content = update.get('content')
    if isinstance(content, list):
        return ''.join(
            part.get('text', '') for part in content
            if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str)
        )
    if isinstance(content, dict):
        text = content.get('text')
        return text if isinstance(text, str) else ''
    return ''


def _compact_type(meta):
    value = meta.get(COMPACT_TYPE_KEY)
    return value if isinstance(value, str) else ''


def acp_compact(update, host, replaying=False):
    """返回压缩信号；不是压缩事件时返回 None。

    replaying=True 表示当前帧来自历史回放（会话恢复），只做标记，不计入次数。
    """
    if not isinstance(update, dict):
        return None
    kind = update.get('sessionUpdate')
    meta = _meta(update)
    path = 'replay' if replaying else 'live'

    if kind == 'agent_message_chunk' and meta.get(COMPACT_INTERNAL_KEY) is True:
        message_id = update.get('messageId')
        if not isinstance(message_id, str) or not message_id.startswith(MESSAGE_PREFIX):
            return None
        text = _text(update)
        if SUMMARY_CLOSE in text:
            phase = 'done'
        elif SUMMARY_OPEN in text or not text:
            phase = 'start'
        else:
            return None
        return {
            'source': 'ACP compact signal',
            'host': host,
            'path': path,
            'phase': phase,
            'message_id': message_id,
            'compact_type': _compact_type(meta),
            'confirmed': True,
        }

    if kind == 'session_info_update':
        if COMPACT_CANCELLED_KEY in meta:
            return {
                'source': 'ACP compact signal',
                'host': host,
                'path': path,
                'phase': 'cancelled',
                'message_id': '',
                'compact_type': _compact_type(meta),
                'confirmed': True,
            }
        if COMPACT_LIMIT_REACHED_KEY in meta:
            # 宿主自报“压不动了”，是真实容量告警，不是估算。
            return {
                'source': 'ACP compact signal',
                'host': host,
                'path': path,
                'phase': 'limit',
                'message_id': '',
                'compact_type': _compact_type(meta),
                'confirmed': True,
            }
    return None


def compact_estimate(usage, budget_hint=0):
    """没有压缩事件的宿主只能估算：占用接近宿主预算时给出口径与依据。

    budget_hint 必须来自宿主自身配置（如 AGY_CLI_AUTO_COMPACT_OVERRIDE 或 maxContextTokens），
    拿不到就用宿主上报的 size，并在载荷里写明估算依据。
    """
    used = usage.get('context_used')
    size = usage.get('context_size')
    budget = budget_hint if isinstance(budget_hint, int) and budget_hint > 0 else (size if isinstance(size, int) else 0)
    if not isinstance(used, int) or not isinstance(budget, int) or budget <= 0:
        return None
    return {
        'source': 'usage estimate',
        'path': 'estimate',
        'confirmed': False,
        'context_used': used,
        'budget': budget,
        'ratio': round(used / budget, 4),
        'basis': 'host auto-compact budget' if budget_hint else 'host reported context size',
    }


def iso_utc():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def codex_compaction_records(thread_id, since_iso='', root=None, tail_bytes=48 * 1024 * 1024, *, emit_usage=False):
    """从 Codex 自己的 rollout 记录里读压缩：`{"type":"compacted"}` 是宿主写下的真事件。

    依据（2026-11-20 实测本机会话）：`~/.codex/sessions/…/rollout-<时间>-<thread_id>.jsonl`
    里存在 `type=compacted`、带 `replacement_history` 的记录；CLI 0.167 的事件枚举里也有
    `ContextCompacted`/`context_compacted`。这里只读宿主已落盘的记录，不起模型、不耗额度。

    since_iso 传本次回合开始时间：早于它的压缩算历史（replay），不计新的一次。
    """
    if not thread_id:
        return []
    from pathlib import Path
    import json

    import os
    codex_home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    base = Path(root) if root else codex_home / 'sessions'
    if not base.is_dir():
        return []
    try:
        found = sorted(base.rglob('rollout-*-%s.jsonl' % str(thread_id)), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []
    if not found:
        return []

    path = found[0]
    try:
        size = path.stat().st_size
        with path.open('rb') as handle:
            if size > tail_bytes:
                handle.seek(size - tail_bytes)
            raw = handle.read()
    except OSError:
        return []

    records = []
    sample = None
    latest = None
    for line in raw.decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue  # 截断的尾巴不算记录
        try:
            record = json.loads(line)
        except Exception:
            continue
        stamp = str(record.get('timestamp') or '')
        live = bool(since_iso and stamp) and stamp.rstrip('Z').ljust(27, '0') >= since_iso.rstrip('Z').ljust(27, '0')
        payload = record.get('payload') or {}
        if record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            usage = info.get('last_token_usage') or {}
            used, size = usage.get('total_tokens'), info.get('model_context_window')
            if type(used) is int and type(size) is int and used > 0 and size > 0:
                sample = (used, size)
                if live:
                    latest = sample
            continue
        if record.get('type') != 'compacted':
            continue
        ordinal = record.get('ordinal')
        event_key = ordinal if ordinal is not None else stamp
        if not event_key and ordinal is None:
            continue
        records.append({
            'source': 'Codex rollout compacted',
            'host': 'GPT / Codex',
            'path': 'live' if live else 'replay',
            'phase': 'done',
            'message_id': 'codex-compact:%s:%s' % (thread_id, event_key),
            'compact_type': '',
            'confirmed': True,
            **({'baseline_used': sample[0], 'baseline_size': sample[1]} if sample else {}),
            'invalidate_usage': True,
        })
        sample = None
        latest = None
    if emit_usage and latest:
        records.append({'source': 'Codex rollout token_count last_token_usage',
                        'context_used': latest[0], 'context_size': latest[1]})
    return records


def qoder_compaction_records(session_id, since_iso='', root=None, tail_bytes=24 * 1024 * 1024):
    """Qoder 自己的转录里，压缩是 `{"type":"system","subtype":"compact_boundary"}`。

    依据（2026-11-20 实测）：`~/.qoder/projects/<项目>/<sessionId>.jsonl` 的交互会话里，
    每次压缩落一条 compact_boundary，紧跟一条 isCompactSummary:true 的 user 记录。
    注意：Qoder 以 `--acp` 运行时只写 352 B 的会话头（sessionId + runtime-config），
    不落转录，所以这条路径对蜂群现用的 ACP 会话通常返回空——空即回落估算，不谎报。
    """
    if not session_id:
        return []
    from pathlib import Path
    import json

    base = Path(root) if root else Path.home() / '.qoder' / 'projects'
    if not base.is_dir():
        return []
    try:
        found = sorted(base.rglob('%s.jsonl' % str(session_id)), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []
    if not found:
        return []

    path = found[0]
    try:
        size = path.stat().st_size
        with path.open('rb') as handle:
            if size > tail_bytes:
                handle.seek(size - tail_bytes)
            raw = handle.read()
    except OSError:
        return []

    records = []
    for line in raw.decode('utf-8', 'replace').splitlines():
        if 'compact_boundary' not in line:
            continue
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if record.get('subtype') != 'compact_boundary':
            continue
        stamp = str(record.get('timestamp') or '')
        live = bool(since_iso) and stamp >= since_iso
        records.append({
            'source': 'Qoder transcript compact_boundary',
            'host': 'Qoder CLI',
            'path': 'live' if live else 'replay',
            'phase': 'done',
            'message_id': 'qoder-compact:%s:%s' % (session_id, record.get('uuid')),
            'compact_type': '',
            'confirmed': True,
        })
    return records
