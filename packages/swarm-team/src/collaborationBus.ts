/**
 * 团队协作总线：把旧蜂群（Python `collaboration_bus.py` + `task_ledger.py` +
 * `dispatch_queue.py`）的交互语义原样搬到 Electron 主进程。
 *
 * 保住的四条语义（每一条都有对应测试）：
 * 1. **先校验后发布**：一条回复里的消息、任务更新、共享更新、交付物全部校验通过才落库，
 *    任何一项不合格就整条不投递——不允许"投了一半"。
 * 2. **幂等**：同一 `event_id` 重复投递且内容一致 → 返回原结论；内容变了 → 报错。
 * 3. **版本冲突不覆盖**：共享板用 `expected_version` 比对，对不上就记冲突并通知作者，
 *    绝不用后来的值盖掉前一个。
 * 4. **回执状态机**：queued → delivered → processed；本轮结束时未处理的统一标 unprocessed。
 */
import { createHash, randomUUID } from 'node:crypto';

export type ReceiptState = 'queued' | 'available' | 'delivered' | 'processed' | 'unprocessed';
export type ReportState = 'none' | 'in_progress' | 'submitted' | 'blocked';
export type AcceptanceState = 'pending' | 'passed' | 'rejected';

export interface BusMember {
  id: string;
  label: string;
  instruction?: string;
}

export interface BusMessage {
  id: string;
  runId: string;
  sender: string;
  to: string;
  text: string;
  kind: 'message' | 'update' | 'conflict' | 'artifact' | 'system';
  time: string;
  receipts: Record<string, ReceiptState>;
  requiresAction: boolean;
  artifactIds: string[];
  taskUpdates: TaskReportInput[];
  /** 公开频道 id；点对点消息落在 dm:<a>|<b> 频道，只对收发双方可见 */
  channel: string;
  /** 讨论串：根消息没有该字段，回复指向根消息 id */
  threadId?: string;
  /** 子任务结果存于原回合；信箱只持有引用。 */
  resultOf?: string;
  /** 发言自带的证据引用（消息 id / 文件路径 / 任务 id） */
  evidence: string[];
}

export interface BoardEntry {
  value: string;
  version: number;
  author: string;
}

export interface BoardConflict {
  sender: string;
  key: string;
  expected: number;
  actual: number;
  proposed: string;
}

export interface TaskReportInput {
  task_id?: string;
  attempt_id?: string;
  expected_version?: number;
  progress?: string;
  evidence?: string[];
  next?: string;
  blocker?: string;
}

export interface BusTask {
  id: string;
  runId: string;
  attemptId: string;
  owner: string;
  ownerLabel: string;
  parentId?: string;
  execution: 'queued' | 'running' | 'responded' | 'unknown' | 'skipped';
  report: ReportState;
  acceptance: AcceptanceState;
  version: number;
  evidence: string[];
  next: string;
  blocker: string;
  updated: string;
}

export interface ArtifactInput {
  name: string;
  content?: string;
  path?: string;
}

export interface BusArtifact {
  id: string;
  runId: string;
  owner: string;
  name: string;
  taskId?: string;
  /** 相对工作区的路径；绝对路径不落库，避免把机器布局写进共享状态 */
  path?: string;
  content: string;
  preview: string;
}

export interface Envelope {
  result?: string;
  messages?: {
    to: string;
    text: string;
    requires_action?: boolean;
    task_updates?: TaskReportInput[];
    channel?: string;
    thread?: string;
    evidence?: string[];
  }[];
  task_updates?: TaskReportInput[];
  updates?: { key: string; value: string; expected_version: number }[];
  artifacts?: ArtifactInput[];
}

export type DispatchStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'paused' | 'unknown';

export interface BusDispatch {
  /** 派工条目 id；由消息派生的派工与消息 id 相同，便于"同一条派工"跨排队/执行/结果。 */
  id: string;
  /** 触发这次派工的消息 id；工具重试按它去重。 */
  messageId?: string;
  owner: string;
  taskId: string;
  status: DispatchStatus;
  reason: string;
  runId?: string;
  error?: string;
  updated: string;
}

/** 每个成员已经送进过宿主会话的游标：任务版本、看过的板版本、已送过的消息 id。 */
export interface BusCursor {
  taskVersion: number;
  boardVersions: Record<string, number>;
  nextMessageIndex?: number;
  /** 最近送达的消息 ID，供排查和恢复旧游标使用。 */
  messageIds: string[];
  updated: string;
  /** 累计注入统计：读取次数、条目数、字符量，用来核对增量是否真的变小。 */
  stats?: { reads: number; entries: number; chars: number };
}

export interface ContextItem {
  kind: 'task' | 'board' | 'message';
  id?: string;
  text: string;
}

export interface BusState {
  channels?: Record<string, BusChannel>;
  messages: BusMessage[];
  board: Record<string, BoardEntry>;
  conflicts: BoardConflict[];
  tasks: Record<string, BusTask>;
  artifacts: BusArtifact[];
  processed: Record<string, string>;
  dispatches: BusDispatch[];
  cursors?: Record<string, BusCursor>;
}

export interface BusChannel {
  id: string;
  name: string;
  creator: string;
  memberIds: string[];
  archived: boolean;
}

export interface AcceptResult {
  result: string;
  messageIds: string[];
  artifactIds: string[];
  conflicts: BoardConflict[];
}

const MAX_MESSAGES = 8;
const MAX_UPDATES = 8;
const MAX_MESSAGE_CHARS = 8000;
const PREVIEW_CHARS = 1200;
const PREVIEW_BUDGET = 4000;

