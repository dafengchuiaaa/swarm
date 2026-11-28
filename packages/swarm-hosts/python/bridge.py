#!/usr/bin/env python3
"""Host bridge: newline-delimited JSON over stdio, wrapping the old swarm adapters.

The bridge is deliberately dumb: it owns no state, it only turns one request
into one host turn and forwards every event the adapter emits. Sessions,
projects, receipts and the collaboration bus live in the Electron main process.

Request  (one JSON object per line on stdin):
  {"id":"r1","op":"run","host":"CodeBuddy","prompt":"...","model":"hy3",
   "sessionId":null,"workspace":"D:/repo","effort":"","timeout":180,
   "accessMode":"danger-full-access"}
  {"id":"r2","op":"inventory"} | {"op":"models"} | {"op":"ping"}
  {"id":"r1","op":"cancel"} | {"id":"r1","op":"steer","text":"先看 tests/"}

Response / event (one JSON object per line on stdout):
  {"id":"r1","kind":"event","event":"reasoning","payload":"..."}
  {"id":"r1","kind":"result","reply":{"text":"...","sessionId":"...","model":"...","seconds":12.3}}
  {"id":"r1","kind":"error","type":"TransportError","error":"...","trace":"..."}
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import shutil
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import adapters  # noqa: E402  (path must be set first)
import client_registry  # noqa: E402
from reasoning import GEMINI_FLASH, GEMINI_LEVELS, read_catalog  # noqa: E402

_OUT = threading.Lock()
_RUNS: dict[str, dict[str, object]] = {}


def _send(message: dict) -> None:
    line = json.dumps(message, ensure_ascii=False, separators=(',', ':'))
    with _OUT:
        try:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            os._exit(0)


def _payload(value):
    """Callables (steer hooks) are not JSON; everything else must survive the wire."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        return str(value)


def _emitter(request_id: str):
    def emit(kind: str, payload) -> None:
        if kind == 'steer_ready':
            state = _RUNS.get(request_id)
            if state is not None and callable(payload):
                state['steer'] = payload
            _send({'id': request_id, 'kind': 'event', 'event': 'steer_ready', 'payload': True})
            return
        _send({'id': request_id, 'kind': 'event', 'event': kind, 'payload': _payload(payload)})

    return emit


def _run(request_id: str, args: dict) -> None:
    state = _RUNS[request_id]
    started = time.monotonic()
    host = args.get('host') or ''
    runner = adapters.RUNNERS.get(host)
    if runner is None:
        _send({'id': request_id, 'kind': 'error', 'type': 'ValueError', 'error': f'未接入的宿主：{host}'})
        return
    try:
        kwargs = {
            'effort': args.get('effort') or '',
            'workspace': args.get('workspace') or None,
            'access_mode': args.get('accessMode') or 'danger-full-access',
        }
        tools = args.get('tools')
        if tools and host in ('CodeBuddy', 'Antigravity', 'Qoder'):
            kwargs['tools'] = tools
        reply = runner(
            args.get('prompt') or '',
            args.get('sessionId') or None,
            args.get('model') or '',
            _emitter(request_id),
            state['cancel'],
            int(args.get('timeout') or 180),
            **kwargs,
        )
        _send({
            'id': request_id,
            'kind': 'result',
            'reply': {
                'text': reply.text,
                'sessionId': reply.session_id,
                'model': reply.model,
                'seconds': round(time.monotonic() - started, 1),
            },
        })
    except BaseException as error:  # noqa: BLE001 - the shell must see real host failures
        _send({
            'id': request_id,
            'kind': 'error',
            'type': type(error).__name__,
            'error': str(error),
            'trace': traceback.format_exc()[-4000:],
        })
    finally:
        _RUNS.pop(request_id, None)


def _quota_source() -> Path | None:
    folder = os.environ.get('SWARM_QUOTA_SOURCE')
    source = Path(folder) if folder else None
    return source if source and (source / 'quota_monitor.py').is_file() else None


