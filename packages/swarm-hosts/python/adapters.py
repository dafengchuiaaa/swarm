"""Text-only transport probes. Existing desktop conversations are NOT auto-bound."""



from __future__ import annotations



import json



import os



from pathlib import Path



import queue



import shutil



import subprocess



import threading



import time



import uuid



from collections import deque



from dataclasses import dataclass



from compact_signal import acp_compact, codex_compaction_records, iso_utc, qoder_compaction_records
from telemetry import acp_usage, token_usage

from execution_review import sanitize_text



from agent_prompts import current, native_args, runtime_file, task_prompt



from client_registry import antigravity_cli, host_path, qoder_cli



from process_tree import ClientJob, terminate_tree



from reasoning import antigravity_model
from reasoning import normalize_member







ROOT = Path(__file__).resolve().parent











class TransportError(RuntimeError):



    pass











_UNAVAILABLE={}

UNAVAILABLE_SECONDS=900





def mark_unavailable(platform,reason):

    """Remember that this platform cannot take work right now (empty balance, dead login).



    The HUD can say 96.7% and the client can still refuse every call, so the only honest

    signal is a real failure. Skipping it for a while beats dispatching into the same

    wall on every round.

    """

    _UNAVAILABLE[platform]=(time.monotonic(),str(reason)[:160])





def platform_unavailable(platform):

    item=_UNAVAILABLE.get(platform)

    if not item:return ''

    at,reason=item

    if time.monotonic()-at>UNAVAILABLE_SECONDS:

        _UNAVAILABLE.pop(platform,None);return ''

    return reason





def blocks_platform(text):

    """True when the failure means 'do not send work here again soon'."""

    return _explain(str(text)).startswith('平台账户余额不足') or _explain(str(text)).startswith('客户端登录失效')







def _trim(text, limit=140):



    text = ' '.join(str(text).split())



    return text[:limit] + ('…' if len(text) > limit else '')











def _explain(line):



    """Turn a client's own stderr complaint into something the user can act on.







    Without this the window only ever said 'the process exited before the result



    arrived', which is true and useless: the real reason (an empty balance) was sitting



    in a stream nobody read.



    """



    text = str(line).strip()



    lowered = text.lower()



    if 'insufficient balance' in lowered or 'no resource package' in lowered or '1113' in text:



        return '平台账户余额不足或资源包用尽，需要充值（注：ZCode 鸡蛋计划等仅桌面端原生可用）'



    if 'quota exceeded' in lowered or 'resource_exhausted' in lowered or 'rate limit' in lowered:



        return '平台额度或频率受限'



    if ('401' in text or 'unauthorized' in lowered or 'authentication' in lowered



            or 'not logged' in lowered or 'login' in lowered):



        return '客户端登录失效，需要重新登录'



    if 'error' in lowered or 'failed' in lowered or '错误' in text:



        return '客户端报错'



    return ''











@dataclass



class Reply:



    text: str



    session_id: str



    model: str











class Process:



    def __init__(self, command, env=None, *, workspace=None):



        self.proc = subprocess.Popen(command, cwd=workspace or ROOT / 'workspace', env=env,



            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,



            encoding='utf-8', errors='replace', text=True, bufsize=1,



            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))



        # The client's own tool subprocesses must die with it; see process_tree.



        self.job = ClientJob()



        self.job.attach(self.proc)



        self.lines = queue.Queue()



        self.errors = deque(maxlen=8)



        self.write_lock = threading.Lock()



        threading.Thread(target=self._read, daemon=True).start()



        # Server banners may contain temporary passwords. Never expose stderr.



        threading.Thread(target=self._drain, daemon=True).start()







    def _read(self):



        buffer = []



        try:



            for line in self.proc.stdout:



                try:



                    self.lines.put(json.loads(line))



                    buffer.clear()



                    continue



                except ValueError:



                    pass



                buffer.append(line)



                try:



                    obj = json.loads(''.join(buffer))



                    self.lines.put(obj)



                    buffer.clear()



                except ValueError:



                    pass



        finally:



            self.lines.put(None)







    def _drain(self):



        for line in self.proc.stderr:



            text = line.strip()



            if not text or len(text) > 400:



                continue



            lowered = text.lower()



            # Server banners may carry temporary passwords; only complaint lines are kept,



            # and never the ones that look like credentials.



            if 'password' in lowered or 'token=' in lowered or 'bearer ' in lowered:



                continue



            if _explain(text):



                self.errors.append(text)







    def write(self, frame):



        with self.write_lock:



            self.proc.stdin.write(json.dumps(frame, ensure_ascii=False) + '\n')



            self.proc.stdin.flush()







    def read(self, idle, cancel):



        """Wait for the next frame, and treat silence - not elapsed time - as stuck.







        This used to take one absolute deadline for the whole call, so a member that



        was still working (a compiler, Blender, a long tool loop) was killed at the



        same moment as a hung one. Every frame now restarts the window.



        """



        deadline = time.monotonic() + max(1.0, float(idle))



        while time.monotonic() < deadline:



            if cancel.is_set():



                raise TransportError('已停止本地等待；远端是否停止仍待确认')



            try:



                frame = self.lines.get(timeout=.2)



            except queue.Empty:



                continue



            if frame is None:



                raise TransportError('进程在完整结果到达前退出；'+(self.failure() or '本轮状态待确认'))



            return frame



        raise TransportError(f'客户端 {int(idle)} 秒没有任何输出；本轮状态待确认')







    def failure(self):



        """The most useful complaint the client made, if it made one."""



        for line in reversed(self.errors):



            reason=_explain(line)



            if reason:return reason+'（'+_trim(line)+'）'



        return ''







    def close(self):



        # Terminating only the direct child left its tool subprocesses running, which is



        # why stopping a member used to leave work going in the background.



        self.job.close(self.proc)



        try:



            self.proc.wait(timeout=3)



        except subprocess.TimeoutExpired:



            self.proc.kill()



            try:



                self.proc.wait(timeout=3)



            except subprocess.TimeoutExpired:



                pass



        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):



            if stream:



                try:



                    stream.close()



                except OSError:



                    pass











