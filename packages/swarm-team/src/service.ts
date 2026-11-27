/**
 * 蜂群自己的协作服务：频道、讨论串、私信、共享板、任务回执和派工队列。
 *
 * 语义来自旧蜂群的 `collaboration_bus.py`（已移植为 collaborationBus.ts），
 * 这里只做三件事：把成员/项目绑到真实会话和工作区、把状态落进 SQLite、给界面和
 * Agent 工具面提供同一套入口。身份不靠参数自报：每个 run 的 token 只能代表自己的成员。
 */
import { CollaborationBus, dmChannel } from './collaborationBus';
import type { AcceptResult, BusCursor, BusDispatch, BusMember, BusMessage, BusState, BoardEntry, Envelope } from './collaborationBus';
import path from 'node:path';

export const OWNER = 'owner';

export interface TeamProject {
  id: string;
  workspace: string;
  name: string;
  kind?: string;
}

export interface TeamSession {
  id: string;
  member_label: string;
  group_id?: string;
  parent_session_id?: string | null;
  host: string;
  model: string;
  host_session_id: string | null;
}

export interface TeamDeps {
  project: (projectId: string) => TeamProject | undefined;
  sessions: (projectId: string) => TeamSession[];
  load: (projectId: string) => { channelId: string; runId: string; state: BusState } | undefined;
  save: (projectId: string, snapshot: { channelId: string; runId: string; state: BusState }) => void;
  readRunResult?: (runId: string) => string | undefined;
}

export interface DecorateMessage {
  id: string;
  sender: string;
  senderLabel: string;
  to: string;
  toLabel: string;
  text: string;
  time: string;
  kind: BusMessage['kind'];
  evidence: string[];
  artifactIds: string[];
  requiresAction: boolean;
  receipts: BusMessage['receipts'];
  taskId: string | null;
  threadId?: string;
  dispatch?: { id: string; status: string; error?: string; runId?: string };
}

export const defaultChannel = (projectId: string): string => `ch:${projectId}:main`;

export class TeamService {
  private readonly cache = new Map<string, CollaborationBus>();
  private readonly busKeys = new WeakMap<CollaborationBus, string>();

  constructor(private readonly deps: TeamDeps) {}

  // 普通项目共用一个总线，自由对话容器以任务组区分。旧容器快照不分发给任何新板。
  private key(projectId: string, sessionId?: string): string {
    if (!sessionId || this.deps.project(projectId)?.kind !== 'inbox') return projectId;
    const sessions = this.deps.sessions(projectId);
    const session = sessions.find(item => item.id === sessionId);
    if (!session) throw new Error('会话不在当前项目');
    return this.sessionKey(projectId, session, sessions);
  }

  private sessionKey(projectId: string, session: TeamSession, sessions: TeamSession[]): string {
    let root = session;
    const visited = new Set([root.id]);
    while ((!root.group_id || root.group_id === projectId) && root.parent_session_id) {
      const parent = sessions.find(item => item.id === root.parent_session_id);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      root = parent;
    }
    const group = root.group_id;
    return projectId + '/' + (group && group !== projectId ? group : root.id);
  }

  private scopedSessions(projectId: string, key: string): TeamSession[] {
    const sessions = this.deps.sessions(projectId);
    return key === projectId ? sessions : sessions.filter(session => this.sessionKey(projectId, session, sessions) === key);
  }