const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

function fail(reason: string): never {
  throw new Error(reason);
}

/** 交付物路径只允许落在本轮工作区内；越界一律拒绝，不给"顺手把 C 盘文件发出去"留口子。 */
export function assertInsideWorkspace(candidate: string, workspace: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = normalize(workspace);
  const target = normalize(candidate);
  if (!target.startsWith(`${root}/`)) fail('交付物路径必须在本轮工作目录内');
  return target;
}

export class CollaborationBus {
  readonly runId: string;
  readonly channelId: string;
  private readonly members: BusMember[];
  private readonly workspace?: string;
  private state: BusState;
  private readonly messagesById: Map<string, BusMessage>;

  constructor(
    members: BusMember[],
    options: { workspace?: string; state?: BusState; runId?: string; channelId?: string } = {},
  ) {
    if (!members.length) fail('团队至少需要一名成员');
    this.members = [...members];
    this.workspace = options.workspace;
    this.runId = options.runId ?? randomUUID().replace(/-/g, '');
    this.channelId = options.channelId ?? 'main';
    this.state = options.state ?? {
      messages: [],
      board: {},
      conflicts: [],
      tasks: {},
      artifacts: [],
      processed: {},
      dispatches: [],
      cursors: {},
    };
    this.messagesById = new Map(this.state.messages.map(message => [message.id, message]));
    // 旧快照没有游标与派工 id：补齐默认值，避免恢复后读上下文从"全量"重来一遍。
    this.state.cursors ??= {};
    this.state.dispatches ??= [];
    this.state.channels ??= {};
    for (const dispatch of this.state.dispatches) {
      dispatch.id ??= dispatch.messageId ?? `D-${shortId()}`;
      dispatch.updated ??= now();
    }
    if (!options.state) this.bindTasks();
  }

  /** 一名成员一条任务；根成员是 goal，有下级的成员是 work_package。 */
  private bindTasks(): void {
    this.members.forEach((member, index) => {
      const id = `T-${shortId()}`;
      this.state.tasks[id] = {
        id,
        runId: this.runId,
        attemptId: randomUUID().replace(/-/g, ''),
        owner: member.id,
        ownerLabel: member.label,
        execution: 'queued',
        report: 'none',
        acceptance: 'pending',
        version: 0,
        evidence: [],
        next: '',
        blocker: '',
        updated: now(),
      };
      if (index > 0) this.state.tasks[id].parentId = this.taskOf(this.members[0].id)?.id;
    });
  }

  taskOf(memberId: string): BusTask | undefined {
    return Object.values(this.state.tasks).find(task => task.owner === memberId);
  }

  snapshot(): BusState {
    return structuredClone(this.state);
  }

  board(): Record<string, BoardEntry> {
    return structuredClone(this.state.board);
  }

  artifacts(): BusArtifact[] {
    return structuredClone(this.state.artifacts);
  }

  ticket(memberId: string): { taskId: string; attemptId: string; version: number; eventId: string } {
    const task = this.taskOf(memberId) ?? fail('该成员没有绑定任务');
    return { taskId: task.id, attemptId: task.attemptId, version: task.version, eventId: shortId() };
  }

  /**
   * 接收一名成员的一次输出。纯文本原样返回（不是协作协议就当好一条结论），
   * 只有带协作字段的 JSON 才会被解析、校验、发布。
   */
  accept(sender: string, text: string, ticket?: { eventId?: string }): AcceptResult {
    if (!this.members.some(member => member.id === sender)) fail('发送者不在本轮成员内');
    const body = stripFence(text).trim();
    let envelope: Envelope;
    try {
      envelope = JSON.parse(body) as Envelope;
    } catch {
      if (body.startsWith('{') && ['"messages"', '"updates"', '"task_updates"'].some(key => body.includes(key))) {
        fail('协作 JSON 无效；未投递任何内容');
      }
      return { result: text, messageIds: [], artifactIds: [], conflicts: [] };
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { result: text, messageIds: [], artifactIds: [], conflicts: [] };
    if (!envelope.result && !envelope.messages && !envelope.updates && !envelope.task_updates) {
      return { result: text, messageIds: [], artifactIds: [], conflicts: [] };
    }

    // ---- 全量校验（此时还没有任何副作用）
    const result = typeof envelope.result === 'string' ? envelope.result.trim() : '';
    if (!result) fail('协作回复缺少完整 result');
    const messages = envelope.messages ?? [];
    const updates = envelope.updates ?? [];
    if (!Array.isArray(messages) || !Array.isArray(updates)) fail('协作消息或共享更新格式无效');
    if (messages.length > MAX_MESSAGES || updates.length > MAX_UPDATES) fail('协作消息或共享更新超出上限');
    for (const message of messages) {
      if (!message || typeof message.to !== 'string') fail('协作消息收件人无效；未投递');
      if (message.to !== 'all' && !this.members.some(member => member.id === message.to)) fail('协作消息收件人无效；未投递');
      if (message.to === sender) fail('不能给自己发协作消息');
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_MESSAGE_CHARS) {
        fail('协作消息正文无效；未投递');
      }
      if (message.requires_action !== undefined && typeof message.requires_action !== 'boolean') {
        fail('requires_action 必须是布尔值');
      }
      const channel = message.channel ?? (message.to === 'all' ? this.channelId : dmChannel(sender, message.to));
      if (this.isGroupChannel(channel)) {
        this.assertCanPost(channel, sender);
      } else if (channel !== dmChannel(sender, message.to) || message.to === 'all') {
        fail('只能发到本项目频道或与收件人的私信');
      }
      if (message.to !== 'all' && channel !== dmChannel(sender, message.to)) {
        fail('点对点消息必须走收发双方的私信频道');
      }
      if (message.thread !== undefined) {
        const root = this.messagesById.get(message.thread);
        if (!root) fail('讨论串不存在；未投递');
        if (!this.visibleTo(root, sender)) fail('不能在看不到的讨论串里回复');
        if (root.channel !== channel) fail('讨论串和频道不一致');
      }
      const evidence = message.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length > 8) fail('证据引用应为至多 8 项');
      for (const entry of evidence) {
        if (typeof entry !== 'string' || !entry || entry.length > 2000) fail('证据引用格式无效');
      }
    }
    const keys = new Set<string>();
    for (const update of updates) {
      if (!update || typeof update.key !== 'string' || !update.key || update.key.length > 100) fail('共享更新格式无效；未投递');
      if (keys.has(update.key)) fail('同一条回复不能重复更新同一个共享键');
      keys.add(update.key);
      if (typeof update.value !== 'string' || update.value.length > MAX_MESSAGE_CHARS) fail('共享更新格式无效；未投递');
      if (!Number.isInteger(update.expected_version) || update.expected_version < 0) fail('共享更新版本号无效；未投递');
    }
    const prepared = this.prepareReports(sender, envelope.task_updates ?? []);
    const preparedPerMessage = messages.map(message => this.prepareReports(sender, message.task_updates ?? []));
    const artifacts = this.prepareArtifacts(sender, envelope.artifacts ?? []);