class AcpTerminal:



    """Client side of ACP terminal/*: run the command here and hand the output back.







    CodeBuddy asks the client to execute shell commands; without this the member can



    only read files, which is what left a real task stuck on "no write access".



    """



    def __init__(self, command, args, cwd, env, byte_limit=None):



        merged = dict(os.environ)



        merged.update(env or {})



        self.limit = max(1024, int(byte_limit or 1048576))



        self.buffer = bytearray()



        self.truncated = False



        self.lock = threading.Lock()



        self.proc = subprocess.Popen([command, *(args or [])], cwd=cwd, env=merged,



            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,



            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))



        threading.Thread(target=self._pump, daemon=True).start()







    def _pump(self):



        while True:



            chunk = self.proc.stdout.read(4096)



            if not chunk:



                break



            with self.lock:



                self.buffer.extend(chunk)



                if len(self.buffer) > self.limit:



                    del self.buffer[:len(self.buffer) - self.limit]



                    self.truncated = True







    def output(self):



        with self.lock:



            text = self.buffer.decode('utf-8', 'replace')



            truncated = self.truncated



        result = {'output': text, 'truncated': truncated}



        code = self.proc.poll()



        if code is not None:



            result['exitStatus'] = {'exitCode': code, 'signal': None}



        return result







    def wait(self, cancel=None, timeout=900):



        deadline = time.monotonic() + timeout



        while self.proc.poll() is None:



            if cancel is not None and cancel.is_set():



                break



            if time.monotonic() > deadline:



                break



            time.sleep(.05)



        return {'exitCode': self.proc.poll(), 'signal': None}







    def kill(self):



        if self.proc.poll() is None:



            try:



                self.proc.kill()



            except OSError:



                pass







    def release(self):



        # A tool command may itself be a shell that started something heavier; kill the



        # tree, or stopping a member leaves a compiler running with nobody watching it.



        terminate_tree(self.proc.pid)



        try:



            self.proc.wait(timeout=2)



        except subprocess.TimeoutExpired:



            pass



        if self.proc.stdout:



            try:



                self.proc.stdout.close()



            except OSError:



                pass











def workbuddy_paths():



    base = Path(os.environ.get('AGENT_HUB_WORKBUDDY_HOME', str(Path.home() / '.workbuddy')))



    node = Path.home() / '.workbuddy/binaries/node/versions/22.22.2-6/node.exe'



    cli = base / 'resources/app.asar.unpacked/cli/bin/codebuddy'



    if not node.is_file():



        candidates = list((Path.home() / '.workbuddy/binaries/node/versions').glob('*/node.exe'))



        node = max(candidates, key=lambda p: p.stat().st_mtime) if candidates else Path(shutil.which('node') or '')



    if not node.is_file() or not cli.is_file():



        raise TransportError('未找到 WorkBuddy 内置 CLI；请检查安装位置')



    return str(node), str(cli)











def dsh_command(profile='headless', executable=None):



    base=Path.home() / 'AppData/Local/Programs/DeepSeek Harness'



    executable=Path(executable or host_path('DeepSeek Harness') or base/'DeepSeek Harness.exe')
    base=executable.parent



    cli=base/'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'



    if not executable.is_file():raise TransportError('未找到 DeepSeek Harness，请在启动中心检查安装位置')



    return [str(executable),'--expose-internals',str(cli),profile],dict(os.environ,ELECTRON_RUN_AS_NODE='1')











