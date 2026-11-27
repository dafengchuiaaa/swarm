"""Local availability only. Opening this registry never calls a model."""
from pathlib import Path
import os
import shutil
import json

DATA_DIR = Path(os.environ.get('SWARM_DATA_DIR') or Path(os.environ.get('APPDATA') or Path.home()) / 'SwarmIndependent')
PREFERENCES_FILE = DATA_DIR / 'preferences.json'
ANTIGRAVITY_BINDING = DATA_DIR / 'antigravity-cli.txt'
QODER_EXE = Path.home() / '.qoder/bin/qodercli/qodercli.exe'

CLIENTS = {
    'CodeBuddy': str(Path.home() / 'AppData/Local/Programs/CodeBuddyCLI/bin/codebuddy.exe'),
    'DeepSeek Harness': str(Path.home() / 'AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'),
    'GPT / Codex': 'codex-app',
    'ZCode API': str(Path.home() / 'AppData/Local/Programs/ZCode/resources/glm/zcode.cjs'),
    'Antigravity': str(Path.home() / 'AppData/Local/Programs/antigravity/Antigravity.exe'),
    'Qoder': str(QODER_EXE),
    '豆包': str(Path.home() / 'AppData/Local/Programs/Doubao/Doubao.exe'),
    'Gemini': str(Path.home() / 'AppData/Local/Google/Gemini/Gemini.exe'),
    '元宝': str(Path.home() / 'AppData/Local/Programs/Yuanbao/yuanbao.exe'),
}

NOTES = {
    'CodeBuddy': '后台会话；模型来自客户端公布的选项。',
    'DeepSeek Harness': '支持新会话与续接；模型跟随 DSH headless 配置，未接管桌面旧会话。',
    'GPT / Codex': '复用 Codex CLI 登录，支持新会话、续接与模型选择；不等于当前桌面聊天。',
    'ZCode API': '标准 MCP/API 入口：走 zcode app-server，使用 ZCode CLI 配置的 API Key/模型；不占用桌面端体验套餐。',
    'Antigravity': '后台 CLI 会话，支持模型选择；桌面旧会话接续仍有边界。',
    'Qoder': '复用 Qoder CLI 的本机登录，支持模型选择与会话续接。',
    'Gemini': '本机安装为 Gemini 网页桌面壳；未发现后台聊天 CLI。可打开客户端，尚未接入蜂群聊天。',
    '豆包': '已找到任务模式的浏览器 / 电脑工具组件，尚未确认外部聊天入口；目前可打开客户端。',
}


def get_disabled_platforms():
    """Return set of platforms explicitly turned off by the user to prevent autonomous usage."""
    path = PREFERENCES_FILE
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return set(data.get('disabled_platforms', []))
        except Exception:
            return set()
    return set()


def host_path(platform):
    if PREFERENCES_FILE.is_file():
        data = json.loads(PREFERENCES_FILE.read_text(encoding='utf-8'))
        return data.get('host_paths', {}).get(platform)
    return None


def validate_host_path(platform, value):
    if not value:
        return None
    path = Path(value).expanduser()
    suffixes = {'.cjs', '.js', '.exe'} if platform in ('ZCode', 'ZCode API') else {'.exe'} if platform == 'Qoder' else {'.exe', '.cmd'}
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in suffixes:
        labels = 'ZCode.exe 或 zcode.cjs 本地入口' if platform in ('ZCode', 'ZCode API') else '已存在的本机可执行文件'
        raise ValueError(f'请选择{labels}')
    return str(path.resolve())


def set_host_path(platform, value):
    value = validate_host_path(platform, value)
    data = json.loads(PREFERENCES_FILE.read_text(encoding='utf-8')) if PREFERENCES_FILE.is_file() else {}
    data.setdefault('disabled_platforms', sorted(get_disabled_platforms()))
    paths = data.setdefault('host_paths', {})
    if value:
        paths[platform] = value
    else:
        paths.pop(platform, None)
    save_preferences(data)