def _catalog() -> dict:

    folder = ROOT / 'data'
    catalogue: dict[str, object] = {'hosts': [], 'models': {}, 'thoughtLevels': {}, 'modelDetails': {}}
    catalogue['quotaAvailable'] = _quota_source() is not None
    for entry in adapters.inventory():
        catalogue['hosts'].append({
            'name': entry.get('name'),
            'ready': bool(entry.get('ready')),
            'installed': bool(entry.get('installed')),
            'adapter': bool(entry.get('adapter')),
            'state': entry.get('state'),
            'note': entry.get('note'),
            'enabled': bool(entry.get('enabled')),
            'customPath': entry.get('customPath'),
            'nativeModelCatalog': entry.get('name') == 'CodeBuddy',
        })
    for name, filename in (('CodeBuddy', 'model-catalog.json'), ('Antigravity', 'antigravity-models.json')):
        path = folder / filename
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            data = []
        catalogue['models'][name] = data if isinstance(data, list) else data.get(name, [])
    ag_models = catalogue['models']['Antigravity']
    variants = {value.removeprefix(GEMINI_FLASH + '-') for _, value in ag_models
                if value.startswith(GEMINI_FLASH + '-')}
    if variants:
        catalogue['models']['Antigravity'] = [['Gemini 3.8 Flash', GEMINI_FLASH]] + [
            [label, value] for label, value in ag_models if not value.startswith(GEMINI_FLASH + '-')
        ]
        catalogue['thoughtLevels']['Antigravity'] = {GEMINI_FLASH: [level for level in GEMINI_LEVELS
                                                                  if level in variants]}
    models = read_catalog(Path.home() / '.codex/models_cache.json').get('models', [])
    catalogue['models']['GPT / Codex'] = [
        [model.get('display_name') or model['slug'], model['slug']]
        for model in models if model.get('slug') and model.get('visibility') == 'list'
    ]
    catalogue['thoughtLevels']['GPT / Codex'] = {
        model['slug']: [entry['effort'] for entry in model.get('supported_reasoning_levels', [])]
        for model in models if model.get('slug')
    }
    catalogue['modelDetails']['GPT / Codex'] = {
        model['slug']: {'contextWindow': model.get('context_window'),
                        'defaultEffort': model.get('default_reasoning_level')}
        for model in models if model.get('slug')
    }
    catalogue['thoughtLevels']['DeepSeek Harness'] = {'': ['off', 'low', 'high', 'max']}
    try:
        levels = json.loads((folder / 'model-catalog.json').read_text(encoding='utf-8')).get('CodeBuddyThoughtLevels', {})
    except (OSError, ValueError):
        levels = {}
    catalogue['thoughtLevels']['CodeBuddy'] = levels
    catalogue['antigravityCli'] = client_registry.antigravity_cli()
    return catalogue