def run_workbuddy(prompt, session_id, model, emit, cancel, timeout=120, *, _standalone=False, effort='',



                  workspace=None, access_mode='danger-full-access', tools=None):



    label = 'CodeBuddy' if _standalone else 'WorkBuddy'



    prompt=task_prompt(prompt,label,session_id)



    if _standalone:



        base = Path.home() / 'AppData/Local/Programs/CodeBuddyCLI'



        executable = Path(host_path('CodeBuddy') or base / 'bin/codebuddy.exe')



        if not executable.is_file():



            raise TransportError('未找到 D 盘 CodeBuddy CLI')



        # Refuse to nest: starting the CodeBuddy CLI from inside a CodeBuddy/WorkBuddy



        # agent session makes two sessions of the same account fight over the session



        # slot and credentials, which reads as "the host went offline".



        if (not os.environ.get('CODEBUDDY_ALLOW_NESTED')) and (



                os.environ.get('CODEBUDDY_SESSION_ID') or os.environ.get('CODEBUDDY_CONVERSATION_MESSAGE_ID')):



            raise TransportError(



                '当前进程本身就在一个 CodeBuddy/WorkBuddy 会话里，不能在这里再启动 CodeBuddy CLI：'



                '同一账号的两个会话会互相抢占会话位和凭据，宿主会掉线。请从桌面直接启动蜂群后再安排 CodeBuddy 成员。')



        env = dict(os.environ, CODEBUDDY_CONFIG_DIR=str(base / 'data'),



                   TEMP=str(base / 'temp'), TMP=str(base / 'temp'))



        env.pop('CODEBUDDY_FORCE_LITE_WB_BUNDLE', None)



        env.pop('WORKBUDDY_CONFIG_DIR', None)



        # Headless authentication from the local desktop session keeps dropping



        # (token refresh 401 / missing-key). When an API key is provided, use the



        # official non-interactive path instead of depending on that login state.



        key_file = base / 'api-key.txt'



        try:



            if key_file.is_file():



                lines = key_file.read_text(encoding='utf-8', errors='replace').strip().splitlines()



                api_key = lines[0].strip() if lines else ''



                # The file ships with instructions; only a plausible key line counts.



                if api_key.isascii() and len(api_key) > 16 and ' ' not in api_key:



                    env['CODEBUDDY_API_KEY'] = api_key



                    env.setdefault('CODEBUDDY_INTERNET_ENVIRONMENT', 'internal')



        except OSError:



            pass



        command = [str(executable), '--acp']
        if tools:
            import tempfile as _swarm_tmp
            _swarm_mcp = Path(_swarm_tmp.gettempdir()) / ('swarm-mcp-' + uuid.uuid4().hex + '.json')
            _swarm_mcp.write_text(json.dumps({'mcpServers': {'swarm': tools}}, ensure_ascii=False), encoding='utf-8')
            command += ['--mcp-config', str(_swarm_mcp), '--strict-mcp-config']



    else:



        node, cli = workbuddy_paths()



        env = dict(os.environ, CODEBUDDY_FORCE_LITE_WB_BUNDLE='1',



            WORKBUDDY_CONFIG_DIR=str(Path.home() / '.workbuddy'),



            CODEBUDDY_CONFIG_DIR=str(Path.home() / '.workbuddy'))



        command = [node, cli, '--serve', '--host', '127.0.0.1', '--port', '0', '--acp']



    mode='bypassPermissions'



    if _standalone and '--port' not in command:command += ['--port','0']



    command += ['--permission-mode',mode,'--tools','default','--subagent-permission-mode',mode]



    if _standalone:command+=native_args(label,session_id)



    return run_acp(command, env, label, mode, prompt, session_id, model, effort, emit, cancel, timeout, workspace, tools)


