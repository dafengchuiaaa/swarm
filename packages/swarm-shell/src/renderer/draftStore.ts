// 会话草稿持久化：localStorage 落盘，重启不丢。
// 存储不可用（隐私模式 / 配额满）时静默降级为内存 Map，行为与旧版一致。

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftStore {
  get(id: string): string | undefined;
  set(id: string, text: string): void;
  delete(id: string): void;
  readonly size: number;
}

const memoryStorage = (): KeyValueStorage => {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
  };
};

/** 探测存储可用性；Electron 渲染进程正常时返回 localStorage 本体。 */
export function safeStorage(candidate?: KeyValueStorage | null): KeyValueStorage {
  try {
    if (!candidate) return memoryStorage();
    const probe = '__swarm_draft_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return memoryStorage();
  }
}

export function createDraftStore(storage: KeyValueStorage, key = 'swarm.drafts.v1', limit = 200): DraftStore {
  const entries = new Map<string, string>();
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof text === 'string' && text) entries.set(id, text);
        }
      }
    }
  } catch {
    // 损坏的草稿串不影响启动，从空草稿开始。
  }

  const persist = (): void => {
    try {
      if (!entries.size) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // 落盘失败保留内存草稿，本轮仍可用。
    }
  };

  return {
    get: id => entries.get(id),
    set(id, text) {
      if (!text) {
        this.delete(id);
        return;
      }
      // 重新插入到队尾，超出上限时淘汰最久未动的草稿。
      entries.delete(id);
      entries.set(id, text);
      while (entries.size > limit) entries.delete(entries.keys().next().value as string);
      persist();
    },
    delete(id) {
      if (entries.delete(id)) persist();
    },
    get size() {
      return entries.size;
    },
  };
}