def _read_quotas(request_id: str) -> None:
    # Keep the original readers in their owning workspace and use a separate interpreter
    # so their adapter imports do not resolve to this bridge's copies.
    source = _quota_source()
    if source is None:
        _send({'id': request_id, 'kind': 'result', 'accounts': {}})
        return
    script = '''
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
from quota_monitor import READERS, read_codex_http
import sys

ready_hosts = set(json.loads(sys.argv[1]))

def read(item):
    host, reader = item
    try:
        data = (read_codex_http if host == 'GPT / Codex' else reader)()
        data.setdefault('status', 'ready')
        data['updated'] = time.time()
    except Exception:
        data = {'status': 'error', 'note': '读取失败，请检查原客户端登录或网络'}
    return host, data

with ThreadPoolExecutor(max_workers=5) as pool:
    for result in as_completed(pool.submit(read, item) for item in READERS.items() if item[0] in ready_hosts):
        host, data = result.result()
        print(json.dumps({host: data}, ensure_ascii=False, allow_nan=False), flush=True)
'''
    try:
        try:
            ready = [entry['name'] for entry in adapters.inventory() if entry['ready']]
            result = subprocess.run([sys.executable, '-c', script, json.dumps(ready)], cwd=source, timeout=32,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            output = result.stdout
        except subprocess.TimeoutExpired as error:
            output = error.output or b''
        accounts = {}
        for line in output.splitlines():
            try:
                accounts.update(json.loads(line))
            except (ValueError, TypeError):
                continue
        _send({'id': request_id, 'kind': 'result', 'accounts': accounts})
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        _send({'id': request_id, 'kind': 'error', 'error': '原额度服务未返回数据'})


def _acp_reply(proc, request_id, method, params):
    proc.write({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params})
    deadline = time.monotonic() + 8
    cancel = threading.Event()
    while True:
        response = proc.read(deadline, cancel)
        if response.get('id') != request_id:
            continue
        if response.get('error'):
            raise ValueError(str(response['error']))
        return response.get('result') or {}


def _codebuddy_catalog(session):
    result = {'models': [], 'thoughtLevels': {}, 'modelDetails': {}}
    config = {entry['id']: entry.get('currentValue') for entry in session.get('configOptions') or []}
    for model in (session.get('models') or {}).get('availableModels') or []:
        value = model.get('modelId')
        if not value:
            continue
        meta = model.get('_meta') or {}
        result['models'].append([model.get('name') or value, value])
        result['thoughtLevels'][value] = [level['value'] for level in meta.get('effortOptions') or [] if level.get('value')]
        detail = {}
        credits = re.fullmatch(r'x(\d+(?:\.\d+)?)\s+credits', meta.get('credits') or model.get('description') or '', re.I)
        if credits:
            detail['creditMultiplier'] = float(credits[1])
        if meta.get('maxInputTokens'):
            detail['maxInputTokens'] = meta['maxInputTokens']
        if value == config.get('model') and config.get('thought_level') in result['thoughtLevels'][value]:
            detail['defaultEffort'] = config['thought_level']
        result['modelDetails'][value] = detail
    return result


def _probe_host(request_id, host, selected_path, read_models=False):
    try:
        candidate = client_registry.validate_host_path(host, selected_path)
        if host in ('CodeBuddy', 'Antigravity', 'Qoder'):
            env = None
            if host == 'CodeBuddy':
                executable = candidate or client_registry.host_path(host) or str(Path.home() / 'AppData/Local/Programs/CodeBuddyCLI/bin/codebuddy.exe')
                command = [executable, '--acp', '--port', '0']
                if read_models:
                    if not client_registry.client_info(host)['ready']:
                        raise ValueError('CodeBuddy 未启用')
                    if os.environ.get('CODEBUDDY_SESSION_ID') or os.environ.get('CODEBUDDY_CONVERSATION_MESSAGE_ID'):
                        raise ValueError('当前在 CodeBuddy 会话内，不能递归启动宿主')
                    base = Path.home() / 'AppData/Local/Programs/CodeBuddyCLI'
                    env = dict(os.environ, CODEBUDDY_CONFIG_DIR=str(base / 'data'), TEMP=str(base / 'temp'), TMP=str(base / 'temp'))
            elif host == 'Antigravity':
                executable = candidate or client_registry.antigravity_cli()
                if not executable:
                    raise ValueError('未找到 agy.exe')
                command = [executable, 'acp', '--stdio']
            else:
                executable = candidate or client_registry.qoder_cli()
                if not executable:
                    raise ValueError('未找到 Qoder CLI')
                command = [executable, '--acp']
            proc = adapters.Process(command, env, workspace=ROOT)
            try:
                init = _acp_reply(proc, 1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {}})
                if init.get('protocolVersion') != 1:
                    raise ValueError('宿主未确认 ACP 握手')
                if read_models:
                    catalogue = _codebuddy_catalog(_acp_reply(proc, 2, 'session/new', {'cwd': str(ROOT), 'mcpServers': []}))
                    if not catalogue['models']:
                        raise ValueError('CodeBuddy 没有公布模型清单')
                    _send({'id': request_id, 'kind': 'result', 'catalog': catalogue})
                    return
            finally:
                proc.close()
            message = 'ACP 握手成功，未发送模型任务'
        else:
            env = None
            if host in ('ZCode', 'ZCode API'):
                command = adapters.zcode_command(candidate) + ['--help']
            elif host == 'DeepSeek Harness':
                command, env = adapters.dsh_command(executable=candidate)
                command += ['--help']
            else:
                executable = candidate or client_registry.host_path(host) or shutil.which('codex')
                if not executable:
                    raise ValueError('未找到 Codex CLI')
                command = [executable, '--version']
            result = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=8,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode:
                raise ValueError(f'CLI 启动检测失败，退出码 {result.returncode}')
            message = 'CLI 启动成功，未验证账户或发送模型任务'
        _send({'id': request_id, 'kind': 'result', 'message': message})
    except (ValueError, adapters.TransportError, OSError, subprocess.SubprocessError) as error:
        _send({'id': request_id, 'kind': 'error', 'error': str(error)})