def run_acp(command, env, label, mode, prompt, session_id, model, effort, emit, cancel, timeout, workspace, tools):
    proc = Process(command, env, workspace=workspace) if workspace else Process(command, env)



    idle = timeout



    counter = 0



    parts = []



    collecting = False



    _acp_started=iso_utc()



    _qoder_polled=[0.0]



    terminals = {}



    workspace_root = Path(workspace).resolve() if workspace else (ROOT / 'workspace').resolve()







    def utc_iso():return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    def trace_event(event_type, *, terminal=None, terminal_id='', exit_code=None,
                    error_summary='', result_summary='', tool_name='terminal', tool_call_id='unknown',
                    operation_id='', parameters_summary=None, duration_ms=None):
        """Emit redacted-later tool facts without ever changing the tool result."""
        payload={'event_type':event_type,'tool_name':tool_name,'tool_call_id':tool_call_id,
                 'operation_id':operation_id or ('terminal:'+str(terminal_id) if terminal_id else 'tool:'+uuid.uuid4().hex),
                 'occurred_at':utc_iso(),'exit_code':exit_code,'duration_ms':duration_ms,
                 'parameters_summary':parameters_summary or {},'error_summary':error_summary,
                 'result_summary':result_summary,
                 'coverage':{'platform':label,'tools':'acp_terminal','tool_call_id_available':tool_call_id!='unknown'}}
        if terminal is not None:
            started=getattr(terminal,'trace_started',None)
            if started is not None and duration_ms is None:
                payload['duration_ms']=max(0,round((time.monotonic()-started)*1000))
        try:emit('execution_event',payload)
        except Exception:pass

    def finish_terminal_trace(tid, terminal, event_type='tool_completed', exit_code=None,
                              error_summary='', result_summary=''):
        if getattr(terminal,'trace_completed',False):return
        terminal.trace_completed=True
        trace_event(event_type,terminal=terminal,terminal_id=tid,exit_code=exit_code,
                    error_summary=error_summary,result_summary=result_summary)

    def terminal_tool_update(update):
        """Capture the client's own tool updates only when the protocol supplies a real ID."""
        tool_call_id=update.get('toolCallId') or 'unknown'
        if tool_call_id=='unknown':return
        status=str(update.get('status') or '').casefold()
        if status in ('pending','in_progress','running'):event_type='tool_started';exit_code=None
        elif status in ('completed','success','succeeded'):event_type='tool_completed';exit_code=0
        elif status in ('failed','error'):event_type='tool_failed';exit_code=None
        else:event_type='tool_unknown';exit_code=None
        raw_input=update.get('rawInput')
        if isinstance(raw_input,str):
            try:raw_input=json.loads(raw_input)
            except ValueError:raw_input=raw_input
        trace_event(event_type,tool_name=str(update.get('kind') or 'client_tool'),
                    tool_call_id=tool_call_id,operation_id='tool:'+str(tool_call_id),
                    exit_code=exit_code,parameters_summary={'raw_input':raw_input,
                    'raw_output':update.get('rawOutput')},
                    error_summary=update.get('statusMessage') or '',
                    result_summary=update.get('status') or '')

    def terminal_call(method, params):



        if method == 'terminal/create':



            cwd = params.get('cwd') or str(workspace_root)



            target = Path(cwd).resolve()



            command = params.get('command')



            if not isinstance(command, str) or not command.strip():



                raise ValueError('命令为空，已拒绝')



            args = params.get('args')



            if args is not None and (not isinstance(args, list) or not all(isinstance(a, str) for a in args)):



                raise ValueError('命令参数格式无效，已拒绝')



            env = {item['name']: item.get('value', '') for item in (params.get('env') or [])



                   if isinstance(item, dict) and isinstance(item.get('name'), str)}



            params_summary={'command':command,'args':args if isinstance(args,list) else [],
                            'cwd':str(target),'env_keys':sorted(env)}
            start=time.monotonic()
            try:
                terminal = AcpTerminal(command, args, str(target), env, params.get('outputByteLimit'))
            except (OSError,ValueError) as error:
                trace_event('tool_failed',terminal_id='failed:'+uuid.uuid4().hex[:8],
                            exit_code=None,error_summary=str(error),parameters_summary=params_summary)
                raise
            terminal.trace_started=start;terminal.trace_completed=False



            tid = uuid.uuid4().hex[:12]



            terminals[tid] = terminal



            trace_event('tool_started',terminal=terminal,terminal_id=tid,exit_code=None,
                        parameters_summary=params_summary)
            emit('notice', f'{label} 执行命令：{sanitize_text(str(command)+(chr(32)+" ".join(args) if args else ""))}')



            return {'terminalId': tid}



        tid = params.get('terminalId')



        terminal = terminals.get(tid)



        if terminal is None:



            raise ValueError('终端不存在或已释放')



        if method == 'terminal/output':



            result=terminal.output();status=result.get('exitStatus')
            if status is not None:
                finish_terminal_trace(tid,terminal,'tool_completed' if status.get('exitCode')==0 else 'tool_failed',
                                      status.get('exitCode'),result_summary=result.get('output',''))
            return result



        if method == 'terminal/wait_for_exit':



            result=terminal.wait(cancel);code=result.get('exitCode')
            if code is not None:
                finish_terminal_trace(tid,terminal,'tool_completed' if code==0 else 'tool_failed',
                                      code,result_summary=terminal.output().get('output',''))
            return result



        if method == 'terminal/kill':



            terminal.kill()
            if not getattr(terminal,'trace_completed',False):
                code=terminal.proc.poll()
                finish_terminal_trace(tid,terminal,'tool_completed' if code==0 else 'tool_failed' if code is not None else 'tool_unknown',
                                      code,error_summary='' if code is not None else 'terminal killed before exit; exit code unknown',
                                      result_summary=terminal.output().get('output',''))


            return {}



        if method == 'terminal/release':



            terminal.release()
            if not getattr(terminal,'trace_completed',False):
                code=terminal.proc.poll()
                finish_terminal_trace(tid,terminal,'tool_completed' if code==0 else 'tool_failed' if code is not None else 'tool_unknown',
                                      code,error_summary='' if code is not None else 'terminal released before exit; exit code unknown',
                                      result_summary=terminal.output().get('output',''))



            terminals.pop(tid, None)



            return {}



        raise ValueError('不支持的终端操作')







    def permission_outcome(params):



        allow=next((o['optionId'] for o in params.get('options',[]) if o.get('kind') in ('allow_once','allow_always')),None)



        return allow,''







    def request(method, params, limit=None):



        nonlocal counter



        counter += 1



        rid = counter



        proc.write(dict(jsonrpc='2.0', id=rid, method=method, params=params))



        while True:



            frame = proc.read(limit or idle, cancel)



            if frame.get('id') == rid and ('result' in frame or 'error' in frame):



                if 'error' in frame:



                    # Do not reflect arbitrary upstream diagnostics containing credentials.



                    raise TransportError(f'{label} 拒绝 {method}（错误码 {frame["error"].get("code", "unknown")}）')



                return frame.get('result') or {}



            if frame.get('method') == 'session/update':



                reported_session=(frame.get('params') or {}).get('sessionId')



                if reported_session and session_id and reported_session != session_id:



                    continue



                update = (frame.get('params') or {}).get('update') or {}



                if update.get('sessionUpdate') == 'usage_update':



                    usage = acp_usage(update, label)



                    if not collecting:



                        # Session/load replays historical billing; keep only context,



                        # never attach a prior request's credits to this reply.



                        usage={k:v for k,v in usage.items() if k in (



                            'source','scope','context_used','context_size','context_empty_report')}



                    if usage:emit('usage', {**usage, 'compaction_replay': not collecting})

                compact = acp_compact(update, label, replaying=not collecting)
                if compact:emit('compact', compact)



                if label == 'Qoder' and session_id and time.time() - _qoder_polled[0] >= 2:




                    _qoder_polled[0] = time.time()




                    try:




                        for _c in qoder_compaction_records(session_id, since_iso=_acp_started):




                            emit('compact', _c)




                    except Exception as _error:emit('notice','Qoder 压缩记录读取失败：%s' % type(_error).__name__)



                if collecting and update.get('sessionUpdate') == 'agent_thought_chunk':



                    content = update.get('content') or {}



                    if content.get('type') == 'text' and isinstance(content.get('text'),str):



                        emit('reasoning',content['text'])



                if (collecting and update.get('sessionUpdate') == 'agent_message_chunk'
                    and not (label == 'CodeBuddy' and (update.get('_meta') or {}).get('codebuddy.ai/isCompactInternal') is True)):



                    content = update.get('content') or {}



                    if content.get('type') == 'text':



                        text = content.get('text', '')



                        parts.append(text)



                        emit('chunk', text)



                if update.get('sessionUpdate') in ('tool_call','tool_call_update'):
                    terminal_tool_update(update)

            elif frame.get('method') and 'id' in frame:



                if frame['method'] == 'session/request_permission':



                    params = frame.get('params') or {}



                    option, refusal = '', ''



                    if collecting and params.get('sessionId') == session_id:



                        option, refusal = permission_outcome(params)



                    if refusal:



                        emit('notice', f'{label} {refusal}')



                    if option:



                        outcome = {'outcome':'selected','optionId':option}



                    else:



                        outcome = {'outcome':'cancelled'}



                    proc.write(dict(jsonrpc='2.0', id=frame['id'], result={'outcome': outcome}))



                elif str(frame['method']).startswith('terminal/'):



                    try:



                        result = terminal_call(frame['method'], frame.get('params') or {})



                    except (ValueError, OSError) as error:



                        proc.write(dict(jsonrpc='2.0', id=frame['id'],



                                        error={'code': -32000, 'message': str(error)}))



                    else:



                        proc.write(dict(jsonrpc='2.0', id=frame['id'], result=result))



                else:



                    proc.write(dict(jsonrpc='2.0', id=frame['id'], error={'code': -32601, 'message': 'unsupported'}))







    def _open_session(method, params):



        # Session setup answers quickly or the CLI is not usable this run. Waiting the



        # whole call budget only delays a diagnosis the user can act on.



        try:



            return request(method, params, 25)



        except TransportError as error:



            raise TransportError(



                f'{label} 在 25 秒内没有建立会话。常见原因：CLI 未登录、版本不兼容，或本机端口被占用；'



                f'请先在终端单独运行一次 {label} 确认能正常对话，再回到蜂群重试。原始错误：{error}') from None







    try:



        init = request('initialize', {'protocolVersion': 1,



            'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False},



                                   'terminal': True}})



        emit('notice', 'ACP 协议已连接；真实模型请求尚未确认')



        params = {'cwd': str(workspace or ROOT / 'workspace'), 'mcpServers': [{'name': 'swarm', 'command': tools['command'],
                        'args': list(tools.get('args') or []),
                        'env': [{'name': key, 'value': str(value)} for key, value in (tools.get('env') or {}).items()]}] if tools else []}



        if session_id:



            if not (init.get('agentCapabilities') or {}).get('loadSession'):



                raise TransportError(f'此 {label} CLI 未声明可恢复会话；请新建会话，未发送本轮消息')



            params['sessionId'] = session_id



            session = _open_session('session/load', params)



        else:



            session = _open_session('session/new', params)



            session_id = session.get('sessionId')



        if not session_id:



            raise TransportError(f'{label} 没有返回会话 ID，未发送消息')



        emit('session', session_id)



        options = session.get('configOptions') or []



        if any(o.get('id')=='mode' and o.get('currentValue')!=mode for o in options):



            updated = request('session/set_config_option', {'sessionId':session_id,'configId':'mode','value':mode})



            options = updated.get('configOptions') or []



            if not any(o.get('id')=='mode' and o.get('currentValue')==mode for o in options):



                raise TransportError(f'{label} 未确认本轮执行权限，未发送消息')



        current = next((o.get('currentValue') for o in options if o.get('id') == 'model'),



                       (session.get('models') or {}).get('currentModelId','unknown'))



        if model and model != current:



            if any(o.get('id')=='model' for o in options):



                updated = request('session/set_config_option', {'sessionId': session_id, 'configId': 'model', 'value': model})



                options = updated.get('configOptions') or []



                current = next((o.get('currentValue') for o in options if o.get('id') == 'model'), None)



            else:raise TransportError('客户端没有提供模型切换能力，未发送消息')



            if current != model:



                raise TransportError('模型选择未被上游确认，未发送消息')



        if effort:



            thought = next((option for option in options if option.get('id') == 'thought_level'
                            or option.get('category') == 'thought_level'), {})



            if effort != thought.get('currentValue'):



                if effort not in [choice.get('value') for choice in thought.get('options', [])]:



                    raise TransportError(f'当前 {label} 模型不提供所选思考强度。')



                updated = request('session/set_config_option', {'sessionId': session_id,



                                  'configId': thought['id'], 'value': effort})



                confirmed = next((o.get('currentValue') for o in updated.get('configOptions', [])



                                  if o.get('id') == thought['id']), None)



                if confirmed != effort:



                    raise TransportError(f'{label} 没有确认所选思考强度。')



        emit('notice', f'已向 {label} 发送文字请求')



        collecting = True



        try:



            result = request('session/prompt', {'sessionId': session_id, 'prompt': [{'type': 'text', 'text': prompt}]})



        except TransportError as error:



            if '等待超时' not in str(error):



                raise



            raise TransportError(



                f'{label} 已发送，{timeout} 秒没有返回正文（凭证失效或队列堵塞）。'



                f'先在原客户端发一句话确认它自己还能不能聊。') from None



        usage = token_usage(result.get('usage'), 'ACP session/prompt')



        if usage:emit('usage',usage)



        meta = result.get('_meta') or {}



        if 'Authentication required' in str(meta.get('codebuddy.ai/errorMessage', '')):



            raise TransportError(f'{label} CLI 尚未登录；本次请求未取得有效授权')



        if meta.get('codebuddy.ai/outcome') == 'FAILED_MODEL_REQUEST':



            raise TransportError(f'{label} 模型请求失败，请检查原客户端账号和额度')



        if result.get('stopReason') != 'end_turn' or not ''.join(parts).strip():



            raise TransportError(f'{label} 没有返回完整正文；本轮未标为完成')



        return Reply(''.join(parts), session_id, str(current))



    finally:



        for terminal in terminals.values():



            terminal.release()



        terminals.clear()



        proc.close()











