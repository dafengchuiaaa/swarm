import { describe, expect, it } from 'vitest';
import { createDraftStore, safeStorage, type KeyValueStorage } from '../../../packages/swarm-shell/src/renderer/draftStore';

function memoryStorage(): KeyValueStorage & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    dump: () => map,
  };
}

describe('会话草稿持久化', () => {
  it('写入即落盘，重建实例（模拟重启）后草稿仍在', () => {
    const storage = memoryStorage();
    const first = createDraftStore(storage);
    first.set('S-1', '还没发出去的任务');
    first.set('S-2', '另一条草稿');
    const reopened = createDraftStore(storage);
    expect(reopened.get('S-1')).toBe('还没发出去的任务');
    expect(reopened.get('S-2')).toBe('另一条草稿');
    expect(reopened.size).toBe(2);
  });

  it('发送后删除草稿并同步落盘；空串写入等同删除', () => {
    const storage = memoryStorage();
    const drafts = createDraftStore(storage);
    drafts.set('S-1', '内容');
    drafts.delete('S-1');
    drafts.set('S-2', '内容');
    drafts.set('S-2', '');
    expect(createDraftStore(storage).size).toBe(0);
    expect(storage.dump().has('swarm.drafts.v1')).toBe(false);
  });

  it('损坏的存储串不炸启动，从空草稿开始', () => {
    const storage = memoryStorage();
    storage.setItem('swarm.drafts.v1', '{broken json');
    const drafts = createDraftStore(storage);
    expect(drafts.size).toBe(0);
    drafts.set('S-1', '新草稿');
    expect(createDraftStore(storage).get('S-1')).toBe('新草稿');
  });

  it('超出上限淘汰最久未动的草稿，最近写过的保留', () => {
    const storage = memoryStorage();
    const drafts = createDraftStore(storage, 'swarm.drafts.v1', 3);
    drafts.set('A', '1');
    drafts.set('B', '2');
    drafts.set('C', '3');
    drafts.set('A', '1-改');
    drafts.set('D', '4');
    const reopened = createDraftStore(storage, 'swarm.drafts.v1', 3);
    expect(reopened.get('B')).toBeUndefined();
    expect(reopened.get('A')).toBe('1-改');
    expect(reopened.get('D')).toBe('4');
    expect(reopened.size).toBe(3);
  });

  it('存储不可用时降级为内存，读写不抛异常', () => {
    const broken: KeyValueStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    const storage = safeStorage(broken);
    const drafts = createDraftStore(storage);
    expect(() => drafts.set('S-1', 'still works')).not.toThrow();
    expect(drafts.get('S-1')).toBe('still works');
    expect(() => drafts.delete('S-1')).not.toThrow();
  });
});