"""Rule-first execution reviews built from real, redacted tool events.

The module deliberately has no model or database dependency. Adapters supply facts,
MemoryStore owns persistence, and these functions only normalize evidence, find the
three MVP failure shapes, and describe a narrowly scoped reusable test-entry lesson.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

SCHEMA_VERSION = 1
REDACTED = '<redacted>'
UNKNOWN = 'unknown'
SENSITIVE_KEY = re.compile(
    r'(?:authorization|cookie|token|secret|password|passwd|credential|private[_.-]?key|'
    r'api[_.-]?key|access[_.-]?key|session[_.-]?key|\.env|(?<![a-z])key(?![a-z])|'
    r'database[_.-]?url|connection[_.-]?string|(?<![a-z])dsn(?![a-z]))', re.I)
SAFE_ENV_KEYS = {'CI', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'NODE_ENV', 'LANG'}
# 半截私钥（上游已截断、没有 END 尾）也要吃掉，吃到下一个空行为止
PRIVATE_KEY = re.compile(r'-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|\n\s*\n|\Z)', re.S)
BEARER = re.compile(r'\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+', re.I)
ASSIGNED_SECRET = re.compile(
    r'(?i)\b(api[_.-]?key|token|secret|password|passwd|authorization|cookie|credential|key)'
    r'(\s*[:=]\s*)(["\']?)[^\s,"\'&]+\3')
# 任意 scheme 的 user:pass@：postgres:// mysql:// redis:// mongodb+srv:// 全覆盖
# （旧版只认 https?://，导致连接串凭据直接落库）
URL_CREDENTIAL = re.compile(r'(?i)\b([a-z][a-z0-9+.-]*://)([^\s/@:]+):([^\s/@]+)@')
# 值形态兜底：光看字段名挡不住 `?key=AIza...` 这种，得按密钥字面量形状再兜一层
# JWT 段的长度门槛收到 8：真实的短头 JWT（eyJhbGciOiJIUzI1NiJ9 只有 17 字符）在
# 20 的门槛下会漏进证据正文——本轮补证测试实测到该泄漏，故按"三段 base64url"形态判。
VALUE_SECRET = re.compile(
    r'\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}'
    r'|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}'
    r'|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})')
WINDOWS_PROFILE = re.compile(r'(?i)\b([A-Z]:[\\/]+Users[\\/]+)([^\\/\s]+)')
UNIX_PROFILE = re.compile(r'(?i)(?<![\w])(/(?:home|Users)/)([^/\s]+)')
# argv 旗标补充名单：SENSITIVE_KEY 正则盖不住但值明确是凭据形态的裸旗标名
EXTRA_SENSITIVE_FLAGS = {'user', 'login', 'jwt', 'bearer', 'secret-key', 'sig', 'u'}


def sanitize_argv(argv):
    """把"执行用 argv"转成"记录口径 argv"：旗标凭据与值形态密钥全部 <redacted>。

    复核缺口 HIGH-1：原始 argv 曾被原样写进验证来源与正式经验
    （verification_argv / 验证命令 / evidence.argv 三处），验证命令里一旦带
    `--api-key sk-xxx` 就等于把凭据持久化。原则：执行用什么和记录什么分开，
    所有落库路径只持久化本函数的输出。旗标判定复用 SENSITIVE_KEY（对裸旗标名
    匹配，`--api-key`/`--token`/`--password` 等全覆盖），另补少量裸名单；
    `--flag=value` 与 `--flag value` 两种形态都处理；漏网的长密钥字面量
    （sk-/AIza/ghp_/JWT 三段式等）由 VALUE_SECRET 按值形态兜底。
    顺序关键：值形态兜底必须在旗标判定之后但对"非旗标 token"生效——否则
    sk-secret 这类本身含敏感词的凭据值会被误判成旗标，凭据本体原样放行。
    """
    items = [str(item) for item in (argv or [])]
    out = []
    redact_next = False
    for item in items:
        if redact_next:
            out.append(REDACTED)
            redact_next = False
            continue
        name, sep, value = item.partition('=')
        bare = name.lstrip('-').lower()
        is_flag = name.startswith('-') and bool(bare)
        if is_flag and (bare in EXTRA_SENSITIVE_FLAGS or SENSITIVE_KEY.search(bare)):
            out.append(f'{name}{sep}{REDACTED}' if sep else item)
            if not sep:
                redact_next = True
            continue
        if VALUE_SECRET.search(item):
            out.append(REDACTED)
            continue
        out.append(item)
    return out


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sanitize_text(value, limit=1200):
    """Redact a copy; never mutate the command or output sent to the real tool."""
    text = str(value if value is not None else '')
    text = PRIVATE_KEY.sub(REDACTED, text)
    text = VALUE_SECRET.sub(REDACTED, text)
    text = URL_CREDENTIAL.sub(lambda m: m.group(1) + REDACTED + '@', text)
    text = BEARER.sub(lambda m: m.group(1) + ' ' + REDACTED, text)
    text = ASSIGNED_SECRET.sub(lambda m: m.group(1) + m.group(2) + REDACTED, text)
    text = WINDOWS_PROFILE.sub(r'\g<1>' + REDACTED, text)
    text = UNIX_PROFILE.sub(r'\g<1>' + REDACTED, text)
    text = text.replace('\x00', '')
    # 孤立代理（JSON \udXXX 转义反序列化而来）会让下游 encode/sqlite 直接抛
    # UnicodeEncodeError，一次就能报废整条执行事件或复盘记录，这里先压平
    text = text.encode('utf-8', 'replace').decode('utf-8')
    if len(text) > limit:
        return text[:limit] + '…<truncated>'
    return text


def sanitize(value, key='', *, limit=1200, depth=0):
    if SENSITIVE_KEY.search(str(key or '')):
        return REDACTED
    if depth > 6:
        return '<max-depth>'
    if isinstance(value, dict):
        result = {}
        for name, item in value.items():
            name = str(name)
            if name == 'env' and isinstance(item, dict):
                result[name] = {k: sanitize(v, k, limit=200, depth=depth + 1)
                                for k, v in item.items() if k in SAFE_ENV_KEYS}
                result['env_coverage'] = 'allowlisted_non_sensitive_only'
            else:
                result[name] = sanitize(item, name, limit=limit, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [sanitize(item, key, limit=limit, depth=depth + 1) for item in value[:80]]
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    return sanitize_text(value, limit)


def relative_cwd(cwd, workspace=None):
    if not cwd:
        return UNKNOWN
    try:
        path = Path(cwd).resolve()
        if workspace:
            return path.relative_to(Path(workspace).resolve()).as_posix() or '.'
        return path.as_posix()
    except (OSError, ValueError, TypeError):
        return '<outside-workspace>'


def normalize_event(raw, envelope=None):
    """Produce the versioned execution_event body stored in sources.body."""
    source = dict(raw or {})
    event = sanitize(source)
    event.update(sanitize(dict(envelope or {})))
    event['schema_version'] = SCHEMA_VERSION
    event.setdefault('event_type', UNKNOWN)
    event.setdefault('tool_name', UNKNOWN)
    event.setdefault('tool_call_id', UNKNOWN)
    event.setdefault('occurred_at', utc_now())
    event.setdefault('coverage', {'platform': UNKNOWN, 'tools': 'partial'})
    event.setdefault('duration_ms', None)
    event.setdefault('exit_code', None)
    event.setdefault('result', UNKNOWN)
    identity = [event.get('tool_call_id'), event.get('event_type'),
                event.get('occurred_at'), event.get('call_id'), event.get('task_id')]
    if not event.get('event_id'):
        event['event_id'] = 'E-' + hashlib.sha256(
            json.dumps(identity, ensure_ascii=False, sort_keys=True, default=str).encode()
        ).hexdigest()[:24]
    params = event.get('parameters_summary')
    if isinstance(params, dict) and params.get('cwd'):
        params['cwd'] = relative_cwd(params.get('cwd'), event.get('workspace'))
    if event.get('cwd'):
        event['cwd'] = relative_cwd(event.get('cwd'), event.get('workspace'))
    if event.get('exit_code') is not None:
        event['result'] = 'succeeded' if event['exit_code'] == 0 else 'failed'
    elif event.get('event_type') in ('tool_failed', 'tool_cancelled'):
        event['result'] = 'failed' if event['event_type'] == 'tool_failed' else UNKNOWN
    elif event.get('event_type') == 'tool_completed' and event.get('result') == UNKNOWN:
        event['result'] = UNKNOWN
    event['error_signature'] = error_signature(event)
    return event


def error_signature(event):
    if event.get('exit_code') not in (None, 0):
        return 'exit:' + str(event['exit_code'])
    if event.get('event_type') not in ('tool_failed', 'tool_cancelled'):
        return ''
    detail = event.get('error_summary') or event.get('result_summary') or UNKNOWN
    return sanitize_text(str(detail).strip().splitlines()[0].lower(), 240)


def command_parts(event):
    params = event.get('parameters_summary') or {}
    command = params.get('command') or ''
    args = params.get('args') or []
    if not command and params.get('command_line'):
        try:
            parts = shlex.split(str(params['command_line']), posix=os.name != 'nt')
        except ValueError:
            parts = str(params['command_line']).split()
        return (parts[0] if parts else ''), parts[1:]
    return str(command), [str(item) for item in args if isinstance(item, (str, int, float))]


def safe_fingerprint(event):
    """A semantic retry key with secrets already removed, not raw stdout or env."""
    command, args = command_parts(event)
    semantic = {'tool': event.get('tool_name'), 'command': Path(command).name.casefold(),
                'args': args, 'cwd': event.get('cwd') or UNKNOWN,
                'operation': event.get('operation') or 'execute'}
    encoded = json.dumps(semantic, ensure_ascii=False, sort_keys=True).encode()
    return 'F-' + hashlib.sha256(encoded).hexdigest()[:24]


def _norm_entry(value):
    value = str(value or '').strip().strip('"\'').replace('\\', '/')
    while value.startswith('./'):
        value = value[2:]
    return value.rstrip('/').casefold()


def test_entry(event):
    """Recognize only common test runners; arbitrary shell commands are not lessons."""
    if event.get('tool_name') not in ('terminal', 'shell', 'bash', 'command'):
        return ''
    command, args = command_parts(event)
    executable = Path(command).name.casefold()
    joined = ' '.join([command, *args]).casefold()
    entry = ''
    if 'unittest' in joined:
        for index, arg in enumerate(args):
            if arg in ('-s', '--start-directory') and index + 1 < len(args):
                entry = args[index + 1]
                break
        if not entry and 'unittest' in args:
            rest = args[args.index('unittest') + 1:]
            entry = next((arg for arg in rest if not arg.startswith('-') and arg != 'discover'), '')
    elif 'pytest' in executable or 'pytest' in args:
        start = 1 if 'pytest' in args else 0
        skip_next = False
        for arg in args[start:]:
            if skip_next:
                skip_next = False
                continue
            if arg in ('-k', '-m', '-x', '--maxfail', '--tb', '-p'):
                skip_next = True
                continue
            if not arg.startswith('-'):
                entry = arg
                break
    elif executable.startswith('python') and args:
        entry = next((arg for arg in args if Path(arg).name.casefold().startswith('test') and arg.casefold().endswith('.py')), '')
    return _norm_entry(entry)


def _source_id(event):
    return event.get('source_id') or event.get('event_id')


def review_execution(events, outcome=None):
    """Three deterministic rules, each with direct evidence and no inferred root cause."""
    outcome = dict(outcome or {})
    ordered = sorted((dict(event) for event in events),
                     key=lambda item: str(item.get('occurred_at') or ''))
    issues = []
    terminal = [event for event in ordered if event.get('event_type') in
                ('tool_completed', 'tool_failed', 'tool_cancelled')]
    failures = [event for event in terminal if event.get('exit_code') not in (None, 0)
                or event.get('event_type') == 'tool_failed']
    by_fingerprint = {}
    for event in failures:
        event.setdefault('safe_fingerprint', safe_fingerprint(event))
        by_fingerprint.setdefault(event['safe_fingerprint'], []).append(event)
    for fingerprint, items in by_fingerprint.items():
        if len(items) < 2:
            continue
        issues.append({'rule': 'repeated_tool_failure', 'fingerprint': fingerprint,
                       'evidence_source_ids': [_source_id(item) for item in items],
                       'fact': f'同一工具及参数指纹失败 {len(items)} 次',
                       'root_cause_hypotheses': [], 'suggestions': ['停止原样重试，先核对入口、环境与错误签名。']})
    recoveries = []
    for failed in failures:
        bad_entry = test_entry(failed)
        if not bad_entry:
            continue
        for recovered in terminal:
            if recovered is failed or recovered.get('exit_code') != 0:
                continue
            if str(recovered.get('occurred_at') or '') < str(failed.get('occurred_at') or ''):
                continue
            good_entry = test_entry(recovered)
            if good_entry and good_entry != bad_entry:
                chain = {'failed_event_ids': [_source_id(failed)],
                         'strategy_changed': {'from': bad_entry, 'to': good_entry},
                         'recovery_event_ids': [_source_id(recovered)]}
                recoveries.append(chain)
                issues.append({'rule': 'test_entry_recovered', 'evidence_source_ids':
                               chain['failed_event_ids'] + chain['recovery_event_ids'],
                               'fact': f'入口 {bad_entry} 失败后改用 {good_entry} 并成功',
                               'recovery': chain, 'root_cause_hypotheses': [],
                               'suggestions': [f'同类测试任务先检查并使用入口 {good_entry}。']})
                break
    check = outcome.get('final_check') or {'status': UNKNOWN, 'evidence_source_ids': []}
    if outcome.get('task_completed') and check.get('status') != 'passed':
        issues.append({'rule': 'completion_without_required_check',
                       'evidence_source_ids': list(check.get('evidence_source_ids') or []),
                       'fact': '回复已完成，但必要成果检查失败或缺失',
                       'root_cause_hypotheses': [], 'suggestions': ['补齐真实成果检查后再评估任务完成。']})
    review = {'schema_version': SCHEMA_VERSION,
              'mission_id': outcome.get('mission_id', UNKNOWN),
              'run_id': outcome.get('run_id', UNKNOWN),
              'task_completed': bool(outcome.get('task_completed')),
              'process_has_issues': bool(issues), 'issues': issues,
              'recoveries': recoveries, 'final_check': check,
              'root_cause_hypotheses': [],
              'suggestions': list(dict.fromkeys(s for issue in issues for s in issue['suggestions'])),
              'reusability': {'test_entry': bool(recoveries), 'scope': 'current_project_and_workspace'},
              'review_method': 'deterministic_rules_v1',
              'coverage': outcome.get('coverage') or {'tools': 'partial', 'unknown_is_not_success': True},
              'metrics': {'tool_results': len(terminal), 'failed_results': len(failures),
                          'repeated_failure_groups': sum(1 for v in by_fingerprint.values() if len(v) > 1),
                          'recovered_test_entries': len(recoveries)}}
    return review


def experience_proposal(review, events, context=None):
    """One observed recovery becomes a recommendation, never an instant verified constraint."""
    if not review.get('task_completed') or (review.get('final_check') or {}).get('status') != 'passed':
        return None
    recovery = next((item for item in review.get('recoveries') or []), None)
    if not recovery:
        return None
    bad = recovery['strategy_changed']['from']
    good = recovery['strategy_changed']['to']
    ids = list(dict.fromkeys(recovery['failed_event_ids'] + recovery['recovery_event_ids']))
    by_id = {_source_id(event): event for event in events}
    recovered = by_id.get(recovery['recovery_event_ids'][0], {})
    command, args = command_parts(recovered)
    context = dict(context or {})
    scope = {'project_id': context.get('project_id', UNKNOWN),
             'workspace': context.get('workspace', UNKNOWN)}
    case = hashlib.sha256(json.dumps([scope, 'test_entry', bad, good], ensure_ascii=False,
                                    sort_keys=True).encode()).hexdigest()[:20]
    evidence = ids + list((review.get('final_check') or {}).get('evidence_source_ids') or [])
    experience = {
        'schema_version': SCHEMA_VERSION, 'scope': scope,
        'trigger': {'type': 'run_project_tests', 'avoid_entries': [bad]},
        'environment': {'workspace': scope['workspace'], 'required_paths': [good],
                        'tool_versions': recovered.get('tool_versions') or {}},
        'level': 'recommended_step',
        'action': {'type': 'test_entry', 'entry': good, 'avoid_entries': [bad],
                   'runner': command, 'args_hint': args},
        'checklist': [f'先确认入口 {good} 仍存在', f'同类测试直接使用 {good}，不要先尝试 {bad}',
                      '以真实退出码和成果检查确认结果'],
        'evidence_source_ids': list(dict.fromkeys(evidence)),
        'confidence': 'observed_once', 'verification_status': 'unverified',
        'last_verified_at': None, 'evaluation_source_ids': [], 'case_id': case,
        'baseline': {'mission_id': review.get('mission_id'),
                     'failed_event_ids': recovery['failed_event_ids'],
                     'recovery_event_ids': recovery['recovery_event_ids'],
                     'wrong_attempts': 1},
    }
    return {'entry_id': None, 'expected_revision': 0, 'kind': 'lesson',
            'title': f'测试入口：用 {good}，避开 {bad}',
            'body': f'真实工具轨迹显示：{bad} 执行失败后改用 {good} 成功。仅适用于当前项目与相同入口布局；首次记录，后续重放验证前不是强制约束。',
            'task_id': None, 'source_ids': list(dict.fromkeys(evidence)), 'experience': experience}


def application_observation(experience, event):
    """Return executed/violated only when a real relevant terminal result is visible."""
    action = (experience or {}).get('action') or {}
    if action.get('type') != 'test_entry' or event.get('event_type') not in ('tool_completed', 'tool_failed'):
        return None
    observed = test_entry(event)
    if not observed:
        return None
    if observed in {_norm_entry(item) for item in action.get('avoid_entries') or []}:
        return 'violated'
    if observed == _norm_entry(action.get('entry')):
        return 'executed'
    return None