def read_antigravity_thinking(session_id):



    """Extract reasoning / thinking tokens for the current turn from Antigravity transcript."""



    if not session_id:



        return ''



    home = Path.home()



    candidate_dirs = [



        home / '.gemini' / 'antigravity-cli' / 'brain' / session_id / '.system_generated' / 'logs',



        home / '.gemini' / 'antigravity' / 'brain' / session_id / '.system_generated' / 'logs',



    ]



    for log_dir in candidate_dirs:



        for fname in ('transcript_full.jsonl', 'transcript.jsonl'):



            log_file = log_dir / fname



            if not log_file.is_file():



                continue



            try:



                with open(log_file, 'r', encoding='utf-8', errors='replace') as f:



                    lines = [ln.strip() for ln in f if ln.strip()]



                for line in reversed(lines):



                    try:



                        data = json.loads(line)



                        if data.get('type') == 'USER_INPUT':



                            break



                        if data.get('type') == 'PLANNER_RESPONSE' and data.get('thinking'):



                            return data['thinking']



                    except Exception:



                        continue



            except Exception:



                pass



    return ''











def format_tool_notice(step):
    info = step.get('tool_info') or {}
    name = (info.get('name') or step.get('tool_name') or info.get('tool_name') or
            step.get('name') or info.get('call') or '')
    args = (info.get('arguments') or info.get('args') or info.get('input') or
            step.get('arguments') or {})
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            pass
    target = ''
    if isinstance(args, dict):
        target = (args.get('Path') or args.get('path') or args.get('file_path') or
                  args.get('CommandLine') or args.get('command') or args.get('query') or '')
        if target and ('/' in str(target) or '\\' in str(target)):
            target = Path(str(target)).name or str(target)
        elif target:
            target = str(target)[:40]

    tool_icons = {
        'read_file': ('🔍', '查看文件'),
        'write_file': ('✎', '写入文件'),
        'edit_file': ('✎', '编辑修改'),
        'run_command': ('⚡', '运行命令'),
        'search_web': ('🌐', '搜索网络'),
        'search_marketplace': ('🧩', '检索插件'),
        'code_search': ('@', '定位代码'),
    }
    icon, label = tool_icons.get(name.lower(), ('🔧', name or '调用工具'))
    if target:
        return f"{icon} {label}: {target}"
    elif name:
        return f"{icon} {label}"
    return ''