  bus(projectId: string, sessionId?: string): CollaborationBus {
    const key = this.key(projectId, sessionId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const project = this.deps.project(projectId);
    if (!project) throw new Error('项目不存在');
    const saved = this.deps.load(key);
    const sessions = this.scopedSessions(projectId, key);
    const members: BusMember[] = [{ id: OWNER, label: '我' }, ...sessions.map(item => ({ id: item.id, label: item.member_label }))];
    const boundMembers = saved ? new Set(Object.values(saved.state.tasks).map(task => task.owner)) : undefined;
    const bus = new CollaborationBus(members.filter(member => !boundMembers || member.id === OWNER || boundMembers.has(member.id)), {
      workspace: project.workspace,
      state: saved?.state,
      runId: saved?.runId,
      channelId: saved?.channelId ?? defaultChannel(key),
    });
    for (const session of sessions) {
      if (!bus.taskOf(session.id)) bus.addMember({ id: session.id, label: session.member_label });
    }
    this.cache.set(key, bus);
    this.busKeys.set(bus, key);
    return bus;
  }

  /** 旧闲散会话只恢复自身最早的用户任务，不能从混用的项目板猜归属。 */
  ensureOpeningMessage(
    projectId: string,
    sessionId: string,
    firstUserPrompt: (sessionIds: string[]) => string | undefined,
  ): boolean {
    const key = this.key(projectId, sessionId);
    if (key === projectId) return false;
    const bus = this.bus(projectId, sessionId);
    if (bus.channelView(OWNER, bus.channelId).roots.some(message => message.sender === OWNER)) return false;
    const text = firstUserPrompt(this.scopedSessions(projectId, key).map(session => session.id))?.trim();
    if (!text) return false;
    this.post({ projectId, sessionId, from: OWNER, to: 'all', text });
    return true;
  }

  projectBuses(projectId: string): CollaborationBus[] {
    const buses = new Set([this.bus(projectId)]);
    if (this.deps.project(projectId)?.kind === 'inbox') {
      const sessions = this.deps.sessions(projectId);
      const seen = new Set<string>();
      for (const session of sessions) {
        const key = this.sessionKey(projectId, session, sessions);
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.cache.has(key) || this.deps.load(key)) buses.add(this.bus(projectId, session.id));
      }
    }
    return [...buses];
  }

  private persist(bus: CollaborationBus): void {
    // New keys are derived from the project and task group, even for an existing legacy channel ID.
    const key = this.busKeys.get(bus);
    if (!key) throw new Error('协作总线尚未绑定');
    this.deps.save(key, { channelId: bus.channelId, runId: bus.runId, state: bus.snapshot() });
  }

  refreshMembers(projectId: string): void {
    for (const [key, bus] of this.cache) {
      if (key !== projectId && !key.startsWith(projectId + '/')) continue;
      const sessions = this.scopedSessions(projectId, key);
      for (const session of sessions) {
        if (!bus.taskOf(session.id)) bus.addMember({ id: session.id, label: session.member_label });
      }
      const keep = new Set([OWNER, ...sessions.map(item => item.id)]);
      for (const member of bus.memberList()) {
        if (!keep.has(member.id)) bus.removeMember(member.id);
      }
      this.persist(bus);
    }
  }

  forget(projectId: string): void {
    for (const key of this.cache.keys()) {
      if (key === projectId || key.startsWith(projectId + '/')) this.cache.delete(key);
    }
  }

  labelOf(projectId: string, memberId: string): string {
    if (memberId === OWNER) return '我';
    const session = this.deps.sessions(projectId).find(item => item.id === memberId);
    return session?.member_label ?? memberId;
  }

  private memberLabels(projectId: string): Map<string, string> {
    const labels = new Map(this.deps.sessions(projectId).map(item => [item.id, item.member_label] as const));
    labels.set(OWNER, '我');
    return labels;
  }

