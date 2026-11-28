export interface AvatarMeta {
  id: string;
  series: string;
  name: string;
  tag: string;
  credit: string;
}

export interface CustomAvatarMeta {
  id: string;
  series: string;
  name: string;
  dataUrl: string;
}

export interface ModelSeriesInfo {
  id: string;
  label: string;
}

export const SERIES_LABELS: Record<string, string> = {
  owner: '我的头像',
  deepseek: 'DeepSeek 系列',
  claude: 'Claude 系列',
  gpt: 'GPT / Codex 系列',
  gemini: 'Gemini 系列',
  glm: '智谱 GLM 系列',
  qwen: '通义千问 系列',
  kimi: 'Kimi 系列',
  hunyuan: '腾讯混元 系列',
  minimax: 'MiniMax 系列',
  mimo: '小米 MiMo 系列',
  grok: 'Grok 系列',
  llama: 'Llama 系列',
  mistral: 'Mistral 系列',
  seed: 'Seedance 系列',
  doubao: '豆包 系列',
  stepfun: '阶跃星辰 系列',
  qoder: 'Qoder 系列',
  codebuddy: 'CodeBuddy 系列',
  other: '其他模型 系列',
};

const MODEL_SERIES_MATCHERS: [RegExp, string][] = [
  [/deepseek/i, 'deepseek'],
  [/claude/i, 'claude'],
  [/^(?:gpt|codex|o[134](?:\b|-))|\b(?:gpt|codex)\b/i, 'gpt'],
  [/gemini/i, 'gemini'],
  [/glm|zhipu|智谱/i, 'glm'],
  [/qwen|通义/i, 'qwen'],
  [/kimi|moonshot/i, 'kimi'],
  [/^(?:hy\d|hunyuan)|混元/i, 'hunyuan'],
  [/minimax/i, 'minimax'],
  [/xiaomi|mimo/i, 'mimo'],
  [/grok/i, 'grok'],
  [/llama/i, 'llama'],
  [/mistral/i, 'mistral'],
  [/doubao|豆包/i, 'doubao'],
  [/seed/i, 'seed'],
  [/step[\s-]*\d|stepfun/i, 'stepfun'],
];

const HOST_SERIES_MATCHERS: [RegExp, string][] = [
  [/deepseek/i, 'deepseek'],
  [/gpt|codex|openai/i, 'gpt'],
  [/antigravity|gemini/i, 'gemini'],
  [/zcode|glm|智谱/i, 'glm'],
  [/qoder/i, 'qoder'],
  [/codebuddy/i, 'codebuddy'],
  [/豆包|doubao/i, 'doubao'],
  [/元宝|hunyuan/i, 'hunyuan'],
];