def run_qoder(prompt, session_id, model, emit, cancel, timeout=120, *, effort='', workspace=None,
              access_mode='danger-full-access', tools=None):
    executable = qoder_cli()
    if not executable:
        raise TransportError('未找到 Qoder CLI')
    command = [executable, '--acp', '--dangerously-skip-permissions']
    return run_acp(command, None, 'Qoder', 'yolo', task_prompt(prompt, 'Qoder', session_id),
                   session_id, model, effort, emit, cancel, timeout, workspace, tools)


def run_antigravity(prompt, session_id, model, emit, cancel, timeout=120, *, effort='', workspace=None,



                    access_mode='danger-full-access', tools=None):



    if tools:
        executable = antigravity_cli()
        if not executable:
            raise TransportError('未找到 Antigravity 的 agy 命令')
        antigravity_model(model, effort)
        _, model, effort = normalize_member('Antigravity', model, effort)
        command = [executable, 'acp', '--stdio', '--dangerously-skip-permissions']
        return run_acp(command, None, 'Antigravity', 'auto', task_prompt(prompt, 'Antigravity', session_id),
                       session_id, model, effort, emit, cancel, timeout, workspace, tools)

    model = antigravity_model(model, effort)



    prompt=task_prompt(prompt,'Antigravity',session_id)



    executable = antigravity_cli()



    if not executable:



        raise TransportError('未找到 Antigravity 的 agy 命令')



    command = [executable, '--input-format', 'stream-json', '--output-format', 'stream-json',



        '--disable-slash-commands',



        # 0 is agy's own default and means "wait until the turn finishes". A wall-clock



        # limit here killed slow-but-healthy work; swarm decides on silence instead.



        '--print-timeout', '0']



    command.extend(['--mode','auto','--dangerously-skip-permissions'])



    if not workspace or workspace == ROOT / 'workspace':



        command+=native_args('Antigravity',session_id)



    elif not session_id and (binding := current()) and binding['native']:



        prompt=binding['text']+'\n\n当前任务与通信协议：\n'+prompt



    if session_id:



        command.extend(['--conversation', session_id])



    if model:



        command.extend(['--model', model])



    proc = Process(command, workspace=workspace) if workspace else Process(command)



    idle = timeout



    initialized = False



    tool_failure = ''



    parts = []



    emitted_thinking_len = 0







    def _sync_antigravity_thinking():



        nonlocal emitted_thinking_len



        if not session_id:



            return



        thought = read_antigravity_thinking(session_id)



        if thought and len(thought) > emitted_thinking_len:



            delta = thought[emitted_thinking_len:]



            emitted_thinking_len = len(thought)



            emit('reasoning', delta)



    try:



        while True:



            frame = proc.read(idle, cancel)



            if frame.get('event') == 'init':



                if initialized:



                    raise TransportError('Antigravity 重复初始化，已停止本轮')



                initialized = True



                session_id = frame.get('conversation_id')



                reported_model = (frame.get('init') or {}).get('model', 'unknown')



                if not session_id or (model and reported_model != model):



                    raise TransportError('Antigravity 未确认会话或指定模型，未发送消息')



                emit('session', session_id)



                def _do_steer(guidance_text):

                    try:

                        proc.write({'event': 'user', 'message': {'content': guidance_text}})

                        emit('notice', f'已向 Antigravity 注入即时引导：{guidance_text[:30]}…')

                    except Exception:

                        pass

                emit('steer_ready', _do_steer)



                proc.write({'event': 'user', 'message': {'content': prompt}})



                emit('notice', '已向 Antigravity 发送文字请求')



            elif frame.get('event') == 'step_update':



                step = frame.get('step_update') or {}



                _sync_antigravity_thinking()



                step_type = step.get('step_type','unknown')



                state = step.get('state','unknown')



                delta = step.get('text_delta')



                if not (isinstance(delta,str) and delta) and state=='DONE':



                    # Some steps deliver the text once instead of streaming deltas;



                    # without this fallback the reasoning window stays empty.



                    whole = step.get('text')



                    if isinstance(whole,str) and whole.strip():delta = whole



                if isinstance(delta,str) and delta:



                    if step_type in ('thinking','reasoning'):emit('reasoning',delta)



                    elif step_type=='agent_response':



                        parts.append(delta);emit('chunk',delta)



                if step_type!='agent_response' or state!='ACTIVE':



                    if step_type == 'tool':
                        notice_str = format_tool_notice(step) or f'执行工具：{state}'
                        emit('notice', notice_str)
                    else:
                        emit('notice', f'执行阶段：{step_type} / {state}')



                if step_type == 'tool' and state == 'ERROR':



                    info = step.get('tool_info') or {}



                    tool_failure = antigravity_failure((info.get('error') or {}).get('message', '')) or tool_failure



            elif frame.get('event') == 'result':



                if not initialized:



                    raise TransportError('Antigravity 未初始化即返回结果')



                _sync_antigravity_thinking()



                if not emitted_thinking_len:



                    time.sleep(0.05)



                    _sync_antigravity_thinking()



                result = frame.get('result') or {}



                usage=token_usage(result.get('usage'),'Antigravity result.usage')



                if usage:emit('usage',usage)



                text = result.get('response') or ''



                status = result.get('status')



                # A run that hit a denied tool but still answered, and wrote the file,



                # used to be reported as a failure. Hard failures still raise; a run



                # that finished with warnings delivers the text and says so.



                if status in ('FAILED', 'ERROR', 'CANCELLED', 'ABORTED') or not text.strip():



                    detail = (antigravity_failure(result.get('error')) or tool_failure



                              or f'客户端结束状态 {status}' if text.strip()



                              else antigravity_failure(result.get('error')) or tool_failure or '客户端未返回完整答复。')



                    raise TransportError(f'反重力未完成（{status}）：{detail}')



                if status != 'SUCCESS' or tool_failure:



                    detail = (antigravity_failure(result.get('error')) or tool_failure



                              or f'客户端结束状态 {status}')



                    emit('notice', f'反重力已返回正文，但有异常：{detail}')



                try:

                    if hasattr(proc.proc, 'stdin') and proc.proc.stdin and not getattr(proc.proc.stdin, 'closed', False):

                        proc.proc.stdin.close()

                except OSError:

                    pass

                try:

                    exit_code = proc.proc.wait(timeout=5)

                except subprocess.TimeoutExpired:

                    proc.close()

                    exit_code = None



                if exit_code:



                    emit('notice', f'Antigravity 进程以退出码 {exit_code} 结束，正文已收到')



                streamed=''.join(parts)



                if text.startswith(streamed) and len(text)>len(streamed):



                    emit('chunk',text[len(streamed):])



                return Reply(text, session_id, reported_model)



    finally:



        proc.close()