  /** 发一条消息：`to='all'` 落在项目频道，指定成员则落进双方私信频道。 */
  post(input: {
    projectId: string;
    from: string;
    sessionId?: string;
    to?: string;
    text: string;
    thread?: string;
    channel?: string;
    evidence?: string[];
    requiresAction?: boolean;
    eventId?: string;
  }): AcceptResult {
    const bus = this.bus(input.projectId, input.from === OWNER ? input.sessionId ?? (input.to !== 'all' ? input.to : undefined) : input.from);
    const thread = input.thread ? bus.threadView(input.from, input.thread) : undefined;
    if (input.thread && !thread) throw new Error('讨论串不存在或当前成员不可见');
    const publicThread = thread && bus.isGroupChannel(thread.root.channel);
    if (input.channel && !bus.isGroupChannel(input.channel)) throw new Error('频道不存在');
    if (input.channel && thread && input.channel !== thread.root.channel) throw new Error('回复与频道不一致');
    const boardReference = input.requiresAction && publicThread ? thread?.root : undefined;
    const to = !input.requiresAction && publicThread ? 'all'
      : thread && !publicThread && (!input.to || input.to === 'all')
        ? (thread.root.sender === input.from ? thread.root.to : thread.root.sender)
        : input.to ?? 'all';
    let text = input.text;
    if (boardReference) {
      bus.assertCanPost(boardReference.channel, input.from);
      if (to === 'all') throw new Error('请指定接收派工的成员');
      if (!bus.canReadChannel(boardReference.channel, to)) throw new Error('请先把收件成员加入频道');
      const author = boardReference.sender === OWNER ? '用户'
        : boardReference.sender === 'system' ? '系统' : this.labelOf(input.projectId, boardReference.sender);
      const summary = boardReference.text.replace(/\s+/g, ' ').trim();
      const preview = summary.length > 160 ? summary.slice(0, 160) + '…' : summary;
      text += `\n\n关联公告栏留言（ID：${boardReference.id}，作者：${author}）\n摘要：${preview}`;
    }
    const envelope: Envelope = {
      result: text,
      messages: [
        {
          to,
          text,
          requires_action: input.requiresAction ?? to !== 'all',
          channel: boardReference ? undefined : publicThread ? thread.root.channel : input.channel,
          thread: boardReference ? undefined : thread?.root.id,
          evidence: input.evidence,
        },
      ],
    };
    const accepted = bus.accept(input.from, JSON.stringify(envelope), { eventId: input.eventId });
    this.persist(bus);
    return accepted;
  }

  writeBoard(input: { projectId: string; from: string; key: string; value: string; expectedVersion: number; eventId?: string }): AcceptResult {
    const bus = this.bus(input.projectId, input.from);
    const envelope = {
      result: `更新共享板 ${input.key}`,
      updates: [{ key: input.key, value: input.value, expected_version: input.expectedVersion }],
    };
    const accepted = bus.accept(input.from, JSON.stringify(envelope), { eventId: input.eventId });
    this.persist(bus);
    return accepted;
  }

  report(input: {
    projectId: string;
    from: string;
    progress: 'in_progress' | 'submitted' | 'blocked';
    evidence?: string[];
    next?: string;
    blocker?: string;
    eventId?: string;
  }): AcceptResult {
    const bus = this.bus(input.projectId, input.from);
    const envelope = {
      result: `任务进度：${input.progress}${input.next ? `；下一步 ${input.next}` : ''}${input.blocker ? `；阻塞 ${input.blocker}` : ''}`,
      task_updates: [
        { progress: input.progress, evidence: input.evidence ?? [], next: input.next, blocker: input.blocker },
      ],
    };
    const accepted = bus.accept(input.from, JSON.stringify(envelope), { eventId: input.eventId });
    this.persist(bus);
    return accepted;
  }

  submitArtifact(input: { projectId: string; from: string; name: string; path?: string; content?: string; eventId?: string; runId?: string }): AcceptResult {
    const bus = this.bus(input.projectId, input.from);
    const envelope = {
      result: `交付：${input.name}`,
      artifacts: [{ name: input.name, path: input.path, content: input.content }],
    };
    const accepted = bus.accept(input.from, JSON.stringify(envelope), { eventId: input.eventId });
    if (input.runId) bus.attachDispatchArtifacts(input.from, input.runId, accepted.artifactIds);
    this.persist(bus);
    return accepted;
  }

  takeInbox(projectId: string, memberId: string, limit = 16): BusMessage[] {
    const bus = this.bus(projectId, memberId);
    const messages = bus.takeInbox(memberId, limit);
    this.persist(bus);
    return messages;
  }

  pendingInbox(projectId: string, memberId: string): number {
    const bus = this.bus(projectId, memberId);
    return bus.inbox(memberId).filter(message =>
      !bus.isGroupChannel(message.channel) || message.threadId || message.requiresAction,
    ).length;
  }

