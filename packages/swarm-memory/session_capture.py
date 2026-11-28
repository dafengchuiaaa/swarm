"""Collect changed local transcripts for the project memory organizer."""
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import unquote, urlsplit


MAX_LINE_BYTES = 16 * 1024 * 1024
MAX_MESSAGE_CHARS = 12000
MAX_BATCH_BYTES = 16 * 1024 * 1024


def transcript_files(home, errors):
    roots = [
        ('Codex', home / '.codex/sessions', '**/rollout-*.jsonl'),
        ('Qoder', home / '.qoder/projects', '*/*.jsonl'),
        ('CodeBuddy', home / '.codebuddy/projects', '*/*.jsonl'),
        ('WorkBuddy', home / '.workbuddy/projects', '*/*.jsonl'),
    ]
    if codebuddy_projects := os.environ.get('SWARM_CODEBUDDY_PROJECTS'):
        roots.append(('CodeBuddy', Path(codebuddy_projects).expanduser(), '*/*.jsonl'))
    for host, root, pattern in roots:
        for file in root.glob(pattern):
            if not file.is_symlink():
                yield host, file, '', ''

    for name in ('antigravity-cli', 'antigravity', 'antigravity-ide'):
        root = home / '.gemini' / name
        index = root / 'conversation_summaries.db'
        if not index.is_file():
            continue
        try:
            with closing(sqlite3.connect(index.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                rows = db.execute('SELECT conversation_id, workspace_uris FROM conversation_summaries'
                                  ' WHERE not_fully_idle = 0').fetchall()
        except sqlite3.Error as error:
            errors.append({'host': 'Antigravity', 'file': name, 'error': str(error)})
            continue
        for sid, uris in rows:
            if not sid or Path(sid).name != sid:
                continue
            try:
                folders = json.loads(uris)
            except (ValueError, TypeError):
                continue
            if not isinstance(folders, list) or len(folders) != 1 or not isinstance(folders[0], str):
                continue
            uri = urlsplit(folders[0])
            if uri.scheme != 'file' or uri.netloc not in ('', 'localhost'):
                continue
            workspace = unquote(uri.path)
            if os.name == 'nt' and workspace[2:3] == ':':
                workspace = workspace[1:]
            logs = root / 'brain' / sid / '.system_generated/logs'
            full = logs / 'transcript_full.jsonl'
            file = full if full.is_file() else logs / 'transcript.jsonl'
            if file.is_file() and not file.is_symlink():
                yield 'Antigravity', file, sid, workspace


def message_text(content):
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ''
    return '\n'.join(item['text'] for item in content if isinstance(item, dict)
                     and item.get('type') in ('text', 'input_text', 'output_text')
                     and isinstance(item.get('text'), str)).strip()


def transcript_event(host, row):
    kind = row.get('type')
    if host == 'Antigravity':
        role = {'USER_INPUT': 'user', 'PLANNER_RESPONSE': 'assistant'}.get(kind)
        text = message_text(row.get('content'))
        if role == 'user' and '<USER_REQUEST>' in text and '</USER_REQUEST>' in text:
            text = text.split('<USER_REQUEST>', 1)[1].split('</USER_REQUEST>', 1)[0].strip()
        return '', '', row.get('step_index'), role, text
    if host == 'Codex':
        payload = row.get('payload') or {}
        if kind == 'session_meta':
            return payload.get('id'), payload.get('cwd'), None, None, ''
        if kind == 'turn_context':
            return '', payload.get('cwd'), None, None, ''
        if kind == 'response_item' and payload.get('type') == 'message' and payload.get('phase') != 'commentary':
            text = message_text(payload.get('content'))
            if payload.get('role') == 'user' and text.startswith(('<environment_context>', '# AGENTS.md instructions')):
                text = ''
            return '', '', payload.get('id') or row.get('ordinal'), payload.get('role'), text
        return '', '', None, None, ''
    message = row.get('message') or row
    return (row.get('sessionId'), row.get('cwd'), row.get('uuid') or row.get('id'),
            message.get('role') if kind in ('message', 'user', 'assistant') and not row.get('isSidechain') else None,
            message_text(message.get('content')))


def complete_lines(stream):
    end = stream.tell() + MAX_BATCH_BYTES
    while stream.tell() < end:
        start = stream.tell()
        line = stream.readline(MAX_LINE_BYTES + 1)
        if len(line) > MAX_LINE_BYTES:
            while line and not line.endswith(b'\n'):
                line = stream.readline(65536)
            if line:
                yield start, None
                continue
            stream.seek(start)
            return
        if not line or not line.endswith(b'\n'):
            stream.seek(start)
            return
        row = json.loads(line)
        if isinstance(row, dict):
            yield start, row


def boundary(stream, position):
    start = max(0, position - 96)
    stream.seek(start)
    return stream.read(position - start)


def collect_sessions(store, project, project_for, days, home=None):
    cutoff = time.time() - days * 86400
    cursors = store.session_cursors(project)
    added = 0
    errors = []
    for host, file, default_sid, default_cwd in transcript_files(home or Path.home(), errors):
        try:
            if default_cwd and project_for(default_cwd) != project:
                continue
            stat = file.stat()
            path = str(file)
            saved = cursors.get(path)
            if stat.st_mtime < cutoff and not saved:
                continue
            if saved and (saved['stamp'], saved['position']) == (stat.st_mtime_ns, stat.st_size):
                continue
            with file.open('rb') as stream:
                position = saved['position'] if saved else 0
                if saved and position <= stat.st_size and boundary(stream, position) == saved['boundary']:
                    sid, cwd = saved['session_id'], saved['workspace']
                else:
                    position, sid, cwd = 0, default_sid, default_cwd
                stream.seek(position)
                messages = []
                for offset, row in complete_lines(stream):
                    if row is None:
                        if cwd and project_for(cwd) == project:
                            errors.append({'host': host, 'file': file.name, 'offset': offset,
                                           'error': '跳过超长日志行，原文仍保留在宿主'})
                        continue
                    new_sid, new_cwd, event_id, role, body = transcript_event(host, row)
                    sid = new_sid or sid
                    cwd = new_cwd or cwd
                    if not saved and new_cwd and project_for(cwd) != project:
                        break
                    if role not in ('user', 'assistant') or not body or not cwd or project_for(cwd) != project:
                        continue
                    # The native path remains available for messages exceeding the memory page.
                    messages.append((str(event_id if event_id is not None else offset),
                                     host, sid or file.stem, cwd, path, role, body[:MAX_MESSAGE_CHARS],
                                     len(body) > MAX_MESSAGE_CHARS))
                position = stream.tell()
                if messages or saved or (cwd and project_for(cwd) == project):
                    added += store.commit_session_capture(project, path, stat.st_mtime_ns,
                                                          position, boundary(stream, position), sid, cwd, messages)
        except (OSError, ValueError, TypeError) as error:
            errors.append({'host': host, 'file': file.name, 'error': str(error)})
    return added, errors