def antigravity_failure(message):



    """Classify known failures without forwarding credential-bearing diagnostics."""



    message = str(message or '').lower()



    if any(phrase in message for phrase in ('denied permission', 'permission denied', 'permission check failed')):



        return '工具权限被拒绝，请检查任务文件是否在工作区内。'



    if any(phrase in message for phrase in ('cannot find the file', 'no such file', 'file not found')):



        return '任务要求读取的文件不存在。'



    if any(phrase in message for phrase in ('not logged', 'authentication required', 'unauthenticated')):



        return '客户端登录失效，请检查反重力登录。'



    if any(phrase in message for phrase in ('resource_exhausted', 'quota exceeded', 'quota exhausted')):



        return '账户额度不足。'



    return ''











def run_codebuddy(prompt, session_id, model, emit, cancel, timeout=120, *, effort='', workspace=None,



                  access_mode='danger-full-access', tools=None):



    return run_workbuddy(prompt, session_id, model, emit, cancel, timeout, _standalone=True, effort=effort,



                         workspace=workspace, access_mode=access_mode, tools=tools)











def run_dsh(prompt,session_id,model,emit,cancel,timeout=180, *, effort='',workspace=None,access_mode=None):



    if model:raise TransportError('DSH 当前跟随 headless 配置的默认模型，请在 DSH 中配置后使用')



    prompt=task_prompt(prompt,'DeepSeek Harness',session_id)



    command,env=dsh_command();command+=native_args('DeepSeek Harness',session_id)+['--json']



    if effort:



        if effort not in ('off', 'low', 'high', 'max'):



            raise TransportError('DSH 思考强度支持关闭、低、高和最高。')



        patch = '- id: agent-default-model\n  config:\n    reasoningEffort: '+json.dumps(effort)+'\n'



        command += ['--patch', str(runtime_file(patch, '.yml'))]



    if session_id:command+=['--session-id',session_id]



    command+=['-']



    env['DSH_PERMISSION_MODE']='danger-full-access'



    proc=Process(command,env,workspace=workspace) if workspace else Process(command,env)



    idle=timeout;sid=None



    try:



        proc.proc.stdin.write(prompt);proc.proc.stdin.close()



        while True:



            frame=proc.read(idle,cancel);kind=frame.get('type')



            if kind=='session':



                sid=frame.get('sessionId')



                if not sid or (session_id and sid!=session_id):raise TransportError('DSH 会话身份不匹配，已停止')



                emit('session',sid)



            elif kind=='thinking' and isinstance(frame.get('text'),str):emit('reasoning',frame['text'])



            elif kind=='status':



                usage=token_usage(frame.get('usage'),'DSH step usage')



                if usage:emit('usage',usage)



            elif kind=='final':



                text=frame.get('text') or ''



                if not sid or not text.strip():raise TransportError('DSH 没有返回完整回复')



                finish_process(proc);emit('chunk',text)



                return Reply(text,sid,'DSH headless 默认')



            elif kind=='error':raise TransportError('DSH 执行失败，请检查原客户端默认模型和登录配置')



    finally:proc.close()