  ack(projectId: string, memberId: string, messageIds: string[]): void {
    const bus = this.bus(projectId, memberId);
    bus.ack(memberId, messageIds);
    this.persist(bus);
  }

  board(projectId: string, sessionId?: string): Record<string, BoardEntry> {
    return this.bus(projectId, sessionId).board();
  }

  /** 总线里的成果：路径相对工作区，这里补回绝对路径给界面打开。 */
  artifacts(projectId: string, sessionId?: string) {
    const workspace = this.deps.project(projectId)?.workspace ?? '';
    const artifacts = (sessionId ? [this.bus(projectId, sessionId)] : this.projectBuses(projectId)).flatMap(bus => bus.artifacts());
    const labels = this.memberLabels(projectId);
    return artifacts.map(artifact => ({
      ...artifact,
      memberLabel: labels.get(artifact.owner) ?? artifact.owner,
      absolutePath: artifact.path ? path.resolve(workspace, artifact.path) : undefined,
    }));
  }

  /** 成员及其任务状态，界面用来显示"待接/在跑/已交/被阻塞"。 */
  members(projectId: string, sessionId?: string) {
    const bus = this.bus(projectId, sessionId);
    return bus.memberList().map(member => {
      const inbox = bus.inbox(member.id);
      return { ...member, task: bus.taskOf(member.id) ?? null, unread: inbox.length,
        resultUnread: inbox.filter(message => message.resultOf).length,
        channel: member.id === OWNER ? bus.channelId : dmChannel(OWNER, member.id) };
    });
  }

  taskOf(projectId: string, memberId: string) {
    return this.bus(projectId, memberId).taskOf(memberId);
  }

  private decode(bus: CollaborationBus, labels: Map<string, string>, message: BusMessage): DecorateMessage {
    const dispatch = message.requiresAction ? bus.dispatchOf(message.id) : undefined;
    return {
      id: message.id,
      sender: message.sender,
      senderLabel: message.sender === 'system' ? '系统' : labels.get(message.sender) ?? message.sender,
      to: message.to,
      toLabel: message.to === 'all' ? '全体' : labels.get(message.to) ?? message.to,
      text: message.text,
      time: message.time,
      kind: message.kind,
      evidence: message.evidence ?? [],
      artifactIds: message.artifactIds ?? [],
      requiresAction: message.requiresAction,
      receipts: message.receipts,
      taskId: bus.taskOf(message.sender)?.id ?? null,
      threadId: message.threadId,
      dispatch: dispatch
        ? { id: dispatch.id, status: dispatch.status, error: dispatch.error, runId: dispatch.runId }
        : undefined,
    };
  }

  channels(projectId: string, sessionId?: string): { id: string; name: string; kind: 'channel' | 'dm'; memberId?: string;
    memberIds?: string[]; archived?: boolean; main?: boolean }[] {
    const bus = this.bus(projectId, sessionId);
    const result: ReturnType<TeamService['channels']> = bus.listChannels(OWNER)
      .map(channel => ({ ...channel, kind: 'channel', main: channel.id === bus.channelId }));
    for (const session of this.scopedSessions(projectId, this.key(projectId, sessionId))) {
      result.push({ id: dmChannel(OWNER, session.id), name: session.member_label, kind: 'dm', memberId: session.id });
    }
    return result;
  }

  manageChannel(input: { projectId: string; sessionId?: string; from: string; operation: 'create' | 'invite' | 'archive' | 'restore';
    name?: string; channelId?: string; memberIds?: string[] }) {
    const bus = this.bus(input.projectId, input.from === OWNER ? input.sessionId : input.from);
    const { from, operation } = input;
    const channel = operation === 'create' ? bus.createChannel(from, input.name ?? '', input.memberIds ?? [])
      : operation === 'invite' ? bus.inviteChannel(from, input.channelId ?? '', input.memberIds ?? [])
      : bus.archiveChannel(from, input.channelId ?? '', operation === 'archive');
    this.persist(bus);
    return channel;
  }

  agentChannels(projectId: string, memberId: string) {
    return this.bus(projectId, memberId).listChannels(memberId);
  }