export const AVATAR_CATALOG: readonly AvatarMeta[] = [
  { id: 'deepseek-chin-wink', series: 'deepseek', name: 'DeepSeek · 枕臂眨眼', tag: '萌系女仆', credit: '用户精选系列' },
  { id: 'deepseek-plush-hug', series: 'deepseek', name: 'DeepSeek · 抱鲸歪头', tag: '蓝鲸抱枕', credit: '用户精选系列' },
  { id: 'deepseek-glove-greet', series: 'deepseek', name: 'DeepSeek · 深海伸手', tag: '露指手套', credit: '用户精选六宫格' },
  { id: 'deepseek-tablet', series: 'deepseek', name: 'DeepSeek · 举牌一惊', tag: '星幕指令', credit: '用户精选六宫格' },
  { id: 'deepseek-bun', series: 'deepseek', name: 'DeepSeek · 幸福吃包', tag: '日常萌态', credit: '用户精选六宫格' },
  { id: 'deepseek-panic', series: 'deepseek', name: 'DeepSeek · 抓狂修Bug', tag: '蚊香眼镜', credit: '用户精选六宫格' },
  { id: 'deepseek-harbor', series: 'deepseek', name: 'DeepSeek · 海港暮色', tag: '暮色侧颜', credit: '用户精选六宫格' },
  { id: 'deepseek-wink', series: 'deepseek', name: 'DeepSeek · 眨眼比耶', tag: '蓝鲸女仆', credit: '用户精选精修六宫格' },
  { id: 'deepseek-greet', series: 'deepseek', name: 'DeepSeek · 晴空伸手', tag: '深蓝女仆', credit: '用户精选精修六宫格' },
  { id: 'deepseek-whale', series: 'deepseek', name: 'DeepSeek · 抱鲸甜笑', tag: '蓝鲸抱枕', credit: '用户精选精修六宫格' },
  { id: 'deepseek-sky', series: 'deepseek', name: 'DeepSeek · 暮空侧颜', tag: '海蓝发丝', credit: '用户精选精修六宫格' },
  { id: 'deepseek-glasses', series: 'deepseek', name: 'DeepSeek · 眼镜研读', tag: '书房女仆', credit: '用户精选精修六宫格' },
  { id: 'deepseek-holo', series: 'deepseek', name: 'DeepSeek · 智幕沉思', tag: '全息鲸屏', credit: '用户精选精修六宫格' },
  { id: 'claude-library', series: 'claude', name: 'Claude · 书房初晖', tag: '暖橘学士', credit: '用户精选' },
  { id: 'gpt-lean', series: 'gpt', name: 'GPT · 托腮浅笑', tag: '书房龙娘', credit: '用户精选六宫格' },
  { id: 'gpt-greet', series: 'gpt', name: 'GPT · 伸手致意', tag: '绿结微笑', credit: '用户精选六宫格' },
  { id: 'gpt-wink', series: 'gpt', name: 'GPT · 眨眼比耶', tag: '双丸子头', credit: '用户精选六宫格' },
  { id: 'gpt-sky', series: 'gpt', name: 'GPT · 仰望暮云', tag: '编发侧颜', credit: '用户精选六宫格' },
  { id: 'gpt-glasses', series: 'gpt', name: 'GPT · 眼镜研读', tag: '金丝眼镜', credit: '用户精选六宫格' },
  { id: 'gpt-hood', series: 'gpt', name: 'GPT · 月夜兜帽', tag: '神秘嘘声', credit: '用户精选六宫格' },
  { id: 'gemini-wink', series: 'gemini', name: 'Gemini · 双手比耶', tag: '异瞳猫耳', credit: '用户精选精修六宫格' },
  { id: 'gemini-greet', series: 'gemini', name: 'Gemini · 晴空招手', tag: '蓝紫星饰', credit: '用户精选精修六宫格' },
  { id: 'gemini-star', series: 'gemini', name: 'Gemini · 捧星甜笑', tag: '双子星核', credit: '用户精选精修六宫格' },
  { id: 'gemini-sky', series: 'gemini', name: 'Gemini · 仰望流星', tag: '星空侧颜', credit: '用户精选精修六宫格' },
  { id: 'gemini-glasses', series: 'gemini', name: 'Gemini · 眼镜研读', tag: '星典手账', credit: '用户精选精修六宫格' },
  { id: 'gemini-holo', series: 'gemini', name: 'Gemini · 全息星幕', tag: '沉思光屏', credit: '用户精选精修六宫格' },
  { id: 'glm-maid-coffee', series: 'glm', name: 'GLM · 咖啡小憩', tag: '黑白女仆', credit: '用户精选六宫格' },
  { id: 'glm-maid-lip', series: 'glm', name: 'GLM · 指尖轻笑', tag: '黑白女仆', credit: '用户精选六宫格' },
  { id: 'glm-maid-smirk', series: 'glm', name: 'GLM · 托腮浅笑', tag: '黑白女仆', credit: '用户精选六宫格' },
  { id: 'glm-maid-glasses', series: 'glm', name: 'GLM · 台灯弈书', tag: '眼镜书卷', credit: '用户精选六宫格' },
  { id: 'glm-maid-husky', series: 'glm', name: 'GLM · 抱狼甜笑', tag: 'Z标萌狼', credit: '用户精选六宫格' },
  { id: 'glm-maid-moon', series: 'glm', name: 'GLM · 月夜窗畔', tag: '黑白侧颜', credit: '用户精选六宫格' },
  { id: 'glm-smirk', series: 'glm', name: 'GLM · 托腮坏笑', tag: '紫瞳狼耳', credit: '用户精选六宫格' },
  { id: 'glm-husky', series: 'glm', name: 'GLM · 抱狼眨眼', tag: '萌狼抱枕', credit: '用户精选六宫格' },
  { id: 'glm-glasses', series: 'glm', name: 'GLM · 眼镜弈书', tag: '智谱棋局', credit: '用户精选六宫格' },
  { id: 'glm-headset', series: 'glm', name: 'GLM · 耳机沉思', tag: 'Z声浪侧颜', credit: '用户精选六宫格' },
  { id: 'glm-moon', series: 'glm', name: 'GLM · 月夜仰望', tag: '狼耳尾影', credit: '用户精选六宫格' },
  { id: 'glm-chess', series: 'glm', name: 'GLM · 执棋一笑', tag: '黑白对弈', credit: '用户精选六宫格' },
  { id: 'qwen-peek', series: 'qwen', name: '通义 · 掩扇浅笑', tag: '紫藤折扇', credit: '用户精选六宫格' },
  { id: 'qwen-fan-lean', series: 'qwen', name: '通义 · 托腮执扇', tag: '紫花国风', credit: '用户精选六宫格' },
  { id: 'qwen-wisteria', series: 'qwen', name: '通义 · 紫藤展扇', tag: '古风雅韵', credit: '用户精选六宫格' },
  { id: 'qwen-glasses', series: 'qwen', name: '通义 · 烛夜研读', tag: '眼镜书卷', credit: '用户精选六宫格' },
  { id: 'qwen-tea', series: 'qwen', name: '通义 · 月夜品茗', tag: '青花茶盏', credit: '用户精选六宫格' },
  { id: 'qwen-go', series: 'qwen', name: '通义 · 执扇对弈', tag: '黑白手谈', credit: '用户精选六宫格' },
  { id: 'kimi-moon-lean', series: 'kimi', name: 'Kimi · 月夜托腮', tag: '新月K标', credit: '用户精选' },
  { id: 'kimi-cozy', series: 'kimi', name: 'Kimi · 蜷膝微醺', tag: '月夜企鹅', credit: '用户精选' },
  { id: 'kimi-mask', series: 'kimi', name: 'Kimi · 兜帽耳机', tag: '赛博面罩', credit: '用户精选' },
  { id: 'kimi-chibi-head', series: 'kimi', name: 'Kimi · 炫酷耳机', tag: '墨镜Q版', credit: '用户精选' },
  { id: 'kimi-chair', series: 'kimi', name: 'Kimi · 电竞椅托腮', tag: '月亮企鹅', credit: '用户精选' },
  { id: 'kimi-balcony', series: 'kimi', name: 'Kimi · 阳台夜望', tag: '都市满月', credit: '用户精选' },
  { id: 'kimi-bubblegum', series: 'kimi', name: 'Kimi · 吹泡泡糖', tag: '慵懒街头', credit: '用户精选六宫格' },
  { id: 'kimi-rain', series: 'kimi', name: 'Kimi · 雨夜霓虹', tag: '侧颜仰望', credit: '用户精选六宫格' },
  { id: 'kimi-chips', series: 'kimi', name: 'Kimi · 炫薯片', tag: '像素K屏', credit: '用户精选六宫格' },
  { id: 'kimi-chibi-deal', series: 'kimi', name: 'Kimi · 像素墨镜', tag: 'Q版皇冠', credit: '用户精选六宫格' },
  { id: 'kimi-sunglasses', series: 'kimi', name: 'Kimi · 墨镜挑眉', tag: '棒棒糖', credit: '用户精选六宫格' },
  { id: 'kimi-moon-sky', series: 'kimi', name: 'Kimi · 月下侧颜', tag: '银发飞扬', credit: '用户精选六宫格' },
  { id: 'kimi-ramen', series: 'kimi', name: 'Kimi · 快乐吃面', tag: '夜宵企鹅', credit: '用户精选六宫格' },
  { id: 'kimi-glasses', series: 'kimi', name: 'Kimi · 眼镜看屏', tag: '蓝光K标', credit: '用户精选六宫格' },
  { id: 'hunyuan-neon', series: 'hunyuan', name: '混元 · 霓虹仰望', tag: '赛博夜雨', credit: '用户精选六宫格' },
  { id: 'hunyuan-orb', series: 'hunyuan', name: '混元 · 星涡掌灯', tag: '星云光球', credit: '用户精选六宫格' },
  { id: 'hunyuan-plum', series: 'hunyuan', name: '混元 · 墨梅静坐', tag: '水墨印章', credit: '用户精选六宫格' },
  { id: 'hunyuan-taiji', series: 'hunyuan', name: '混元 · 太极企鹅', tag: '水墨国风', credit: '用户精选六宫格' },
  { id: 'hunyuan-lantern', series: 'hunyuan', name: '混元 · 花灯夜望', tag: '暮色楼阁', credit: '用户精选六宫格' },
  { id: 'hunyuan-chibi', series: 'hunyuan', name: '混元 · Q版比耶', tag: '怀抱企鹅', credit: '用户精选六宫格' },
  { id: 'hunyuan-cyber', series: 'hunyuan', name: '混元 · 赛博全息', tag: '蓝光护目镜', credit: '用户精选六宫格' },
  { id: 'hunyuan-ink', series: 'hunyuan', name: '混元 · 水墨红梅', tag: '写意留白', credit: '用户精选六宫格' },
  { id: 'hunyuan-moon', series: 'hunyuan', name: '混元 · 星空满月', tag: '夜望侧颜', credit: '用户精选六宫格' },
] as const;

