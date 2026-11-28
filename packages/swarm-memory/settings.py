"""Where the project keeps its memory.

Memory follows the project: <workspace>/.swarm/memory.sqlite3. Without a workspace the
app falls back to data/memory.sqlite3, so nothing breaks before a project is chosen.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / 'data' / 'preferences.json'
FALLBACK = ROOT / 'data' / 'memory.sqlite3'


def read():
    try:
        return json.loads(CONFIG.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def write(**values):
    data = read()
    data.update(values)
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(CONFIG)


def memory_path(workspace=None):
    """One database per project, stored beside the project's own files."""
    folder = str(workspace or '').strip()
    if folder:
        path = Path(folder)
        if path.is_absolute() and path.is_dir():
            return path / '.swarm' / 'memory.sqlite3'
    return FALLBACK


def ensure_memory(path, legacy=None):
    """Create an EMPTY per-project database.

    The previous version copied the whole old global database into every new
    project. That never worked: sources/entries are keyed by a random
    ``project_id`` that is generated per project, so a fresh project's
    ``packet()`` found nothing while its file silently carried another
    project's private data. A project starts clean; continuity comes from
    ``missions.project_id_for`` reusing the identity of the last mission in the
    same working directory. The old global file is left untouched.
    """
    path = Path(path)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
