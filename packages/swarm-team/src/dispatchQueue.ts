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
  private readonly queuedBySession = new Map<string, Set<DispatchItem>>();
  private readonly runningBySession = new Map<string, DispatchItem>();
  private readonly runningByRunId = new Map<string, DispatchItem>();

  /** 失败可以重派，排队中、执行中和已完成的派工沿用原记录。 */
  add(input: { id: string; projectId: string; sessionId: string; text: string }): 'queued' | 'duplicate' {
    const existing = this.items.get(input.id);
    if (existing && existing.status !== 'failed') return 'duplicate';
    const item: DispatchItem = { ...input, status: 'queued' };
    const queued = this.queuedBySession.get(item.sessionId) ?? new Set<DispatchItem>();
    queued.add(item);
    this.queuedBySession.set(item.sessionId, queued);
    this.items.set(item.id, item);
    return 'queued';
  }

  /** 取该会话最早的一条待执行派工，并标记 running。 */
  takeNext(sessionId: string): DispatchItem | undefined {
    if (this.running(sessionId)) return undefined;
    const queued = this.queuedBySession.get(sessionId);
    if (!queued) return undefined;
    const item = queued.values().next().value;
    if (!item) return undefined;
    queued.delete(item);
    if (!queued.size) this.queuedBySession.delete(sessionId);
    item.status = 'running';
    this.runningBySession.set(sessionId, item);
    return item;
  }

  running(sessionId: string): DispatchItem | undefined {
    return this.runningBySession.get(sessionId);
  }

  assign(id: string, runId: string): void {
    const item = this.items.get(id);
    if (item?.status !== 'running') return;
    if (item.runId) this.runningByRunId.delete(item.runId);
    item.runId = runId;
    this.runningByRunId.set(runId, item);
  }

  /** 用真实运行结果收尾；失败带原始错误，便于在讨论串里定位和重派。 */
  settle(runId: string, status: 'done' | 'failed', error?: string): DispatchItem | undefined {
    const item = this.runningByRunId.get(runId);
    return item ? this.settleById(item.id, status, error) : undefined;
  }

  /** 启动失败时按派工 id 收尾（此时还没有 runId）。 */
  settleById(id: string, status: 'done' | 'failed', error?: string): DispatchItem | undefined {
    const item = this.items.get(id);
    if (item?.status !== 'running') return undefined;
    this.runningBySession.delete(item.sessionId);
    if (item.runId) this.runningByRunId.delete(item.runId);
    item.status = status;
    item.error = status === 'failed' ? (error || '未知错误') : undefined;
    return item;
  }

  pending(sessionId: string): number {
    return this.queuedBySession.get(sessionId)?.size ?? 0;
  }

  /** 持久化终态后，由协作账本接管历史和已完成派工的去重。 */
  discardSettled(id: string): void {
    const status = this.items.get(id)?.status;
    if (status === 'done' || status === 'failed') this.items.delete(id);
  }

  get(id: string): DispatchItem | undefined {
    return this.items.get(id);
  }
}