    // ---- 幂等：同一 event 同内容直接返回原结论；内容变了必须报错
    const eventId = ticket?.eventId;
    const dedupe = eventId == null ? undefined : {
      key: `${this.runId}:${sender}:${eventId}`,
      digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    };
    if (dedupe) {
      const previous = this.state.processed[dedupe.key];
      if (previous) {
        if (previous !== dedupe.digest) fail('重复投递的内容发生变化，未处理');
        return { result, messageIds: [], artifactIds: [], conflicts: [] };
      }
    }

    // ---- 发布
    const messageIds = messages.map(() => shortId());
    const storedArtifacts = artifacts.map(artifact => this.storeArtifact(artifact, sender));
    const artifactIds = storedArtifacts.map(artifact => artifact.id);
    const previousArtifacts = messages.length
      ? this.state.artifacts.filter(artifact => artifact.runId === this.runId && artifact.owner === sender)
      : [];
    messages.forEach((message, index) => {
      const related = [
        ...artifactIds,
        ...previousArtifacts
          .filter(artifact => message.text.includes(artifact.id) || message.text.includes(artifact.name))
          .map(artifact => artifact.id),
      ];
      this.publish({
        id: messageIds[index],
        sender,
        to: message.to,
        text: message.text,
        kind: 'message',
        requiresAction: message.requires_action ?? message.to !== 'all',
        artifactIds: [...new Set(related)],
        taskUpdates: message.task_updates ?? [],
        channel: message.channel,
        threadId: message.thread,
        evidence: message.evidence,
      });
    });

    // 任务报告：先应用根更新，再应用随消息携带的更新（与旧蜂群顺序一致）
    this.applyReports(sender, prepared);
    for (const reports of preparedPerMessage) this.applyReports(sender, reports);

    // 共享板：版本对不上就记冲突，绝不覆盖
    const conflicts: BoardConflict[] = [];
    for (const update of updates) {
      const current = this.state.board[update.key]?.version ?? 0;
      if (update.expected_version !== current) {
        const conflict: BoardConflict = {
          sender,
          key: update.key,
          expected: update.expected_version,
          actual: current,
          proposed: update.value,
        };
        this.state.conflicts.push(conflict);
        conflicts.push(conflict);
        this.publish({
          id: shortId(),
          sender: 'system',
          to: sender,
          text: `共享更新冲突，未覆盖：${JSON.stringify(conflict)}`,
          kind: 'conflict',
          requiresAction: false,
          artifactIds: [],
          taskUpdates: [],
          channel: this.channelId,
        });
        continue;
      }
      this.state.board[update.key] = { value: update.value, version: current + 1, author: sender };
      this.publish({
        id: shortId(),
        sender,
        to: 'all',
        text: `共享状态变更：${update.key} = ${update.value}（版本 ${current + 1}）`,
        kind: 'update',
        requiresAction: false,
        artifactIds: [],
        taskUpdates: [],
      });
    }