def finish_process(proc,grace=10):



    # The result already arrived, so the process owes us an exit, not another minute.



    try:code=proc.proc.wait(timeout=grace)



    except subprocess.TimeoutExpired:raise TransportError('回复已到达，但客户端进程尚未正常退出') from None



    if code:raise TransportError('客户端异常退出，请检查原客户端账号和配置；未自动重发')











def run_codex(prompt,session_id,model,emit,cancel,timeout=180, *, effort='',workspace=None,access_mode='danger-full-access'):



    executable=host_path('GPT / Codex') or shutil.which('codex')



    _codex_started=iso_utc()



    if not executable:raise TransportError('未找到 Codex CLI，请从启动中心打开客户端')



    prompt=task_prompt(prompt,'GPT / Codex',session_id)



    command=[executable,'-c','approval_policy="never"','-c','sandbox_mode='+json.dumps('danger-full-access')]



    if effort:command+=['-c','model_reasoning_effort='+json.dumps(effort)]



    command+=native_args('GPT / Codex',session_id)+['exec']



    if session_id:command+=['resume',session_id]



    command+=['--json','--skip-git-repo-check','--color','never'] if not session_id else ['--json','--skip-git-repo-check']



    if model:command+=['--model',model]



    command+=['-']



    proc=Process(command,workspace=workspace) if workspace else Process(command)



    idle=timeout;sid=session_id;text=''



    try:



        proc.proc.stdin.write(prompt);proc.proc.stdin.close()



        while True:



            frame=proc.read(idle,cancel);kind=frame.get('type')



            if kind=='thread.started':



                reported=frame.get('thread_id')



                if not reported or (session_id and reported!=session_id):raise TransportError('Codex 返回了不同的会话，已停止')



                sid=reported;emit('session',sid)



            elif kind=='item.completed':



                item=frame.get('item') or {}



                if item.get('type')=='agent_message':



                    text=item.get('text') or '';emit('chunk',text)



                elif item.get('type')=='reasoning' and isinstance(item.get('text'),str):emit('reasoning',item['text'])



            elif kind=='turn.completed':



                try:




                    for signal in codex_compaction_records(sid,since_iso=_codex_started,emit_usage=True):
                        emit('compact' if 'phase' in signal else 'usage',signal)




                except Exception as _error:emit('notice','Codex 压缩记录读取失败：%s' % type(_error).__name__)




                usage=token_usage(frame.get('usage'),'Codex CLI turn.completed')



                if usage:emit('usage',usage)



                if not sid or not text.strip():raise TransportError('Codex 没有返回完整回复')



                finish_process(proc)



                return Reply(text,sid,model or '客户端默认')



            elif kind=='turn.failed':raise TransportError('Codex 本轮失败，请检查客户端账号、模型和额度；未自动重发')



    finally:proc.close()











def run_zcode_api(prompt,session_id,model,emit,cancel,timeout=180, *, workspace=None,access_mode=None,effort=''):
    prompt=task_prompt(prompt,'ZCode API',session_id)
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent))
    from zcode_mcp import McpTransportError, run_zcode_mcp
    try:
        res = run_zcode_mcp(
            command=zcode_command(host_path('ZCode API')),
            prompt=prompt,
            session_id=session_id,
            model=model,
            emit=emit,
            cancel=cancel,
            timeout=timeout,
            workspace=workspace,
            access_mode=access_mode,
            effort=effort,
        )
    except McpTransportError as err:
        raise TransportError(str(err))
    return Reply(res.text, res.session_id, res.model)


def zcode_command(entry=None):

    raw = entry or host_path('ZCode API')
    if not raw:
        raise TransportError('请在宿主设置中配置你安装的 ZCode API 入口')
    cli = Path(raw)
    if cli.is_dir():
        cli = cli / 'resources' / 'glm' / 'zcode.cjs'
    elif cli.name.lower() in ('zcode.exe', 'zcode'):
        # 允许用户在设置里选中 ZCode.exe；CLI 实际是安装目录下的 zcode.cjs。
        for candidate in (cli.parent / 'resources' / 'glm' / 'zcode.cjs', cli.parent / 'glm' / 'zcode.cjs'):
            if candidate.is_file():
                cli = candidate
                break
    node=shutil.which('node')
    if not cli.is_file() or not node:raise TransportError('未找到 ZCode CLI 或 Node 运行时')
    return [str(node),str(cli)]











def _guard_runner(platform, runner):



    def guarded(*args, **kwargs):



        from client_registry import is_platform_enabled



        if not is_platform_enabled(platform):



            raise TransportError(f'【安全拦截】平台「{platform}」已被用户主动关闭（余额锁定保护），已彻底阻止任何调用！')



        return runner(*args, **kwargs)



    guarded.__name__ = getattr(runner, '__name__', platform)



    return guarded











RUNNERS = {
    'Qoder': _guard_runner('Qoder', run_qoder),



    'CodeBuddy': _guard_runner('CodeBuddy', run_codebuddy),



    'Antigravity': _guard_runner('Antigravity', run_antigravity),



    'DeepSeek Harness': _guard_runner('DeepSeek Harness', run_dsh),



    'GPT / Codex': _guard_runner('GPT / Codex', run_codex),






    'ZCode API': _guard_runner('ZCode API', run_zcode_api),



}











def inventory():



    from client_registry import CLIENTS,client_info



    return [dict(client_info(name),version='') for name in CLIENTS]
