/// <reference types="vite/client" />
import {
  getSeriesLibraryEntries,
  resolveModelSeries,
  resolveSeriesAvatar,
  type AvatarResolveInput,
  type CustomAvatarMeta,
  type ModelSeriesInfo,
  type SeriesLibraryEntry,
} from '../shared/avatarCatalog';

const SELECTED_STORAGE_KEY = 'swarm.avatars.selected.v2';
const CUSTOM_STORAGE_KEY = 'swarm.avatars.custom.v2';
const HIDDEN_STORAGE_KEY = 'swarm.avatars.hidden.v2';

// 用户「我」初始矢量头像：暖蜜色蜂群指挥官徽像，可在「我的头像」库内直接自定义添加替换。
const OWNER_DEFAULT_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff4d6"/><stop offset="100%" stop-color="#ffd584"/></linearGradient></defs>` +
      `<rect width="256" height="256" rx="128" fill="url(#bg)"/>` +
      `<circle cx="128" cy="96" r="44" fill="#7c4a03"/>` +
      `<path d="M52 224c8-44 36-68 76-68s68 24 76 68" fill="#9a5c04"/>` +
      `<circle cx="128" cy="100" r="32" fill="#ffe7c7"/>` +
      `<path d="M92 88c10-22 62-22 72 0-6-16-20-28-36-28s-30 12-36 28Z" fill="#7c4a03"/>` +
      `<circle cx="114" cy="102" r="4.5" fill="#4a2b02"/><circle cx="142" cy="102" r="4.5" fill="#4a2b02"/>` +
      `<path d="M118 116c5.6 4.8 14.4 4.8 20 0" fill="none" stroke="#9a5c04" stroke-width="4.4" stroke-linecap="round"/>` +
      `<path d="M128 32l14 8v16l-14 8-14-8V40Z" fill="#f59e0b" stroke="#fff7e6" stroke-width="4"/>` +
      `</svg>`,
  );

function readSelectedMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SELECTED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSelectedMap(map: Record<string, string>): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(SELECTED_STORAGE_KEY);
    else localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用时静默忽略
  }
}

function readCustomList(): CustomAvatarMeta[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CustomAvatarMeta =>
        Boolean(
          item &&
            typeof item === 'object' &&
            typeof (item as CustomAvatarMeta).id === 'string' &&
            typeof (item as CustomAvatarMeta).series === 'string' &&
            typeof (item as CustomAvatarMeta).name === 'string' &&
            typeof (item as CustomAvatarMeta).dataUrl === 'string',
        ),
    );
  } catch {
    return [];
  }
}

function writeCustomList(items: CustomAvatarMeta[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(CUSTOM_STORAGE_KEY);
    else localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(items));
  } catch {
    throw new Error('头像本地存储空间不足，请删除部分旧的自定义头像后再试');
  }
}

function readHiddenIds(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [];
  } catch {
    return [];
  }
}

function writeHiddenIds(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(HIDDEN_STORAGE_KEY);
    else localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时静默忽略
  }
}

export function entryAvatarUrl(entry: Pick<SeriesLibraryEntry, 'id' | 'dataUrl'>): string {
  if (entry.dataUrl) return entry.dataUrl;
  if (entry.id === 'owner') return OWNER_DEFAULT_SVG;
  return OWNER_DEFAULT_SVG;
}

export function resolveMemberAvatar(input: AvatarResolveInput): {
  series: ModelSeriesInfo;
  active: SeriesLibraryEntry;
  entries: SeriesLibraryEntry[];
  url: string;
} {
  const resolved = resolveSeriesAvatar(input, readSelectedMap(), readCustomList(), readHiddenIds());
  return {
    ...resolved,
    url: entryAvatarUrl(resolved.active),
  };
}

export function selectSeriesAvatar(seriesId: string, avatarId: string): void {
  const map = readSelectedMap();
  map[seriesId] = avatarId;
  writeSelectedMap(map);
}

export function addCustomSeriesAvatar(seriesId: string, name: string, dataUrl: string): CustomAvatarMeta {
  const cleanName = name.trim().slice(0, 24) || '自定义头像';
  const item: CustomAvatarMeta = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    series: seriesId,
    name: cleanName,
    dataUrl,
  };
  const next = [...readCustomList(), item];
  writeCustomList(next);
  selectSeriesAvatar(seriesId, item.id);
  return item;
}

export function removeCustomSeriesAvatar(seriesId: string, avatarId: string): void {
  const next = readCustomList().filter(item => !(item.series === seriesId && item.id === avatarId));
  writeCustomList(next);
  const selected = readSelectedMap();
  if (selected[seriesId] === avatarId) {
    delete selected[seriesId];
    writeSelectedMap(selected);
  }
}

export function removeSeriesAvatar(seriesId: string, avatarId: string, isCustom: boolean): boolean {
  const current = getSeriesLibraryEntries(seriesId, readCustomList(), readHiddenIds());
  if (current.length <= 1) return false;
  if (isCustom) {
    removeCustomSeriesAvatar(seriesId, avatarId);
    return true;
  }
  const hidden = new Set(readHiddenIds());
  hidden.add(avatarId);
  writeHiddenIds([...hidden]);
  const selected = readSelectedMap();
  if (selected[seriesId] === avatarId) {
    delete selected[seriesId];
    writeSelectedMap(selected);
  }
  return true;
}

export { resolveModelSeries, type ModelSeriesInfo, type SeriesLibraryEntry };
