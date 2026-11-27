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