    for (const artifact of storedArtifacts) this.state.artifacts.push(artifact);
    if (dedupe) this.state.processed[dedupe.key] = dedupe.digest;
    return { result, messageIds, artifactIds, conflicts };
  }

  // ------------------------------------------------------------------ 内部

  private publish(
    input: Omit<BusMessage, 'runId' | 'time' | 'receipts' | 'channel' | 'threadId' | 'evidence'> & {
      channel?: string;
      threadId?: string;
      evidence?: string[];
    },
  ): void {
    const channel = input.channel ?? (input.to !== 'all' && input.to !== 'system' ? dmChannel(input.sender, input.to) : this.channelId);
    const publicReply = this.isGroupChannel(channel) && input.threadId && !input.requiresAction;
    const rootAuthor = publicReply && input.threadId ? this.messagesById.get(input.threadId)?.sender : undefined;
    const recipients = publicReply
      ? this.members.filter(member => member.id === rootAuthor && member.id !== input.sender).map(member => member.id)
      : input.to === 'all'
      ? this.members.filter(member => member.id !== input.sender && this.canReadChannel(channel, member.id)).map(member => member.id)
      : [input.to];
    const receipts: Record<string, ReceiptState> = {};
    for (const recipient of recipients) receipts[recipient] = input.requiresAction ? 'queued' : 'available';
    const message: BusMessage = {
      ...input,
      runId: this.runId,
      time: now(),
      receipts,
      channel,
      threadId: input.threadId,
      evidence: input.evidence ?? [],
    };
    this.state.messages.push(message);
    this.messagesById.set(message.id, message);
    if (input.requiresAction) {
      for (const recipient of recipients) {
        const task = this.taskOf(recipient);
        this.state.dispatches.push({
          id: input.id,
          messageId: input.id,
          owner: recipient,
          taskId: task?.id ?? '',
          status: 'queued',
          reason: 'task_message',
          updated: now(),
        });
      }
    }
  }

  private prepareReports(sender: string, reports: TaskReportInput[]): { taskId: string; fields: Partial<BusTask> }[] {
    if (!Array.isArray(reports) || reports.length > MAX_MESSAGES) fail('任务更新必须是至多 8 项的列表');
    const allowed = new Set(['task_id', 'attempt_id', 'expected_version', 'progress', 'evidence', 'next', 'blocker']);
    const seen = new Set<string>();
    return reports.map(item => {
      if (!item || typeof item !== 'object') fail('任务更新格式无效');
      for (const key of Object.keys(item)) if (!allowed.has(key)) fail('任务更新包含未支持字段；验收只能由检查或人工操作');
      const own = this.taskOf(sender) ?? fail('该成员没有绑定任务');
      const taskId = item.task_id ?? own.id;
      if (taskId !== own.id) fail('只能更新自己本轮绑定的任务');
      if (seen.has(taskId)) fail('同一条回复不能重复更新同一任务');
      seen.add(taskId);
      const task = this.state.tasks[taskId] ?? fail('任务不存在');
      const attemptId = item.attempt_id ?? task.attemptId;
      const version = item.expected_version ?? task.version;
      if (attemptId !== task.attemptId || !Number.isInteger(version) || version !== task.version) {
        fail('任务更新已过期，未覆盖当前版本');
      }
      const progress = item.progress;
      if (progress !== 'in_progress' && progress !== 'submitted' && progress !== 'blocked') {
        fail('任务进度只能是 in_progress、submitted 或 blocked');
      }
      const evidence = item.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length > 16) fail('任务证据应为至多 16 项的文本引用');
      for (const entry of evidence) {
        if (typeof entry !== 'string' || !entry || entry.length > 2000) fail('任务证据应为至多 16 项的文本引用');
      }
      for (const key of ['next', 'blocker'] as const) {
        const value = item[key] ?? '';
        if (typeof value !== 'string' || value.length > 4000) fail('任务说明格式无效');
      }
      if (progress === 'blocked' && !(item.blocker ?? '').trim()) fail('报告阻塞时必须说明原因');
      return {
        taskId,
        fields: { report: progress, evidence, next: item.next ?? '', blocker: item.blocker ?? '' },
      };
    });
  }

  private applyReports(sender: string, prepared: { taskId: string; fields: Partial<BusTask> }[]): void {
    for (const { taskId, fields } of prepared) {
      const task = this.state.tasks[taskId];
      const unchanged = Object.entries(fields).every(([key, value]) => JSON.stringify(task[key as keyof BusTask]) === JSON.stringify(value));
      if (unchanged) continue;
      Object.assign(task, fields, { version: task.version + 1, acceptance: 'pending', updated: now() });
      // 下级有变化，上级此前的验收结论即失效——不能留着"已通过"的旧结论骗人。
      let parentId = task.parentId;
      while (parentId && this.state.tasks[parentId]) {
        const ancestor = this.state.tasks[parentId];
        if (ancestor.acceptance !== 'pending') ancestor.acceptance = 'pending';
        parentId = ancestor.parentId;
      }
      // 有下一步且仍在进行中 → 再派一次，避免"报完进度就没人管"
      if (task.report === 'in_progress' && task.next.trim()) {
        this.state.dispatches.push({
          id: `P-${shortId()}`,
          owner: sender,
          taskId,
          status: 'queued',
          reason: 'task_progress',
          updated: now(),
        });
      }
    }
  }

  private prepareArtifacts(sender: string, artifacts: ArtifactInput[]): BusArtifact[] {
    if (!Array.isArray(artifacts)) fail('交付物格式无效');
    return artifacts.map(input => {
      if (!input || typeof input.name !== 'string' || !input.name.trim()) fail('交付物必须有名称');
      const hasContent = typeof input.content === 'string';
      const hasPath = typeof input.path === 'string' && input.path.length > 0;
      if (!hasContent && !hasPath) fail('交付物必须给出 content 或 path');
      if (hasPath) {
        if (!this.workspace) fail('未设置本轮工作目录，不能登记路径交付物');
        assertInsideWorkspace(input.path as string, this.workspace);
      }
      const content = hasContent ? (input.content as string) : '';
      return {
        id: `A-${shortId()}`,
        runId: this.runId,
        owner: sender,
        name: input.name,
        taskId: this.taskOf(sender)?.id,
        path: hasPath ? (input.path as string) : undefined,
        content,
        preview: content.slice(0, PREVIEW_CHARS) + (content.length > PREVIEW_CHARS ? '…' : ''),
      } satisfies BusArtifact;
    });
  }

  private storeArtifact(artifact: BusArtifact, sender: string): BusArtifact {
    // 路径交付物在此处不做磁盘拷贝（旧蜂群会复制一份）；拷贝由调用方在落盘阶段完成，
    // 总线只负责登记与授权校验，避免在纯逻辑层里做 IO。
    void sender;
    return artifact;
  }

  // ------------------------------------------------------------------ 读取

  /** 增量上下文：只带对方还没看过的共享版本，以及任务差异。 */
  contextDelta(memberId: string, seen: { taskVersion: number; boardVersions: Record<string, number> }): string {
    const task = this.taskOf(memberId) ?? fail('该成员没有绑定任务');
    const changedBoard: Record<string, BoardEntry> = {};
    for (const [key, entry] of Object.entries(this.state.board)) {
      if (seen.boardVersions[key] !== entry.version) changedBoard[key] = entry;
    }
    const payload: Record<string, unknown> = {};
    if (task.version !== seen.taskVersion) {
      payload.task = { id: task.id, version: task.version, report: task.report, next: task.next, blocker: task.blocker };
    }
    if (Object.keys(changedBoard).length) payload.board = changedBoard;
    return Object.keys(payload).length ? `协作变化：${JSON.stringify(payload)}` : '';
  }

  /** 取走待投递消息并把回执推进到 delivered。 */
  deliveries(): Record<string, BusMessage[]> {
    const result: Record<string, BusMessage[]> = {};
    for (const message of this.state.messages) {
      if (message.runId !== this.runId) continue;
      for (const [memberId, state] of Object.entries(message.receipts)) {
        if (state === 'queued' || state === 'available') {
          (result[memberId] ??= []).push(structuredClone(message));
          message.receipts[memberId] = 'delivered';
        }
      }
    }
    return result;
  }

  cursorOf(memberId: string): BusCursor {
    return this.state.cursors![memberId] ?? { taskVersion: -1, boardVersions: {}, messageIds: [], updated: now() };
  }

  /**
   * 增量上下文：只给这个成员还没送过的东西，最多 `limit` 条。
   *
   * 消息给的是短预览，正文用 `readMessages` 按消息 id 回读；返回后游标前移，
   * 同一条更新不会被下一次读取再补一遍。消息本身仍留在总账里，不因游标前移而丢失。
   */
  takeContext(memberId: string, limit = 8, advance = true): {
    items: ContextItem[];
    pending: number;
    remaining: number;
    metrics: { entries: number; chars: number; messages: number };
    cursor: BusCursor;
  } {
    if (!this.members.some(item => item.id === memberId)) fail('成员不存在');
    const cursor = this.cursorOf(memberId);
    const task = this.taskOf(memberId);
    const items: ContextItem[] = [];
    const cap = Math.max(1, Math.min(32, Number.isFinite(limit) ? Math.floor(limit) : 8));

    if (task && task.version !== cursor.taskVersion) {
      const next = task.next ? `；下一步：${task.next}` : '';
      const blocker = task.blocker ? `；阻塞：${task.blocker}` : '';
      items.push({
        kind: 'task',
        id: task.id,
        text: `你的任务 ${task.id} 版本 ${task.version}：${task.report}${next}${blocker}`,
      });
    }

    const boardVersions: Record<string, number> = { ...cursor.boardVersions };
    for (const [key, entry] of Object.entries(this.state.board)) {
      if (items.length >= cap) break;
      if (boardVersions[key] === entry.version) continue;
      items.push({ kind: 'board', id: key, text: `共享板 ${key}（版本 ${entry.version}）：${entry.value}` });
      boardVersions[key] = entry.version;
    }

    let remaining = 0;
    const delivered: string[] = [];
    let nextMessageIndex = this.state.messages.length;
    const start = cursor.nextMessageIndex ?? this.restoreMessageIndex(cursor.messageIds);
    for (let index = start; index < this.state.messages.length; index += 1) {
      const message = this.state.messages[index];
      if (message.sender === memberId) continue;
      if (!this.visibleTo(message, memberId)) continue;
      if (items.length >= cap) {
        if (remaining === 0) nextMessageIndex = index;
        remaining += 1;
        continue;
      }
      const scope = message.channel.startsWith('dm:') ? '私信' : '频道';
      const thread = message.threadId ? `，讨论串 ${message.threadId}` : '';
      const preview = message.text.length > 240 ? `${message.text.slice(0, 240)}…` : message.text;
      items.push({
        kind: 'message',
        id: message.id,
        text: `[${message.id}] ${this.labelOf(message.sender)}（${scope}${thread}）：${preview}（全文 ${message.text.length} 字，用 swarm_read 读）`,
      });
      delivered.push(message.id);
    }

    const chars = items.reduce((sum, item) => sum + item.text.length, 0);
    const nextCursor: BusCursor = {
      taskVersion: task ? task.version : cursor.taskVersion,
      boardVersions,
      nextMessageIndex,
      messageIds: [...cursor.messageIds, ...delivered].slice(-64),
      updated: now(),
      stats: {
        reads: (cursor.stats?.reads ?? 0) + 1,
        entries: (cursor.stats?.entries ?? 0) + items.length,
        chars: (cursor.stats?.chars ?? 0) + chars,
      },
    };
    if (advance) this.confirmContext(memberId, nextCursor);
    return {
      items,
      pending: this.pendingDispatches(memberId).length,
      remaining,
      metrics: { entries: items.length, chars, messages: delivered.length },
      cursor: structuredClone(nextCursor),
    };
  }

  confirmContext(memberId: string, cursor: BusCursor): void {
    this.state.cursors![memberId] = structuredClone(cursor);
  }

  private restoreMessageIndex(messageIds: string[]): number {
    if (!messageIds.length) return 0;
    const delivered = new Set(messageIds);
    // 旧版按消息顺序投递。最靠后的已送达消息之前，可见消息都已送达过。
    for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
      if (delivered.has(this.state.messages[index].id)) return index + 1;
    }
    return 0;
  }

  /** 按消息 id 分页回读原文，偏移量沿用字符串索引。 */
  readMessages(memberId: string, ids: string[], maxChars?: number, offset = 0,
    readResult?: (runId: string) => string | undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) fail('offset 必须是非负整数');
    if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1)) fail('max_chars 必须是正整数');
    const wanted = new Set(ids.slice(0, 16));
    const result = [];
    for (const message of this.state.messages) {
      if (!wanted.has(message.id)) continue;
      if (!this.visibleTo(message, memberId)) continue;
      const dispatch = message.resultOf ? this.state.dispatches.find(item => item.id === message.resultOf) : undefined;
      const resultText = dispatch?.runId ? readResult?.(dispatch.runId) : undefined;
      const text = dispatch ? [message.text, dispatch.error, resultText].filter(Boolean).join('\n') : message.text;
      const pageSize = Math.min(maxChars ?? (dispatch ? 800 : 4000), 4000);
      const totalChars = text.length;
      const start = Math.min(offset, totalChars);
      let end = Math.min(start + pageSize, totalChars);
      // 续读位置不能把 emoji 等代理对拆开。单字符页也要能继续向前读。
      if (end < totalChars && (text.codePointAt(end - 1) ?? 0) > 0xffff) {
        end += end - start === 1 ? 1 : -1;
      }
      const nextOffset = end < totalChars ? end : null;
      result.push({
        id: message.id,
        sender: message.sender,
        channel: message.channel,
        threadId: message.threadId,
        text: text.slice(start, end),
        truncated: nextOffset !== null,
        total_chars: totalChars,
        next_offset: nextOffset,
      });
    }
    return result;
  }

  private labelOf(sender: string): string {
    if (sender === 'system') return '系统';
    return this.members.find(member => member.id === sender)?.label ?? sender;
  }

  /** 更新派工状态：queued → running → done/failed，失败保留原始错误。 */
  markDispatch(id: string, patch: Partial<Pick<BusDispatch, 'status' | 'runId' | 'error'>>): BusDispatch | undefined {
    const dispatch = this.state.dispatches.find(item => item.id === id || item.messageId === id);
    if (!dispatch) return undefined;
    Object.assign(dispatch, patch, { updated: now() });
    return structuredClone(dispatch);
  }

  dispatchOf(id: string): BusDispatch | undefined {
    const found = this.state.dispatches.find(item => item.id === id || item.messageId === id);
    return found ? structuredClone(found) : undefined;
  }

  /** 结束子任务和登记续接一次落库。续接本身不是子任务，不会再次触发通知。 */
  finishDispatch(
    id: string,
    outcome: { status: 'done' | 'failed'; runId?: string; error?: string },
  ): { status: 'done' | 'failed'; wakeup?: { memberId: string; messageId: string; text: string } } | undefined {
    const dispatch = this.state.dispatches.find(item => item.id === id);
    if (!dispatch) return undefined;
    if (dispatch.status === 'done' || dispatch.status === 'failed') return { status: dispatch.status };
    const { status } = outcome;
    Object.assign(dispatch, outcome, { updated: now() });
    if (dispatch.reason !== 'task_message') return { status };
    const request = dispatch.messageId ? this.messagesById.get(dispatch.messageId) : undefined;
    const sender = request?.sender;
    if (!sender || sender === 'owner' || !this.members.some(member => member.id === sender)) return { status };
    const messageId = `W-${id}`;
    const text = `子任务 ${id} ${outcome.status === 'done' ? '完成' : '失败'}。`;
    this.publish({
      id: messageId, sender: 'system', to: sender, channel: dmChannel(dispatch.owner, sender),
      text, kind: 'system', requiresAction: false, artifactIds: [], taskUpdates: [], resultOf: id,
    });
    this.state.dispatches.push({ id: messageId, messageId, owner: sender, status: 'queued',
      taskId: this.taskOf(sender)?.id ?? '', reason: 'dispatch_result', updated: now() });
    return { status, wakeup: { memberId: sender, messageId, text } };
  }

  wakeupNeeded(id: string): boolean {
    const dispatch = this.state.dispatches.find(item => item.id === id);
    if (dispatch?.reason !== 'dispatch_result') return true;
    return this.messagesById.get(id)?.receipts[dispatch.owner] !== 'processed';
  }

  resultInbox(memberId: string) {
    return this.state.messages.filter(message => message.resultOf && message.to === memberId)
      .slice(-50).reverse().map(message => ({ id: message.id, text: message.text, time: message.time,
        processed: message.receipts[memberId] === 'processed' }));
  }

  attachDispatchArtifacts(memberId: string, runId: string, ids: string[]): void {
    const dispatch = this.state.dispatches.find(item => item.owner === memberId && item.runId === runId);
    if (!dispatch?.messageId || !ids.length) return;
    const message = this.state.messages.find(item => item.id === dispatch.messageId);
    if (message) message.artifactIds = [...new Set([...message.artifactIds, ...ids])];
  }

  recoverableDispatches(): { dispatch: BusDispatch; text: string }[] {
    const direct = this.state.dispatches.filter(item => item.messageId
      && (item.reason === 'task_message' || item.reason === 'dispatch_result')
      && (item.status === 'queued' || item.status === 'running' || item.status === 'claimed'));
    if (!direct.length) return [];
    return direct.flatMap(dispatch => {
      const message = this.messagesById.get(dispatch.messageId!);
      return message?.to === dispatch.owner && (message.requiresAction || message.resultOf)
        ? [{ dispatch: structuredClone(dispatch), text: message.text }]
        : [];
    });
  }

  ack(memberId: string, messageIds: string[]): boolean {
    let changed = false;
    for (const id of messageIds) {
      const message = this.messagesById.get(id);
      const receipt = message?.receipts[memberId];
      if (!message || !receipt || receipt === 'processed') continue;
      message.receipts[memberId] = 'processed';
      changed = true;
    }
    return changed;
  }

  /** 本轮收尾：已排队但没开跑的派工继续留在队列（由下次回合接起），执行中的标未知——都不假装成功。 */
  finish(): void {
    for (const dispatch of this.state.dispatches) {
      if (dispatch.status === 'claimed' || dispatch.status === 'running') {
        dispatch.status = 'unknown';
        dispatch.updated = now();
      }
    }
    for (const task of Object.values(this.state.tasks)) {
      if (task.execution === 'queued' || task.execution === 'running') task.execution = 'unknown';
    }
    for (const message of this.state.messages) {
      if (message.runId !== this.runId) continue;
      for (const [memberId, state] of Object.entries(message.receipts)) {
        if (state === 'queued' || state === 'delivered') message.receipts[memberId] = 'unprocessed';
      }
    }
  }

  // ------------------------------------------------------------------ 频道 / 讨论串 / 私信

  memberList(): BusMember[] {
    return [...this.members];
  }

  isGroupChannel(channelId: string): boolean {
    return channelId === this.channelId || Object.hasOwn(this.state.channels!, channelId);
  }

  canReadChannel(channelId: string, viewer: string): boolean {
    if (channelId === this.channelId) return true;
    if (!Object.hasOwn(this.state.channels!, channelId)) return false;
    const channel = this.state.channels![channelId];
    return Boolean(channel && (viewer === 'owner' || channel.memberIds.includes(viewer)));
  }

  assertCanPost(channelId: string, sender: string): void {
    if (!this.canReadChannel(channelId, sender)) fail('你未加入这个频道');
    if (this.state.channels![channelId]?.archived) fail('频道已归档');
  }

  listChannels(viewer: string): BusChannel[] {
    const main = { id: this.channelId, name: '主线', creator: 'owner', archived: false,
      memberIds: this.members.map(member => member.id) };
    return [main, ...Object.values(this.state.channels!).filter(channel => this.canReadChannel(channel.id, viewer))]
      .map(channel => structuredClone(channel));
  }

  createChannel(viewer: string, name: string, memberIds: string[]): BusChannel {
    const title = name.trim();
    if (!title || title.length > 60) fail('频道名须为 1–60 个字符');
    if (!this.members.some(member => member.id === viewer)) fail('当前成员不在项目中');
    const channel = { id: `ch:${shortId()}`, name: title, creator: viewer,
      memberIds: [...new Set([viewer, ...this.validChannelMembers(memberIds)])], archived: false };
    this.state.channels![channel.id] = channel;
    this.notifyChannelInvite(channel, viewer, channel.memberIds);
    return structuredClone(channel);
  }

  inviteChannel(viewer: string, channelId: string, memberIds: string[]): BusChannel {
    const channel = Object.hasOwn(this.state.channels!, channelId) ? this.state.channels![channelId] : undefined;
    if (!channel) fail('频道不存在或无法调整成员');
    this.assertCanPost(channelId, viewer);
    const added = [...new Set(this.validChannelMembers(memberIds))].filter(id => !channel.memberIds.includes(id));
    channel.memberIds.push(...added);
    this.notifyChannelInvite(channel, viewer, added);
    return structuredClone(channel);
  }

  private notifyChannelInvite(channel: BusChannel, inviter: string, added: string[]): void {
    for (const memberId of added) {
      if (memberId === inviter || memberId === 'owner') continue;
      this.publish({
        id: shortId(), sender: 'system', to: memberId, kind: 'system', requiresAction: false, artifactIds: [], taskUpdates: [],
        channel: dmChannel(inviter, memberId),
        text: `${this.labelOf(inviter)}邀请你加入频道「${channel.name}」（${channel.id}）。用 swarm_channel 读取讨论。`,
      });
    }
  }

  archiveChannel(viewer: string, channelId: string, archived: boolean): BusChannel {
    const channel = Object.hasOwn(this.state.channels!, channelId) ? this.state.channels![channelId] : undefined;
    if (!channel || (viewer !== 'owner' && viewer !== channel.creator)) fail('只有频道创建者或用户可归档');
    channel.archived = archived;
    return structuredClone(channel);
  }

  private validChannelMembers(ids: string[]): string[] {
    if (!Array.isArray(ids) || ids.some(id => !this.members.some(member => member.id === id))) fail('频道成员不在当前项目或任务中');
    return ids;
  }

  /** 系统消息只给收件人看；公开频道对全体可见；私信只对收发双方可见。 */
  visibleTo(message: BusMessage, viewer: string): boolean {
    if (message.sender === 'system') return message.to === viewer;
    if (this.isGroupChannel(message.channel)) return this.canReadChannel(message.channel, viewer);
    return message.sender === viewer || message.to === viewer;
  }

  channelView(viewer: string, channel: string): { roots: BusMessage[]; replies: Record<string, BusMessage[]> } {
    const visible = this.state.messages.filter(
      message => message.runId === this.runId && message.channel === channel && this.visibleTo(message, viewer),
    );
    const roots = visible.filter(message => !message.threadId);
    const replies: Record<string, BusMessage[]> = {};
    for (const message of visible) {
      if (message.threadId) (replies[message.threadId] ??= []).push(message);
    }
    return { roots, replies };
  }

  recentChannelMessages(viewer: string, channelId: string, limit: number, before?: string): BusMessage[] {
    if (!this.canReadChannel(channelId, viewer)) fail('你未加入这个频道');
    const end = before ? this.state.messages.findIndex(message => message.id === before && message.channel === channelId)
      : this.state.messages.length;
    if (end < 0) fail('找不到这条频道消息');
    const result: BusMessage[] = [];
    for (let index = end - 1; index >= 0 && result.length < limit; index--) {
      const message = this.state.messages[index];
      if (message.channel === channelId && this.visibleTo(message, viewer)) result.push(message);
    }
    return result.reverse().map(message => structuredClone(message));
  }

  threadView(viewer: string, rootId: string): { root: BusMessage; replies: BusMessage[] } | undefined {
    const target = this.messagesById.get(rootId);
    if (!target || !this.visibleTo(target, viewer)) return undefined;
    const root = target.threadId ? this.messagesById.get(target.threadId) : target;
    if (!root || !this.visibleTo(root, viewer)) return undefined;
    const replies = this.state.messages.filter(message => message.threadId === root.id && this.visibleTo(message, viewer));
    return { root, replies };
  }

  /** 信箱优先处理指名消息及自己发起的留言串。公开新帖仍可在上下文中读取。 */
  inbox(memberId: string): BusMessage[] {
    const ownRoots = new Set(this.state.messages
      .filter(message => this.isGroupChannel(message.channel) && !message.threadId && message.sender === memberId)
      .map(message => message.id));
    const unread: BusMessage[] = [];
    const publicPosts: BusMessage[] = [];
    for (const message of this.state.messages) {
      const receipt = message.receipts[memberId];
      if (!this.visibleTo(message, memberId)) continue;
      if (this.isGroupChannel(message.channel) && message.threadId && !message.requiresAction) {
        if (ownRoots.has(message.threadId) && message.sender !== memberId
          && (receipt === 'available' || receipt === 'delivered')) unread.push(message);
      } else if (receipt === 'queued' || receipt === 'available' || (message.resultOf && receipt === 'delivered')) {
        (this.isGroupChannel(message.channel) && !message.requiresAction ? publicPosts : unread).push(message);
      }
    }
    return [...unread, ...publicPosts];
  }

  /** 取走这个成员的信箱并把回执推进到 delivered；超过 limit 的留在队列，失败不推进。 */
  takeInbox(memberId: string, limit = 16): BusMessage[] {
    const taken = this.inbox(memberId).slice(0, Math.max(1, limit));
    for (const message of taken) message.receipts[memberId] = 'delivered';
    return taken.map(message => structuredClone(message));
  }

  /** 新成员加入时补一条自己的任务；已存在的成员不重复绑定。 */
  addMember(member: BusMember): BusTask {
    if (this.members.some(item => item.id === member.id)) fail('成员已存在');
    this.members.push(member);
    const task: BusTask = {
      id: `T-${shortId()}`,
      runId: this.runId,
      attemptId: randomUUID().replace(/-/g, ''),
      owner: member.id,
      ownerLabel: member.label,
      execution: 'queued',
      report: 'none',
      acceptance: 'pending',
      version: 0,
      evidence: [],
      next: '',
      blocker: '',
      updated: now(),
    };
    const rootTask = this.taskOf(this.members[0].id);
    if (rootTask) task.parentId = rootTask.id;
    this.state.tasks[task.id] = task;
    return task;
  }

  /** 成员离开项目（会话被移走或删除）：摘掉成员与任务，历史消息保留；未执行的派工作废。 */
  removeMember(memberId: string): void {
    const index = this.members.findIndex(member => member.id === memberId);
    if (index < 0) return;
    this.members.splice(index, 1);
    for (const channel of Object.values(this.state.channels!)) {
      channel.memberIds = channel.memberIds.filter(id => id !== memberId);
    }
    const task = this.taskOf(memberId);
    if (task) delete this.state.tasks[task.id];
    for (const dispatch of this.state.dispatches) {
      if (dispatch.owner === memberId && (dispatch.status === 'queued' || dispatch.status === 'paused')) {
        dispatch.status = 'failed';
        dispatch.error = '成员已离开项目';
        dispatch.updated = now();
      }
    }
    if (this.state.cursors) delete this.state.cursors[memberId];
  }

  /** 派工队列里属于这个成员、仍在等待的条目。 */
  pendingDispatches(memberId: string): { owner: string; taskId: string; status: string; reason: string }[] {
    return this.state.dispatches.filter(dispatch => dispatch.owner === memberId && dispatch.status === 'queued');
  }
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    return trimmed.split('\n').slice(1, -1).join('\n');
  }
  return text;
}

/** 私信频道 id 由双方 id 决定，第三个成员拿不到这个频道，也就看不到内容。 */
export function dmChannel(first: string, second: string): string {
  for (const [a, b] of [[first, second], [second, first]]) {
    if (a === 'owner' && b !== 'owner') return `dm:owner|${b}`;
  }
  return `dm:${[first, second].sort().join('|')}`;
}