export interface AvatarResolveInput {
  targetKey?: string;
  sender?: string;
  host?: string;
  model?: string;
  label?: string;
}

export function resolveModelSeries(input: AvatarResolveInput): ModelSeriesInfo {
  if (input.sender === 'owner' || input.targetKey === 'owner') {
    return { id: 'owner', label: SERIES_LABELS.owner };
  }

  const model = (input.model ?? '').trim();
  for (const [pattern, seriesId] of MODEL_SERIES_MATCHERS) {
    if (pattern.test(model)) {
      return { id: seriesId, label: SERIES_LABELS[seriesId] ?? seriesId };
    }
  }

  const host = (input.host ?? '').trim();
  for (const [pattern, seriesId] of HOST_SERIES_MATCHERS) {
    if (pattern.test(host)) {
      return { id: seriesId, label: SERIES_LABELS[seriesId] ?? seriesId };
    }
  }

  const label = (input.label ?? '').trim();
  for (const [pattern, seriesId] of MODEL_SERIES_MATCHERS) {
    if (pattern.test(label)) {
      return { id: seriesId, label: SERIES_LABELS[seriesId] ?? seriesId };
    }
  }

  return { id: 'other', label: SERIES_LABELS.other };
}

export interface SeriesLibraryEntry {
  id: string;
  series: string;
  name: string;
  tag: string;
  credit: string;
  custom: boolean;
  dataUrl?: string;
}