  readChannel(projectId: string, memberId: string, channelId: string, limit: number, before?: string) {
    const bus = this.bus(projectId, memberId);
    const labels = this.memberLabels(projectId);
    return bus.recentChannelMessages(memberId, channelId, limit, before)
      .map(message => this.decode(bus, labels, message));
  }

  view(projectId: string, viewer: string, channel?: string, sessionId?: string) {
    const bus = this.bus(projectId, viewer === OWNER ? sessionId : viewer);
    const target = channel ?? bus.channelId;
    const { roots, replies } = bus.channelView(viewer, target);
    const labels = this.memberLabels(projectId);
    return {
      channel: target,
      roots: roots.map(message => this.decode(bus, labels, message)),
      replies: Object.fromEntries(
        Object.entries(replies).map(([rootId, list]) => [rootId, list.map(message => this.decode(bus, labels, message))]),
      ),
    };
  }

  thread(projectId: string, viewer: string, rootId: string, sessionId?: string) {
    const bus = this.bus(projectId, viewer === OWNER ? sessionId : viewer);
    const view = bus.threadView(viewer, rootId);
    if (!view) return undefined;
    const labels = this.memberLabels(projectId);
    return { root: this.decode(bus, labels, view.root), replies: view.replies.map(message => this.decode(bus, labels, message)) };
  }

  /**
   * 增量上下文：会员只拿到还没送过的任务差异、板变化、定向消息和待派工，
   * 返回条目和字符量便于核对注入规模。收到回执后再保存游标。
   */
  context(projectId: string, memberId: string, limit = 8) {
    const bus = this.bus(projectId, memberId);
    const task = bus.taskOf(memberId);
    const delta = bus.takeContext(memberId, limit, false);
    return {
      project: this.deps.project(projectId)?.name ?? projectId,
      workspace: this.deps.project(projectId)?.workspace ?? '',
      channel: bus.channelId,
      task: task
        ? { id: task.id, version: task.version, report: task.report, acceptance: task.acceptance, next: task.next, blocker: task.blocker }
        : null,
      members: bus.memberList(),
      items: delta.items,
      pending: delta.pending,
      remaining: delta.remaining,
      metrics: delta.metrics,
      cursor: delta.cursor,
    };
  }

  confirmContext(projectId: string, memberId: string, cursor: BusCursor): void {
    const bus = this.bus(projectId, memberId);
    bus.confirmContext(memberId, cursor);
    this.persist(bus);
  }

  readMessages(projectId: string, memberId: string, ids: string[], maxChars?: number, offset = 0) {
    return this.bus(projectId, memberId)
      .readMessages(memberId, ids, maxChars, offset, this.deps.readRunResult)
      .map(message => ({ ...message, senderLabel: this.labelOf(projectId, message.sender) }));
  }

  markDispatch(projectId: string, id: string, patch: Partial<Pick<BusDispatch, 'status' | 'runId' | 'error'>>): BusDispatch | undefined {
    const bus = this.projectBuses(projectId).find(item => item.dispatchOf(id));
    if (!bus) return undefined;
    const updated = bus.markDispatch(id, patch);
    this.persist(bus);
    return updated;
  }

  dispatchOf(projectId: string, id: string): BusDispatch | undefined {
    return this.projectBuses(projectId).find(bus => bus.dispatchOf(id))?.dispatchOf(id);
  }

  finishDispatch(projectId: string, id: string, outcome: { status: 'done' | 'failed'; runId?: string; error?: string }) {
    const bus = this.projectBuses(projectId).find(item => item.dispatchOf(id));
    if (!bus) return undefined;
    const wakeup = bus.finishDispatch(id, outcome);
    this.persist(bus);
    return wakeup;
  }

  wakeupNeeded(projectId: string, id: string): boolean {
    return this.projectBuses(projectId).find(item => item.dispatchOf(id))?.wakeupNeeded(id) ?? true;
  }

  resultInbox(projectId: string, memberId: string) {
    return this.bus(projectId, memberId).resultInbox(memberId);
  }
}
