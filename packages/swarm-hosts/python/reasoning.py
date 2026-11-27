"""Member reasoning choices and the native Antigravity model mapping."""
import json
from functools import lru_cache
from pathlib import Path


GEMINI_FLASH = 'gemini-3.8-flash'
GEMINI_LEVELS = ('low', 'medium', 'high')
LABELS = {'': '默认', 'off': '关闭', 'none': '关闭', 'minimal': '极低',
          'low': '低', 'medium': '中等推理', 'high': '高', 'xhigh': '很高',
          'max': '最高', 'ultra': 'Ultra', 'enabled': '开启'}


def normalize_member(platform, model, effort=''):
    if platform == 'Antigravity':
        prefix = GEMINI_FLASH + '-'
        if model.startswith(prefix) and model[len(prefix):] in GEMINI_LEVELS:
            return platform, GEMINI_FLASH, model[len(prefix):]
        if model == GEMINI_FLASH:
            return platform, model, effort or 'medium'
    return platform, model, effort


def antigravity_model(model, effort):
    _, model, effort = normalize_member('Antigravity', model, effort)
    if model == GEMINI_FLASH:
        if effort not in GEMINI_LEVELS:
            raise ValueError('Gemini 3.8 Flash 的思考强度只能选择低、中或高。')
        return f'{model}-{effort}'
    if effort:
        raise ValueError('当前反重力模型不支持单独设置思考强度。')
    return model


@lru_cache(maxsize=2)
def read_catalog(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def effort_options(platform, model):
    if platform == 'Antigravity' and model == GEMINI_FLASH:
        levels = GEMINI_LEVELS
    elif platform == 'DeepSeek Harness':
        levels = ('', 'off', 'low', 'high', 'max')
    elif platform == 'CodeBuddy':
        path = Path(__file__).resolve().parent / 'data/model-catalog.json'
        catalog = read_catalog(path)
        levels = ('', *catalog.get('CodeBuddyThoughtLevels', {}).get(model, []))
    elif platform == 'GPT / Codex':
        path = Path.home() / '.codex/models_cache.json'
        catalog = read_catalog(path)
        entry = next((item for item in catalog.get('models', []) if item.get('slug') == model), {})
        levels = ('', *(level['effort'] for level in entry.get('supported_reasoning_levels', [])))
    else:
        levels = ('',)
    return [(LABELS.get(level, level), level) for level in levels]
