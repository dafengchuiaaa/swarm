/**
 * 派工队列：成员忙时把派工留在队列，原回合结束后按顺序接起。
 *
 * 纯内存逻辑，不碰宿主；同一 messageId 是一个任务的门牌号——工具重试、宿主重发都用它去重，
 * 排队、执行、结果都挂在同一条记录上，失败保留原始错误以便重派。
 */
export type DispatchItemStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DispatchItem {
  id: string;
  projectId: string;
  sessionId: string;
  text: string;
  status: DispatchItemStatus;
  runId?: string;
  error?: string;
}

export class DispatchQueue {
  private readonly items = new Map<string, DispatchItem>();

  /** 失败可以重派，排队中、执行中和已完成的派工沿用原记录。 */
  add(input: { id: string; projectId: string; sessionId: string; text: string }): 'queued' | 'duplicate' {
    const existing = this.items.get(input.id);
    if (existing && existing.status !== 'failed') return 'duplicate';
    this.items.delete(input.id);
    this.items.set(input.id, { ...input, status: 'queued' });
    return 'queued';
  }

  /** 取该会话最早的一条待执行派工，并标记 running。 */
  takeNext(sessionId: string): DispatchItem | undefined {
    if (this.running(sessionId)) return undefined;
    for (const item of this.items.values()) {
      if (item.sessionId !== sessionId || item.status !== 'queued') continue;
      item.status = 'running';
      return item;
    }
    return undefined;
  }

  running(sessionId: string): DispatchItem | undefined {
    for (const item of this.items.values()) {
      if (item.sessionId === sessionId && item.status === 'running') return item;
    }
    return undefined;
  }

  assign(id: string, runId: string): void {
    const item = this.items.get(id);
    if (item) item.runId = runId;
  }

  /** 用真实运行结果收尾；失败带原始错误，便于在讨论串里定位和重派。 */
  settle(runId: string, status: 'done' | 'failed', error?: string): DispatchItem | undefined {
    for (const item of this.items.values()) {
      if (item.runId === runId && item.status === 'running') return this.settleById(item.id, status, error);
    }
    return undefined;
  }

  /** 启动失败时按派工 id 收尾（此时还没有 runId）。 */
  settleById(id: string, status: 'done' | 'failed', error?: string): DispatchItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.status = status;
    item.error = status === 'failed' ? (error || '未知错误') : undefined;
    return item;
  }

  pending(sessionId: string): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.sessionId === sessionId && item.status === 'queued') count += 1;
    }
    return count;
  }

  get(id: string): DispatchItem | undefined {
    return this.items.get(id);
  }
}
