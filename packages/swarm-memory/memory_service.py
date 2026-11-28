"""常驻本机记忆服务：一个 SQLite 主库、一份已加载的向量模型、一条回环 HTTP 入口。

为什么必须常驻（不是"顺手优化"）：
- 旧实现每次查询都 `python swarm_memory_bridge.py context` 起一个新进程，进程内在
  `MemoryStore.__init__` 里加载 BGE/ONNX。单进程峰值工作集约 218MiB，单次查询 1.37 秒，
  三个客户端并发就是三份模型。全机共用一份记忆的前提是"共用一份推理资源"。
- 常驻后：服务进程持有 MemoryStore 连接池和唯一一份模型；stdio 客户端起自己的轻量桥，
  桥只转发、不碰数据库路径、不加载模型、也不能另选库。

安全边界（写作时必须的，不是可选项）：
- 只绑回环地址；只接受回环来源连接。
- 校验 `Host`（挡 DNS rebinding：浏览器把 evil.com 解析到 127.0.0.1 时 Host 仍是 evil.com）。
- 校验 `Origin`：命令行/MCP 客户端不带 Origin；带了的必须是本机同端口页面，其余拒绝。
  这样普通网页无法借浏览器读本机记忆。
- 本机调用鉴别：启动时生成一次性 token 写到数据目录，客户端从文件读取。桥自动读，
  所以客户端配置里不需要出现 token。

数据位置：`%LOCALAPPDATA%/SwarmMemory/memory.sqlite3`（可用 SWARM_MEMORY_DIR /
SWARM_MEMORY_DB 覆盖）。刻意不放在安装目录、源码仓或临时目录——那些位置会被清理、
被重新解包或被 git 覆盖，放进去就等于把唯一一份记忆赌在"没人删它"上。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import settings
from memory_store import MemoryStore, SHARED_PROJECT
from session_capture import collect_sessions

SERVICE_VERSION = '1.1.0'
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 8781
DEFAULT_POOL_SIZE = 3
ENDPOINT_ENV = 'SWARM_MEMORY_ENDPOINT'
DIR_ENV = 'SWARM_MEMORY_DIR'
DB_ENV = 'SWARM_MEMORY_DB'
PORT_ENV = 'SWARM_MEMORY_PORT'
PROJECT_AUTO = 'auto'

_LOG_LOCK = threading.Lock()


# ---------------------------------------------------------------- 位置与身份

def data_dir() -> Path:
    """服务自己的数据目录（库、token、日志、运行态）。"""
    explicit = (os.environ.get(DIR_ENV) or '').strip()
    if explicit:
        folder = Path(explicit).expanduser()
    else:
        local = (os.environ.get('LOCALAPPDATA') or '').strip() or (os.environ.get('XDG_DATA_HOME') or '').strip()
        folder = (Path(local) / 'SwarmMemory') if local else (Path.home() / '.swarm-memory')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def database_path() -> Path:
    explicit = (os.environ.get(DB_ENV) or '').strip()
    return Path(explicit).expanduser() if explicit else data_dir() / 'memory.sqlite3'


def token_path() -> Path:
    return data_dir() / 'service.token'


def state_path() -> Path:
    return data_dir() / 'service.json'


def log_path() -> Path:
    return data_dir() / 'service.log'


def start_lock_path() -> Path:
    return data_dir() / 'start.lock'


def port_number() -> int:
    raw = (os.environ.get(PORT_ENV) or '').strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    state = _read_state()
    if isinstance(state.get('port'), int) and state['port'] > 0:
        return state['port']
    return DEFAULT_PORT


def endpoint(port: int | None = None) -> str:
    explicit = (os.environ.get(ENDPOINT_ENV) or '').strip().rstrip('/')
    if explicit:
        return explicit
    return f'http://{DEFAULT_HOST}:{port or port_number()}'


def _read_state() -> dict[str, Any]:
    try:
        data = json.loads(state_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_state(payload: dict[str, Any]) -> None:
    path = state_path()
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def read_token() -> str:
    explicit = (os.environ.get('SWARM_MEMORY_TOKEN') or '').strip()
    if explicit:
        return explicit
    try:
        return token_path().read_text(encoding='utf-8').strip()
    except OSError:
        return ''


def _ensure_token() -> str:
    token = read_token()
    if token:
        return token
    token = secrets.token_urlsafe(32)
    path = token_path()
    path.write_text(token + '\n', encoding='utf-8')
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [pid {os.getpid()}] {message}"
    with _LOG_LOCK:
        try:
            with open(log_path(), 'a', encoding='utf-8') as handle:
                handle.write(line + '\n')
        except OSError:
            pass


# ---------------------------------------------------------------- 项目作用域

def workspace_dir(workspace: str) -> Path:
    text = str(workspace or '').strip()
    path = Path(text).expanduser()
    if not text or not path.is_absolute() or not path.is_dir():
        raise ValueError('workspace 必须是已存在的绝对路径目录')
    return path


def binding_file(workspace: str) -> Path:
    return workspace_dir(workspace) / '.swarm' / 'projects.json'


def read_binding(workspace: str) -> str | None:
    try:
        data = json.loads(binding_file(workspace).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    project = str((data or {}).get('project') or '').strip()
    return project or None


def unbound_scope(workspace: str) -> str:
    """未绑定工作区的只读作用域：不落任何数据，也不会和别的未绑定工作区串味。"""
    digest = hashlib.sha256(str(workspace_dir(workspace)).casefold().encode('utf-8')).hexdigest()[:16]
    return 'unbound:' + digest


def resolve_scope(workspace: str, project: str | None) -> tuple[str, bool]:
    """返回（查询用作用域，是否已绑定真实项目身份）。"""
    text = str(project or '').strip()
    if text and text.lower() != PROJECT_AUTO:
        return text, True
    bound = read_binding(workspace)
    if bound:
        return bound, True
    return unbound_scope(workspace), False


def resolve_read_scope(workspace: str | None, project: str | None) -> tuple[str, bool]:
    if workspace is None:
        name = str(project or '').strip()
        if name.casefold() in ('', PROJECT_AUTO):
            return SHARED_PROJECT, True
        registry = Path(os.environ.get('SWARM_PROJECT_REGISTRY') or data_dir() / 'projects.json')
        try:
            projects = json.loads(registry.read_text(encoding='utf-8-sig')).get('projects', [])
        except (OSError, ValueError):
            projects = []
        matches = {
            item['project_id'] for item in projects if item.get('project_id')
            and any(isinstance(alias, str) and alias.casefold() == name.casefold()
                    for alias in (item.get('name'), item['project_id'], *(item.get('aliases') or [])))
        }
        if len(matches) > 1:
            raise ValueError('项目名称对应多个项目，请传稳定项目 ID')
        return next(iter(matches), name), True
    if workspace is not None:
        workspace_dir(workspace)
    return resolve_scope(workspace, project)


def validate_source_limit(value: int) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError('source_limit 必须是整数') from error
    if not 1 <= limit <= 100:
        raise ValueError('source_limit 必须在 1..100 之间')
    return limit


UNBOUND_NOTICE = (
    '该项目工作区尚未绑定项目身份，本次只提供全机共享记忆；'
    '确认项目后执行 `swarm_memory_bridge.py bind --workspace <dir> --project <id>`。'
)


# ---------------------------------------------------------------- 服务内核

class MemoryService:
    """单库、单模型的记忆服务内核；HTTP 层只负责协议和安全，业务都在这里。"""

    def __init__(self, db_path: str | Path | None = None, pool_size: int = DEFAULT_POOL_SIZE):
        self.db_path = Path(db_path).expanduser() if db_path else database_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.pool_size = max(1, int(pool_size))
        self.started = time.time()
        self._pool_lock = threading.Lock()
        self._pool: list[MemoryStore] = [MemoryStore(str(self.db_path))]
        self._rr = 0
        self.stats = {'calls': 0, 'errors': 0, 'last_ms': 0, 'max_ms': 0}
        self._stats_lock = threading.Lock()
        self._session_capture_lock = threading.Lock()

    # -- 连接池：读请求轮转，写请求固定在主连接上；所有连接共享同一份模型单例
    def _store(self) -> MemoryStore:
        with self._pool_lock:
            if self.pool_size == 1:
                return self._pool[0]
            if len(self._pool) < self.pool_size:
                # 额外连接跳过索引同步：schema 与索引由首个连接（也是写连接）维护，
                # 这里只为并发查询开一条独立的 SQLite 连接（WAL 支持多读者）。
                self._pool.append(MemoryStore(str(self.db_path), sync_index=False))
            self._rr = (self._rr + 1) % len(self._pool)
            return self._pool[self._rr]

    def _writer(self) -> MemoryStore:
        return self._pool[0]

    @property
    def model(self) -> dict[str, Any]:
        service = self._pool[0].embedding_service
        available = bool(service and service.is_available())
        return {'available': available, 'dir': str(getattr(service, 'model_dir', '') or '')}

    def _timed(self, name: str, action):
        begin = time.perf_counter()
        try:
            result = action()
        except Exception:
            with self._stats_lock:
                self.stats['calls'] += 1
                self.stats['errors'] += 1
            raise
        elapsed = (time.perf_counter() - begin) * 1000.0
        with self._stats_lock:
            self.stats['calls'] += 1
            self.stats['last_ms'] = int(elapsed)
            self.stats['max_ms'] = max(self.stats['max_ms'], int(elapsed))
        log(f'{name} {int(elapsed)}ms')
        return result

    def health(self) -> dict[str, Any]:
        return {
            'ok': True,
            'version': SERVICE_VERSION,
            'pid': os.getpid(),
            'db': str(self.db_path),
            'started': self.started,
            'uptime_s': round(time.time() - self.started, 1),
            'model': self.model,
            'pool_size': self.pool_size,
            'stats': dict(self.stats),
        }

    # -- 查询
    def context(self, workspace: str | None = None, project: str = PROJECT_AUTO, query: str = '',
                task_id: str | None = None, budget: int = 6000, source_limit: int = 12,
                retrieval: dict[str, int] | None = None) -> dict[str, Any]:
        limit = validate_source_limit(source_limit)
        scope, bound = resolve_read_scope(workspace, project)
        store = self._store()

        def action():
            packet = store.packet(
                scope,
                query=query or '',
                task_id=task_id,
                budget=budget,
                dialogue=False,
                source_limit=limit,
                retrieval=retrieval,
                notice=None if bound else UNBOUND_NOTICE,
            )
            # 检索计数由 packet 就地写进传入的 dict；桥/CLI 侧依赖这个回执核对
            # "关键词命中几条、向量命中几条"，不能只留在服务进程里。
            if retrieval is not None:
                packet['retrieval'] = retrieval
            return packet
        return self._timed('context', action)

    def read_source(self, workspace: str | None = None, source_id: str = '', project: str = PROJECT_AUTO,
                    offset: int = 0, max_chars: int = 4000) -> dict[str, Any]:
        scope, _ = resolve_read_scope(workspace, project)
        return self._store().source_page(scope, source_id, offset, max_chars)

    def sync_sessions(self, workspace: str | None = None, project: str = PROJECT_AUTO, days: int = 7,
                      limit: int = 12, collect: bool = True, reviewed_through: int | None = None) -> dict[str, Any]:
        scope, bound = resolve_read_scope(workspace, project)
        if not bound or scope == SHARED_PROJECT:
            raise ValueError('请传登记项目名或已绑定工作区，会话按项目收录')
        if type(days) is not int or not 1 <= days <= 90:
            raise ValueError('days 必须是 1..90 的整数')
        if type(limit) is not int or not 1 <= limit <= 40:
            raise ValueError('limit 必须是 1..40 的整数')
        if reviewed_through is not None and (type(reviewed_through) is not int or reviewed_through < 1):
            raise ValueError('reviewed_through 必须是返回的整理游标')
        if type(collect) is not bool:
            raise ValueError('collect 必须为布尔值')

        def action():
            store = self._writer()
            bindings = {}

            def project_for(cwd):
                if cwd not in bindings:
                    root = Path(cwd)
                    bindings[cwd] = None
                    if root.is_absolute() and root.is_dir():
                        root = root.resolve()
                        for folder in (root, *root.parents):
                            if bound_project := read_binding(str(folder)):
                                bindings[cwd] = bound_project
                                break
                return bindings[cwd]

            with self._session_capture_lock:
                added, errors = collect_sessions(store, scope, project_for, days) if collect else (0, [])
                result = store.pending_session_sources(scope, limit, reviewed_through)
            return dict(result, project=scope, added=added, errors=errors)

        return self._timed('session_capture', action)

    # -- 提议（草稿，不直接生效）
    def propose(self, workspace: str, project: str, proposals: list[dict[str, Any]],
                query: str = '', task_id: str | None = None, source_limit: int = 12,
                organizer: str = 'CodeBuddy / MCP') -> dict[str, Any]:
        scope, bound = resolve_scope(workspace, project)
        if not bound:
            raise ValueError('该项目工作区尚未绑定项目身份，不能提交记忆草稿')
        limit = validate_source_limit(source_limit)
        if not isinstance(proposals, list) or not 1 <= len(proposals) <= 16:
            raise ValueError('proposals 必须是 1..16 项的对象数组')
        if any(not isinstance(item, dict) for item in proposals):
            raise ValueError('proposals 中每一项都必须是对象')
        if not isinstance(organizer, str) or not organizer.strip():
            raise ValueError('organizer 不能为空')

        def action():
            store = self._writer()
            packet = store.packet(scope, query=query or '', task_id=task_id, budget=10000,
                                  dialogue=False, source_limit=limit)
            session_refs = store.external_session_refs(scope, (
                sid for proposal in proposals if isinstance(proposal.get('source_ids'), list)
                for sid in proposal['source_ids']
            ))
            errors: list[dict[str, Any]] = []
            draft_ids = store.stage(scope, json.dumps({'proposals': proposals}, ensure_ascii=False),
                                    organizer.strip(), set(packet['source_ids']) | session_refs, packet['entries'],
                                    errors=errors)
            return {'draft_ids': draft_ids, 'errors': errors}
        return self._timed('propose', action)

    # -- 已授权的直接写入（人工确认过的事实/纠错/复盘；不走草稿）
    def remember(self, workspace: str, project: str, title: str, body: str,
                 kind: str = 'lesson', task_id: str | None = None) -> dict[str, Any]:
        scope, bound = resolve_scope(workspace, project)
        if not bound:
            raise ValueError('该项目工作区尚未绑定项目身份，不能写入记忆')
        if not isinstance(title, str) or not title.strip():
            raise ValueError('title 不能为空')
        if not isinstance(body, str) or not body.strip():
            raise ValueError('body 不能为空')

        def action():
            store = self._writer()
            entry_id = store.manual(scope, title.strip(), body.strip(), kind=kind, task_id=task_id)
            return {'entry_id': entry_id, 'project': scope}
        return self._timed('remember', action)

    def reindex(self, project: str | None = None, force: bool = False) -> dict[str, Any]:
        if project is not None and not isinstance(project, str):
            raise ValueError('project 必须是项目 ID')
        if type(force) is not bool:
            raise ValueError('force 必须为布尔值')
        def action():
            store = self._writer()
            return store.reindex(project=project, force=force)
        return self._timed('reindex', action)

    def close(self) -> None:
        with self._pool_lock:
            for store in self._pool:
                try:
                    store.close()
                except Exception:
                    pass
            self._pool = []


# ---------------------------------------------------------------- HTTP 层

class _Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = f'SwarmMemoryService/{SERVICE_VERSION}'

    # -- 基础设施
    def log_message(self, format: str, *args) -> None:  # noqa: A002 - 标准库签名
        log('http ' + format % args)

    def _send(self, status: int, payload: Any, content_type: str = 'application/json') -> None:
        raw = b'' if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type if raw else 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def _read_json(self) -> Any:
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return None
        if length > 4 * 1024 * 1024:
            raise ValueError('请求体过大')
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as error:
            raise ValueError('请求体不是合法 JSON') from error

    def _guard(self) -> str | None:
        peer = self.client_address[0] if self.client_address else ''
        if peer not in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            return '仅接受本机回环连接'
        host = (self.headers.get('Host') or '').strip().lower()
        if host not in self.server.allowed_hosts:
            return 'Host 头不可信'
        origin = (self.headers.get('Origin') or '').strip().lower()
        if origin and origin not in self.server.allowed_origins:
            return 'Origin 不可信'
        return None

    def _authorized(self) -> bool:
        token = (self.headers.get('X-Swarm-Token') or '').strip()
        if not token:
            header = (self.headers.get('Authorization') or '').strip()
            if header.lower().startswith('bearer '):
                token = header[7:].strip()
        return bool(self.server.token) and secrets.compare_digest(token, self.server.token)

    # -- 路由
    def do_GET(self) -> None:  # noqa: N802 - 标准库命名
        path = urllib.parse.urlparse(self.path).path
        problem = self._guard()
        if problem:
            return self._send(403, {'ok': False, 'error': problem})
        if path == '/health':
            payload = {'ok': True, 'version': SERVICE_VERSION}
            if self._authorized():
                payload = self.server.service.health()
            return self._send(200, payload)
        if path == '/mcp':
            # 本服务不提供 SSE 流，按 MCP 规范如实回 405，让客户端改走 POST。
            return self._send(405, {'ok': False, 'error': '该端点只接受 POST（无 SSE 流）'})
        return self._send(404, {'ok': False, 'error': '未知路径'})

    def do_POST(self) -> None:  # noqa: N802 - 标准库命名
        path = urllib.parse.urlparse(self.path).path
        problem = self._guard()
        if problem:
            return self._send(403, {'ok': False, 'error': problem})
        if not self._authorized():
            return self._send(401, {'ok': False, 'error': '缺少或错误的本机服务 token'})
        try:
            body = self._read_json()
        except ValueError as error:
            return self._send(400, {'ok': False, 'error': str(error)})
        if path == '/mcp':
            return self._handle_mcp(body)
        if path == '/call':
            return self._handle_call(body)
        if path == '/shutdown':
            self._send(200, {'ok': True, 'stopping': os.getpid()})
            threading.Thread(target=self.server.request_stop, daemon=True).start()
            return None
        return self._send(404, {'ok': False, 'error': '未知路径'})

    # -- 业务路由
    def _handle_call(self, body: Any) -> None:
        if not isinstance(body, dict):
            return self._send(400, {'ok': False, 'error': '请求体必须是对象'})
        name = body.get('tool')
        arguments = body.get('arguments') or {}
        if not isinstance(arguments, dict):
            return self._send(400, {'ok': False, 'error': 'arguments 必须是对象'})
        try:
            result = (self.server.service.reindex(**arguments) if name == 'reindex'
                      else self.server.dispatch(str(name), arguments))
        except Exception as error:
            return self._send(200, {'ok': False, 'error': str(error)})
        return self._send(200, {'ok': True, 'result': result})

    def _handle_mcp(self, message: Any) -> None:
        if isinstance(message, list):
            return self._send(400, {'jsonrpc': '2.0', 'id': None,
                                    'error': {'code': -32600, 'message': '暂不支持 JSON-RPC 批请求'}})
        if not isinstance(message, dict):
            return self._send(400, {'jsonrpc': '2.0', 'id': None,
                                    'error': {'code': -32600, 'message': 'Invalid Request'}})
        method = message.get('method')
        request_id = message.get('id')
        if method is None or (isinstance(method, str) and method.startswith('notifications/')):
            # 通知没有响应体；HTTP 上按规范回 202。
            return self._send(202, None)
        params = message.get('params') or {}
        if not isinstance(params, dict):
            return self._send(400, {'jsonrpc': '2.0', 'id': request_id,
                                    'error': {'code': -32602, 'message': 'Invalid params'}})
        if method == 'initialize':
            requested = params.get('protocolVersion')
            return self._send(200, {
                'jsonrpc': '2.0', 'id': request_id,
                'result': {
                    'protocolVersion': requested if isinstance(requested, str) and requested else '2025-06-18',
                    'capabilities': {'tools': {'listChanged': False}},
                    'serverInfo': {'name': 'swarm-memory', 'version': SERVICE_VERSION},
                },
            })
        if method == 'ping':
            return self._send(200, {'jsonrpc': '2.0', 'id': request_id, 'result': {}})
        if method == 'tools/list':
            from swarm_memory_bridge import TOOL_DEFINITIONS
            return self._send(200, {'jsonrpc': '2.0', 'id': request_id,
                                    'result': {'tools': [tool.to_dict() for tool in TOOL_DEFINITIONS]}})
        if method == 'tools/call':
            name = params.get('name')
            arguments = params.get('arguments') or {}
            try:
                result = self.server.dispatch(str(name), arguments if isinstance(arguments, dict) else {})
                text = json.dumps(result, ensure_ascii=False)
                return self._send(200, {'jsonrpc': '2.0', 'id': request_id,
                                        'result': {'content': [{'type': 'text', 'text': text}],
                                                   'isError': False}})
            except Exception as error:  # 工具错误是 MCP 结果，不是协议错误
                return self._send(200, {'jsonrpc': '2.0', 'id': request_id,
                                        'result': {'content': [{'type': 'text', 'text': str(error)}],
                                                   'isError': True}})
        return self._send(200, {'jsonrpc': '2.0', 'id': request_id,
                                'error': {'code': -32601, 'message': f'Method not found: {method}'}})


class MemoryHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 会允许第二个进程**抢**同一个端口（不是"复用 TIME_WAIT"），
    # 结果是两个服务同时"启动成功"、请求随机落到其中一个，state 文件被后来者覆盖。
    # 这里必须关掉，让第二次绑定老老实实报 EADDRINUSE。
    allow_reuse_address = os.name != 'nt'
    request_queue_size = 64

    def __init__(self, address, service: MemoryService, token: str):
        super().__init__(address, _Handler)
        self.service = service
        self.token = token
        self._stop_lock = threading.Lock()
        self._stopping = False
        port = self.server_address[1]
        self.allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
        self.allowed_origins = {f'http://127.0.0.1:{port}', f'http://localhost:{port}'}

    def dispatch(self, name: str, arguments: dict[str, Any]) -> Any:
        if name == 'get_project_context':
            return self.service.context(**arguments)
        if name == 'read_memory_source':
            return self.service.read_source(**arguments)
        if name == 'sync_agent_sessions':
            return self.service.sync_sessions(**arguments)
        if name == 'propose_project_memory':
            return self.service.propose(**arguments)
        if name == 'remember_project_memory':
            return self.service.remember(**arguments)
        raise ValueError(f'未知工具：{name}')

    def request_stop(self) -> None:
        with self._stop_lock:
            if self._stopping:
                return
            self._stopping = True
        log('收到停止请求')
        threading.Thread(target=self.shutdown, daemon=True).start()


def serve(port: int | None = None, db_path: str | None = None, pool_size: int = DEFAULT_POOL_SIZE) -> int:
    """前台运行（正常由 start 或开机任务拉起）。

    端口已被一个健康实例占用时不算失败：开机任务和手动 start 可能同时拉起，直接以 0 退出，
    免得任务计划把一个"其实一切正常"的启动记成失败并反复重试。
    """
    address = endpoint(port)
    if health(address, timeout=1.0):
        log(f'已有实例在 {address} 正常服务，本进程不再加载模型，直接退出')
        print(json.dumps({'ok': True, 'already_running': address}, ensure_ascii=False))
        return 0
    service = MemoryService(db_path=db_path, pool_size=pool_size)
    token = _ensure_token()
    try:
        httpd = MemoryHttpServer((DEFAULT_HOST, port or port_number()), service, token)
    except OSError as error:
        service.close()
        if health(address):
            log(f'已有实例在 {address} 正常服务，本进程退出（{error}）')
            print(json.dumps({'ok': True, 'already_running': address}, ensure_ascii=False))
            return 0
        log(f'绑定 {address} 失败且无健康实例：{error}')
        raise
    state = {
        'endpoint': f'http://{DEFAULT_HOST}:{httpd.server_address[1]}',
        'port': httpd.server_address[1],
        'pid': os.getpid(),
        'db': str(service.db_path),
        'version': SERVICE_VERSION,
        'started': service.started,
        'token_file': str(token_path()),
    }
    _write_state(state)
    log(f"服务启动 {state['endpoint']} db={service.db_path} model={service.model}")
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        service.close()
        current = _read_state()
        if current.get('pid') == os.getpid():
            try:
                state_path().unlink()
            except OSError:
                pass
        log('服务停止')
    return 0


# ---------------------------------------------------------------- 客户端

class ServiceUnavailable(RuntimeError):
    """服务不可用：调用方必须如实报出，不能静默当成"没有记忆"。"""


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url: str, payload: Any = None, token: str = '', timeout: float = 15.0) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(url, data=data, method='GET' if data is None else 'POST')
    request.add_header('Content-Type', 'application/json')
    request.add_header('Accept', 'application/json')
    if token:
        request.add_header('X-Swarm-Token', token)
    with _OPENER.open(request, timeout=timeout) as response:
        raw = response.read().decode('utf-8')
    return json.loads(raw) if raw.strip() else {}


def health(target: str | None = None, timeout: float = 2.0) -> dict[str, Any] | None:
    try:
        payload = http_json((target or endpoint()).rstrip('/') + '/health', timeout=timeout)
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) and payload.get('ok') else None


def call_tool(name: str, arguments: dict[str, Any], target: str | None = None,
              timeout: float = 60.0) -> Any:
    url = (target or endpoint()).rstrip('/') + '/call'
    try:
        payload = http_json(url, {'tool': name, 'arguments': arguments}, token=read_token(), timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = ''
        try:
            detail = json.loads(error.read().decode('utf-8')).get('error', '')
        except (OSError, ValueError):
            pass
        raise ServiceUnavailable(f'记忆服务拒绝请求 HTTP {error.code}：{detail or error.reason}') from error
    except (urllib.error.URLError, OSError) as error:
        raise ServiceUnavailable(f'记忆服务不可用：{error}') from error
    except ValueError as error:
        raise ServiceUnavailable(f'记忆服务返回非法 JSON：{error}') from error
    if not isinstance(payload, dict) or not payload.get('ok'):
        raise ServiceUnavailable(str((payload or {}).get('error') or '记忆服务返回未知错误'))
    return payload.get('result')


def _acquire_start_lock() -> bool:
    """单飞启动锁：并发客户端同时发现服务没起来时，只能有一个去拉起进程。"""
    path = start_lock_path()
    try:
        if path.exists() and time.time() - path.stat().st_mtime > 180:
            path.unlink()
    except OSError:
        pass
    try:
        handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(handle, str(os.getpid()).encode('ascii'))
    os.close(handle)
    return True


def _release_start_lock() -> None:
    try:
        start_lock_path().unlink()
    except OSError:
        pass


def _service_python() -> str:
    """挑一个真的能加载向量的解释器：显式指定 > 本仓 .venv > 当前解释器。"""
    explicit = (os.environ.get('SWARM_PYTHON') or '').strip()
    if explicit:
        return explicit
    candidate = settings.ROOT / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if candidate.is_file():
        return str(candidate)
    return sys.executable


def _spawn(port: int) -> None:
    import subprocess

    command = [_service_python(), '-B', str(Path(__file__).resolve()), 'serve', '--port', str(port)]
    environment = dict(os.environ)
    environment['PYTHONIOENCODING'] = 'utf-8'
    environment['PYTHONUTF8'] = '1'
    environment.pop('PYTHONHOME', None)
    flags = 0
    if os.name == 'nt':
        # Windows ignores CREATE_NO_WINDOW when DETACHED_PROCESS is also set.
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    logfile = open(log_path(), 'a', encoding='utf-8')
    try:
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=logfile, stderr=logfile,
                         close_fds=True, env=environment, creationflags=flags, cwd=str(settings.ROOT))
    finally:
        logfile.close()


def ensure_running(target: str | None = None, timeout: float = 45.0) -> str:
    """确保服务在线；不在线就单飞拉起一个（全机只会有一个带模型的进程）。"""
    address = (target or endpoint()).rstrip('/')
    if health(address):
        return address
    if (os.environ.get('SWARM_MEMORY_DISABLE_AUTOSTART') or '').strip() in ('1', 'true', 'yes'):
        raise ServiceUnavailable(f'记忆服务未运行且已禁用自动启动：{address}')
    if _acquire_start_lock():
        try:
            if health(address):
                return address
            _spawn(int(urllib.parse.urlparse(address).port or DEFAULT_PORT))
            deadline = time.time() + timeout
            while time.time() < deadline:
                if health(address):
                    return address
                time.sleep(0.2)
            raise ServiceUnavailable(f'记忆服务启动超时（{timeout:.0f}s），日志见 {log_path()}')
        finally:
            _release_start_lock()
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.2)
        if health(address):
            return address
    raise ServiceUnavailable(f'记忆服务正由其他进程启动，等待超时；日志见 {log_path()}')


def stop_service(target: str | None = None) -> dict[str, Any]:
    address = (target or endpoint()).rstrip('/')
    state = _read_state()
    try:
        http_json(address + '/shutdown', {}, token=read_token(), timeout=5.0)
    except (urllib.error.URLError, OSError, ValueError):
        pass
    deadline = time.time() + 10
    while time.time() < deadline:
        if not health(address):
            return {'ok': True, 'stopped': True, 'pid': state.get('pid')}
        time.sleep(0.2)
    return {'ok': False, 'error': '服务未在 10 秒内停止', 'pid': state.get('pid')}


def status(target: str | None = None) -> dict[str, Any]:
    address = (target or endpoint()).rstrip('/')
    payload = health(address, timeout=2.0)
    if not payload:
        return {'ok': False, 'endpoint': address, 'error': '未运行', 'db': str(database_path())}
    try:
        payload = http_json(address + '/health', token=read_token(), timeout=5.0)
    except (urllib.error.URLError, OSError, ValueError):
        pass
    payload['endpoint'] = address
    return payload


# ---------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='本机共享记忆常驻服务')
    sub = parser.add_subparsers(dest='command', required=True)

    run = sub.add_parser('serve', help='前台运行服务（正常由 start 拉起）')
    run.add_argument('--port', type=int, default=None)
    run.add_argument('--db', default=None)
    run.add_argument('--pool', type=int, default=DEFAULT_POOL_SIZE)

    start = sub.add_parser('start', help='脱离启动服务并等待就绪')
    start.add_argument('--port', type=int, default=None)
    start.add_argument('--db', default=None)
    start.add_argument('--pool', type=int, default=DEFAULT_POOL_SIZE)

    sub.add_parser('stop', help='停止服务')
    sub.add_parser('status', help='打印服务状态')
    sub.add_parser('ensure', help='确保服务在线（必要时拉起）')

    call = sub.add_parser('call', help='调用一个工具（JSON 从 stdin 读）')
    call.add_argument('tool')
    call.add_argument('--json', default=None)
    call.add_argument('--timeout', type=float, default=60.0)

    reindex = sub.add_parser('reindex', help='经服务重建 FTS / 向量索引')
    reindex.add_argument('--project', default=None)
    reindex.add_argument('--force', action='store_true')
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    args = build_parser().parse_args(argv)
    try:
        if args.command == 'serve':
            db = args.db or str(database_path())
            return serve(port=args.port, db_path=db, pool_size=args.pool)
        if args.command == 'start':
            if args.db:
                os.environ[DB_ENV] = args.db
            if args.port:
                os.environ[PORT_ENV] = str(args.port)
            address = ensure_running()
            print(json.dumps({'ok': True, 'endpoint': address, 'status': status(address)}, ensure_ascii=False))
            return 0
        if args.command == 'stop':
            print(json.dumps(stop_service(), ensure_ascii=False))
            return 0
        if args.command == 'status':
            payload = status()
            print(json.dumps(payload, ensure_ascii=False))
            return 0 if payload.get('ok') else 2
        if args.command == 'ensure':
            print(json.dumps({'ok': True, 'endpoint': ensure_running()}, ensure_ascii=False))
            return 0
        if args.command == 'call':
            text = args.json if args.json else sys.stdin.read()
            arguments = json.loads(text) if text.strip() else {}
            print(json.dumps(call_tool(args.tool, arguments, timeout=args.timeout), ensure_ascii=False))
            return 0
        if args.command == 'reindex':
            print(json.dumps(call_tool('reindex', {'project': args.project, 'force': args.force},
                                       timeout=600.0), ensure_ascii=False))
            return 0
    except ServiceUnavailable as error:
        print(f'[swarm-memory-service] {error}', file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - CLI 边界
        print(f'[swarm-memory-service] {error}', file=sys.stderr)
        return 2
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