def _handle(request: dict) -> None:
    request_id = str(request.get('id') or uuid.uuid4().hex)
    op = request.get('op')
    if op == 'run':
        if not request.get('prompt'):
            _send({'id': request_id, 'kind': 'error', 'type': 'ValueError', 'error': '任务内容为空'})
            return
        _RUNS[request_id] = {'cancel': threading.Event(), 'steer': None}
        threading.Thread(target=_run, args=(request_id, request), name=f'host-{request_id}', daemon=True).start()
    elif op == 'cancel':
        state = _RUNS.get(request_id)
        if state:
            state['cancel'].set()
            _send({'id': request_id, 'kind': 'event', 'event': 'cancelling', 'payload': True})
        else:
            _send({'id': request_id, 'kind': 'error', 'type': 'ValueError', 'error': '该任务不存在或已结束'})
    elif op == 'steer':
        state = _RUNS.get(request_id)
        steer = (state or {}).get('steer')
        if not callable(steer):
            _send({'id': request_id, 'kind': 'error', 'type': 'ValueError', 'error': '当前宿主不支持即时引导'})
            return
        try:
            result = steer(request.get('text') or '')
            _send({'id': request_id, 'kind': 'event', 'event': 'steer', 'payload': _payload(result)})
        except BaseException as error:  # noqa: BLE001
            _send({'id': request_id, 'kind': 'error', 'type': type(error).__name__, 'error': str(error)})
    elif op == 'inventory':
        _send({'id': request_id, 'kind': 'result', 'inventory': adapters.inventory()})
    elif op == 'models':
        _send({'id': request_id, 'kind': 'result', 'catalog': _catalog()})
    elif op == 'quotas':
        threading.Thread(target=_read_quotas, args=(request_id,), daemon=True).start()
    elif op == 'codebuddy:models':
        threading.Thread(target=_probe_host, args=(request_id, 'CodeBuddy', '', True), daemon=True).start()
    elif op == 'qoder:cli':
        path = client_registry.qoder_cli() if client_registry.client_info('Qoder')['ready'] else None
        _send({'id': request_id, 'kind': 'result', 'path': path})
    elif op == 'host:set_enabled':
        host = request.get('host')
        enabled = request.get('enabled')
        if not isinstance(host, str) or host not in adapters.RUNNERS or not isinstance(enabled, bool):
            _send({'id': request_id, 'kind': 'error', 'error': '无效的宿主开关'})
            return
        try:
            client_registry.set_platform_enabled(host, enabled)
            _send({'id': request_id, 'kind': 'result', 'catalog': _catalog()})
        except OSError:
            _send({'id': request_id, 'kind': 'error', 'error': '无法保存宿主开关'})
    elif op in ('host:probe', 'host:set_path'):
        host = request.get('host')
        candidate = request.get('path', '')
        if not isinstance(host, str) or host not in adapters.RUNNERS or not isinstance(candidate, str):
            _send({'id': request_id, 'kind': 'error', 'error': '无效的宿主路径'})
        elif op == 'host:probe':
            threading.Thread(target=_probe_host, args=(request_id, host, candidate), daemon=True).start()
        else:
            try:
                client_registry.set_host_path(host, candidate)
                _send({'id': request_id, 'kind': 'result', 'catalog': _catalog()})
            except (OSError, ValueError) as error:
                _send({'id': request_id, 'kind': 'error', 'error': str(error)})
    elif op == 'ping':
        _send({'id': request_id, 'kind': 'result', 'pong': True, 'python': sys.version.split()[0]})
    else:
        _send({'id': request_id, 'kind': 'error', 'type': 'ValueError', 'error': f'未知操作：{op}'})


def main() -> int:
    _send({'kind': 'ready', 'python': sys.version.split()[0]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            _send({'kind': 'error', 'type': 'ValueError', 'error': '请求不是合法 JSON'})
            continue
        if request.get('op') == 'shutdown':
            for state in list(_RUNS.values()):
                state['cancel'].set()
            _send({'kind': 'bye'})
            return 0
        try:
            _handle(request)
        except BaseException as error:  # noqa: BLE001
            _send({'kind': 'error', 'type': type(error).__name__, 'error': str(error)})
    return 0


if __name__ == '__main__':
    sys.exit(main())
