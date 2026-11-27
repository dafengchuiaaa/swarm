import { describe, expect, it } from 'vitest';
import { DispatchQueue } from '../../../packages/swarm-team/src/dispatchQueue';

describe('派工队列', () => {
  it('同一派工重复触发只入队一次', () => {
    const queue = new DispatchQueue();
    expect(queue.add({ id: 'msg-1', projectId: 'p1', sessionId: 's1', text: '做 A' })).toBe('queued');
    expect(queue.add({ id: 'msg-1', projectId: 'p1', sessionId: 's1', text: '做 A' })).toBe('duplicate');
    expect(queue.pending('s1')).toBe(1);
  });

  it('忙时排队，回合结束后按顺序接起；同成员不并发', () => {
    const queue = new DispatchQueue();
    queue.add({ id: 'm1', projectId: 'p1', sessionId: 's1', text: '第一件' });
    queue.add({ id: 'm2', projectId: 'p1', sessionId: 's1', text: '第二件' });

    const first = queue.takeNext('s1')!;
    queue.assign(first.id, 'R-1');
    expect(queue.running('s1')?.id).toBe('m1');
    expect(queue.takeNext('s1')).toBeUndefined();

    queue.settle('R-1', 'done');
    expect(queue.get('m1')?.status).toBe('done');
    expect(queue.add({ id: 'm1', projectId: 'p1', sessionId: 's1', text: '第一件' })).toBe('duplicate');
    const second = queue.takeNext('s1')!;
    expect(second.id).toBe('m2');
    queue.assign(second.id, 'R-2');
    expect(queue.running('s1')?.id).toBe('m2');
  });

  it('启动失败保留原始错误，同一派工可以重派', () => {
    const queue = new DispatchQueue();
    queue.add({ id: 'm1', projectId: 'p1', sessionId: 's1', text: '做' });
    queue.takeNext('s1');
    queue.settleById('m1', 'failed', '宿主不存在');
    expect(queue.get('m1')?.error).toBe('宿主不存在');
    queue.add({ id: 'm2', projectId: 'p1', sessionId: 's1', text: '已在等候' });
    expect(queue.add({ id: 'm1', projectId: 'p1', sessionId: 's1', text: '做' })).toBe('queued');
    expect(queue.pending('s1')).toBe(2);
    expect(queue.takeNext('s1')?.id).toBe('m2');
  });

  it('不同成员各自排队，互不抢占', () => {
    const queue = new DispatchQueue();
    queue.add({ id: 'm1', projectId: 'p1', sessionId: 's1', text: 'A' });
    queue.add({ id: 'm2', projectId: 'p1', sessionId: 's2', text: 'B' });
    expect(queue.takeNext('s1')?.id).toBe('m1');
    expect(queue.takeNext('s2')?.id).toBe('m2');
  });
});