def qoder_cli():
    return host_path('Qoder') or (str(QODER_EXE) if QODER_EXE.is_file() else shutil.which('qodercli.exe'))


def save_preferences(data):
    PREFERENCES_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = PREFERENCES_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(PREFERENCES_FILE)


def is_platform_enabled(platform):
    """Check if a platform is enabled for scheduling and autonomous calling."""
    return platform not in get_disabled_platforms()


def set_platform_enabled(platform, enabled):
    """Enable or disable a platform to guard against unwanted balance / token drain."""
    PREFERENCES_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if PREFERENCES_FILE.is_file():
        try:
            data = json.loads(PREFERENCES_FILE.read_text(encoding='utf-8'))
        except Exception:
            pass
    disabled = get_disabled_platforms()
    if enabled:
        disabled.discard(platform)
    else:
        disabled.add(platform)
    data['disabled_platforms'] = sorted(list(disabled))
    save_preferences(data)


def antigravity_cli():
    if bound := host_path('Antigravity'):
        return bound if Path(bound).is_file() else None
    if ANTIGRAVITY_BINDING.is_file():
        bound = Path(ANTIGRAVITY_BINDING.read_text(encoding='utf-8').strip())
        if bound.is_file():
            return str(bound)
    executable = shutil.which('agy')
    if executable:
        return executable
    suffix = Path('agy/bin/agy.exe')
    local = os.environ.get('LOCALAPPDATA')
    if local and (Path(local) / suffix).is_file():
        return str(Path(local) / suffix)
    if os.name == 'nt':
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r'Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders') as key:
                local = winreg.QueryValueEx(key, 'Local AppData')[0]
            installed = Path(local) / suffix
            if installed.is_file():
                return str(installed)
        except OSError:
            pass
    installed = Path.home() / 'AppData/Local' / suffix
    return str(installed) if installed.is_file() else None


def bind_antigravity_cli(filename):
    path = Path(filename).resolve()
    if path.name.lower() != 'agy.exe' or not path.is_file():
        raise ValueError('请选择已安装的 agy.exe。')
    ANTIGRAVITY_BINDING.parent.mkdir(parents=True, exist_ok=True)
    temporary = ANTIGRAVITY_BINDING.with_suffix('.tmp')
    temporary.write_text(str(path), encoding='utf-8')
    temporary.replace(ANTIGRAVITY_BINDING)


def client_info(name):
    from adapters import RUNNERS
    path = CLIENTS.get(name, '')
    installed = bool(shutil.which('codex')) if path == 'codex-app' else Path(path).is_file()
    cli = installed
    if name == 'Antigravity':
        cli = bool(antigravity_cli())
    if name == 'CodeBuddy':
        cli = installed or bool(shutil.which('codebuddy'))
    if name == 'Qoder':
        cli = bool(qoder_cli())
    custom = host_path(name)
    if custom:
        cli = Path(custom).is_file()
    if name == 'ZCode API':
        cli = bool(custom and Path(custom).is_file() and shutil.which('node'))
    supported = name in RUNNERS
    enabled = is_platform_enabled(name)
    ready = supported and cli and enabled
    if not enabled:
        state = '已关闭（锁定保护）'
        note = '已在开关设置中完全关闭该平台，防止模型自主调用消耗余额。'
    else:
        state = 'CLI就绪' if supported and cli else '待接入' if installed else '未找到安装'
        note = NOTES.get(name, '可打开原客户端，后台会话接口尚未接入。')
        if name == 'Antigravity' and not cli:
            note = '请在「负责人和子 Agent」里点「连接反重力」，选择已安装的 agy.exe。'
    return {
        'name': name, 'path': path, 'installed': installed, 'adapter': supported,
        'enabled': enabled, 'ready': ready, 'state': state, 'note': note, 'customPath': custom
    }