export function getSeriesBuiltIns(seriesId: string): SeriesLibraryEntry[] {
  if (seriesId === 'owner') {
    return [
      {
        id: 'owner',
        series: 'owner',
        name: '默认徽像',
        tag: '蜂群主人',
        credit: '内置默认',
        custom: false,
      },
    ];
  }
  const builtIns = AVATAR_CATALOG.filter(item => item.series === seriesId);
  if (builtIns.length) return builtIns.map(item => ({ ...item, custom: false }));
  return [{
    id: 'builtin-neutral',
    series: seriesId,
    name: '默认徽像',
    tag: '',
    credit: '内置默认',
    custom: false,
  }];
}

export function getSeriesLibraryEntries(
  seriesId: string,
  customItems: CustomAvatarMeta[] = [],
  hiddenIds: readonly string[] = [],
): SeriesLibraryEntry[] {
  const hiddenSet = new Set(hiddenIds);
  const builtIns = getSeriesBuiltIns(seriesId);
  const visibleBuiltIns = builtIns.filter(item => !hiddenSet.has(item.id));
  const customs = customItems
    .filter(item => item.series === seriesId)
    .map(item => ({
      id: item.id,
      series: seriesId,
      name: item.name,
      tag: '自定义头像',
      credit: '本地添加',
      custom: true,
      dataUrl: item.dataUrl,
    }));
  const combined = [...visibleBuiltIns, ...customs];
  if (combined.length > 0) return combined;
  return builtIns.length > 0 ? [builtIns[0]] : [];
}

export function resolveSeriesAvatar(
  input: AvatarResolveInput,
  selectedBySeries: Record<string, string> = {},
  customItems: CustomAvatarMeta[] = [],
  hiddenIds: readonly string[] = [],
): { series: ModelSeriesInfo; active: SeriesLibraryEntry; entries: SeriesLibraryEntry[] } {
  const series = resolveModelSeries(input);
  const entries = getSeriesLibraryEntries(series.id, customItems, hiddenIds);
  const chosenId = selectedBySeries[series.id];
  const active =
    (chosenId ? entries.find(item => item.id === chosenId) : undefined) ??
    entries[0] ?? {
      id: 'owner',
      series: series.id,
      name: series.label,
      tag: '',
      credit: '',
      custom: false,
    };
  return { series, active, entries };
}
