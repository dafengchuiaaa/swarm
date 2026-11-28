/**
 * 一次真实宿主回合的调度：事件分流、会话绑定、成果核验、失败留痕。
 *
 * 三条硬规则：
 * 1. 思考 / 工具 / 正文 / 完成状态分别走不同事件，绝不混成一段文本。
 * 2. 宿主返回的会话 ID 由独立版自己记录，续接只认这里记的 ID。
 * 3. 回复里说"已生成"不算数——成果必须真实存在且能被打开，才登记为已核实。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HostBridge, HostEvent, HostRunRequest } from '../../../swarm-hosts/src/hostBridge';
import type { ArtifactRecord, RunRecord, SessionRecord, SwarmStore } from './store';
import { type CompactionDecision, type CompactionEventPayload, compactionDecision, isStageTask } from './compaction';

type Emit = (channel: string, payload: unknown) => void;

interface ActiveRun {
  runId: string;
  projectId: string;
  sessionId: string;
  workspace: string;
  seq: number;
  startedAt: number;
  body: string;
  notices: string[];
  toolPaths: string[];
  token?: string;
  handoffProbe?: boolean;
}

/** 主进程提供给 RunManager 的工具接线：每次 run 一个 token，结束即吊销。 */
export interface ToolBinding {
  issue(projectId: string, memberId: string, runId: string): { token: string; url: string; pendingInbox?: number };
  revoke(token: string): void;
  server: { command: string; args: string[] };
}

const TOOL_HOSTS = new Set(['CodeBuddy', 'Antigravity', 'Qoder']);

const ARTIFACT_PATH = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/])[^"'`<>|*?\r\n]+)\1|(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|*?\r\n]+/g;

function normalise(candidate: string): string {
  return candidate.replace(/[),.;]+$/g, '').replace(/\\/g, path.sep);
}

function insideWorkspace(candidate: string, workspace: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsInText(text: string, workspace: string): string[] {
  return [...text.matchAll(ARTIFACT_PATH)].map(match => path.resolve(workspace, match[2] ?? normalise(match[0])));
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly store: SwarmStore,
    private readonly bridge: HostBridge,
    private readonly emit: Emit,
    private readonly tools?: ToolBinding,
    private readonly handoff?: (sessionId: string, decision: CompactionDecision) => void,
  ) {
    this.bridge.on('event', (event: HostEvent) => this.onHostEvent(event));
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  runningSession(sessionId: string): string | undefined {
    for (const [runId, active] of this.active) if (active.sessionId === sessionId) return runId;
    return undefined;
  }

  /** 发起一次真实任务。runId 由独立版生成，天然区分项目、会话和宿主会话 ID。 */
  async start(input: {
    projectId: string;
    sessionId: string;
    prompt: string;
    runId?: string;
    wakeup?: boolean;
    handoffProbe?: boolean;
    model?: string;
    effort?: string;
  }): Promise<RunRecord> {
    const project = this.store.project(input.projectId);
    if (!project) throw new Error('项目不存在');
    const session = this.store.session(input.sessionId);
    if (!session) throw new Error('成员会话不存在');
    if (session.project_id !== project.id) throw new Error('成员会话不属于当前项目');
    if (this.runningSession(session.id)) throw new Error('该成员已有正在运行的任务');
    const effectiveWorkspace =
      session.worktree_path && existsSync(session.worktree_path) ? session.worktree_path : project.workspace;
    if (!existsSync(effectiveWorkspace)) throw new Error(`工作区不存在：${effectiveWorkspace}`);

    const run = this.store.startRun({ id: input.runId, projectId: project.id, sessionId: session.id, prompt: input.prompt });
    const active: ActiveRun = {
      runId: run.id,
      projectId: project.id,
      sessionId: session.id,
      workspace: effectiveWorkspace,
      seq: 0,
      startedAt: Date.now(),
      body: '',
      notices: [],
      toolPaths: [],
      handoffProbe: input.handoffProbe,
    };
    this.active.set(run.id, active);

    if (input.model || input.effort) {
      this.store.updateSessionMeta(session.id, { model: input.model ?? session.model, effort: input.effort ?? session.effort });
    }

    let toolsConfig: HostRunRequest['tools'];
    let pendingInbox = 0;
    if (!input.handoffProbe && TOOL_HOSTS.has(session.host) && this.tools) {
      const issued = this.tools.issue(project.id, this.store.collaborationMemberId(session.id), run.id);
      pendingInbox = issued.pendingInbox ?? 0;
      active.token = issued.token;
      toolsConfig = {
        command: this.tools.server.command,
        args: this.tools.server.args,
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SWARM_BUS_URL: issued.url,
          SWARM_BUS_TOKEN: issued.token,
        },
      };
    }

    const prompt = toolsConfig
      ? input.wakeup
        ? `${input.prompt} swarm_read 取结果，处理后 swarm_ack 并续办。`
        : withCollaboration(project.name, session, input.prompt, pendingInbox)
      : input.prompt;
    const request: HostRunRequest = {
      host: session.host,
      prompt,
      model: input.model ?? session.model,
      sessionId: session.host_session_id ?? null,
      workspace: effectiveWorkspace,
      effort: input.effort ?? session.effort,
      accessMode: 'danger-full-access',
      tools: toolsConfig,
    };

    this.emit('run:start', { run, session });
    void this.bridge
      .run(run.id, request)
      .then(reply => this.complete(run.id, reply))
      .catch(error => this.fail(run.id, error));
    return run;
  }

  cancel(runId: string): void {
    if (!this.active.has(runId)) return;
    this.bridge.cancel(runId);
  }

  steer(runId: string, text: string): void {
    this.bridge.steer(runId, text);
  }

  private onHostEvent(event: HostEvent): void {
    const run = this.active.get(event.runId);
    if (!run) return;
    run.seq += 1;
    try {
      this.store.appendEvent(run.runId, run.seq, event.kind, event.payload);
    } catch (error) {
      // 持久化失败不能中断正在跑的回合；界面仍按实时事件继续推进。
      console.error(`记录回合事件失败（${event.kind}）：${(error as Error).message}`);
    }

    switch (event.kind) {
      case 'chunk': {
        const delta = typeof event.payload === 'string' ? event.payload : '';
        run.body += delta;
        break;
      }
      case 'session': {
        if (typeof event.payload === 'string' && event.payload) this.store.bindHostSession(run.sessionId, event.payload);
        break;
      }
      case 'notice': {
        if (typeof event.payload === 'string') run.notices.push(event.payload);
        break;
      }
      case 'execution_event': {
        this.collectToolPaths(run, event.payload);
        break;
      }
      case 'usage': {
        this.onUsage(run, event.payload);
        break;
      }
      case 'compact': {
        this.onCompact(run, event.payload);
        break;
      }
      default:
        break;
    }
    this.emit('run:event', { runId: run.runId, kind: event.kind, payload: event.payload, seq: run.seq });
  }

  /** 占用上报只更新检测进度，不碰回合 token：两者口径不同，混一起会误判压缩。 */
  private onUsage(run: ActiveRun, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const session = this.store.session(run.sessionId);
    if (!session) return;
    const usage = payload as { context_used?: unknown; context_size?: unknown; compaction_replay?: boolean };
    if (usage.compaction_replay) return;
    const used = typeof usage.context_used === 'number' ? usage.context_used : undefined;
    const size = typeof usage.context_size === 'number' ? usage.context_size : undefined;
    if (used === undefined && size === undefined) return;
    this.store.recordCompaction({
      sessionId: run.sessionId,
      projectId: run.projectId,
      host: session.host,
      hostSessionId: session.host_session_id,
      path: 'estimate',
      contextUsed: used,
      contextSize: size,
    });
  }

  /** 压缩信号：宿主明确事件才计数；判到接近第二次压缩时，等本轮收尾再换会话。 */
  private onCompact(run: ActiveRun, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const session = this.store.session(run.sessionId);
    if (!session) return;
    const event = payload as CompactionEventPayload;
    const result = this.store.recordCompaction({
      sessionId: run.sessionId,
      projectId: run.projectId,
      host: session.host,
      hostSessionId: session.host_session_id,
      path: event.path,
      phase: event.phase,
      messageId: event.message_id,
      compactType: event.compact_type,
      contextUsed: event.context_used,
      contextSize: event.context_size,
      budget: event.budget,
      baselineUsed: event.baseline_used,
      baselineSize: event.baseline_size,
      invalidateUsage: event.invalidate_usage,
    });
    const decision = compactionDecision(result.state);
    this.emit('run:compact', {
      runId: run.runId,
      sessionId: run.sessionId,
      event,
      counted: result.counted,
      reason: result.reason,
      state: result.state,
      decision,
    });
  }

  /** 回合边界判定接手：不在工具调用中途换会话，也不强杀正在写文件的回合。 */
  private maybeHandoff(sessionId: string): void {
    if (!this.handoff) return;
    const state = this.store.compactionState(sessionId);
    if (!state || state.handoff_state === 'failed') return;
    const member = this.store.collaborationMemberId(sessionId);
    const goal = this.store.sessionRuns(member)[0]?.prompt ?? '';
    const decision = compactionDecision(state, isStageTask(goal));
    if (decision.level !== 'handoff' && decision.level !== 'limit' && decision.level !== 'stage') return;
    this.handoff(sessionId, decision);
  }

  private collectToolPaths(run: ActiveRun, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const summary = (payload as Record<string, unknown>).parameters_summary;
    if (!summary || typeof summary !== 'object') return;
    const rawInput = (summary as Record<string, unknown>).raw_input;
    const rawOutput = (summary as Record<string, unknown>).raw_output;
    for (const value of [rawInput, rawOutput]) {
      if (!value) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      for (const candidate of pathsInText(text, run.workspace)) run.toolPaths.push(candidate);
    }
  }

  private complete(runId: string, reply: { text: string; sessionId: string; model: string; seconds: number }): void {
    const active = this.active.get(runId);
    if (!active) return;
    this.active.delete(runId);
    this.revoke(active);
    const seconds = reply.seconds ?? (Date.now() - active.startedAt) / 1000;
    const text = reply.text || active.body;
    this.store.finishRun(runId, 'done', text, '', seconds);
    if (reply.sessionId) this.store.bindHostSession(active.sessionId, reply.sessionId);

    const artifacts = this.registerArtifacts(active, text);
    const missing = this.claimedButMissing(active, text, artifacts);

    if (!active.handoffProbe) this.maybeHandoff(active.sessionId);
    this.emit('run:done', {
      runId,
      reply: { text, sessionId: reply.sessionId, model: reply.model, seconds },
      artifacts,
      missing,
    });
  }

  private fail(runId: string, error: Error): void {
    const active = this.active.get(runId);
    if (!active) return;
    this.active.delete(runId);
    this.revoke(active);
    const message = `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`;
    this.store.finishRun(runId, 'failed', active.body, message, (Date.now() - active.startedAt) / 1000);
    this.store.appendEvent(runId, active.seq + 1, 'error', { message });
    if (!active.handoffProbe) this.maybeHandoff(active.sessionId);
    this.emit('run:error', { runId, error: message, partial: active.body });
  }

  private revoke(active: ActiveRun): void {
    if (active.token && this.tools) this.tools.revoke(active.token);
    active.token = undefined;
  }

  /** 只登记真实存在于工作区内的文件；目录、越界路径和不存在的一律不算成果。 */
  private registerArtifacts(active: ActiveRun, replyText: string): ArtifactRecord[] {
    const candidates = [...pathsInText(replyText, active.workspace), ...active.toolPaths];
    if (!candidates.length) return [];
    let workspace: string;
    try {
      workspace = realpathSync.native(active.workspace);
    } catch {
      return [];
    }
    const existing = new Set(this.store.listArtifacts(active.sessionId).map(item => item.path.toLowerCase()));
    const created: ArtifactRecord[] = [];
    for (const candidate of candidates) {
      if (created.length >= 20) break;
      if (!insideWorkspace(candidate, active.workspace)) continue;
      try {
        const realPath = realpathSync.native(candidate);
        if (!insideWorkspace(realPath, workspace) || existing.has(realPath.toLowerCase())) continue;
        const stat = statSync(realPath);
        if (!stat.isFile()) continue;
        const artifact = this.store.addArtifact({
          project_id: active.projectId,
          session_id: active.sessionId,
          run_id: active.runId,
          name: path.basename(candidate),
          path: realPath,
          size: stat.size,
          verified: 1,
        });
        existing.add(realPath.toLowerCase());
        created.push(artifact);
      } catch {
        continue;
      }
    }
    return created;
  }

  /** 回复声称生成了文件、但磁盘上没有：明确报出来，不让"已完成"蒙混过去。 */
  private claimedButMissing(active: ActiveRun, replyText: string, artifacts: ArtifactRecord[]): string[] {
    const verified = new Set(artifacts.map(item => item.path.toLowerCase()));
    return pathsInText(replyText, active.workspace)
      .filter(candidate => insideWorkspace(candidate, active.workspace))
      .filter(candidate => !verified.has(candidate.toLowerCase()))
      .filter(candidate => !existsSync(candidate))
      .slice(0, 10);
  }
}

export function describeSession(session: SessionRecord): string {
  return `${session.member_label} · ${session.host} · ${session.model}${session.effort ? ` · ${session.effort}` : ''}`;
}

/** 接上工具的成员，开局就知道自己的身份、可用工具和交付要求；不接工具的宿主原样传任务。 */
export function withCollaboration(projectName: string, session: SessionRecord, prompt: string, pendingInbox = 0): string {
  return [
    `【蜂群协作】你是项目「${projectName}」的成员「${session.member_label}」（成员 ID：${session.id}）。`,
    ...(pendingInbox > 0 ? [`本次开跑时信箱有 ${pendingInbox} 条指名消息或公告栏回复待看。先调用 swarm_inbox，检查是否有人回复了你先前的问题。相关意见纳入当前判断，需要继续讨论时回原帖；已处理的消息用 swarm_ack 确认，暂时未处理的回复留给后续回合。`] : []),
    '你的目标是和团队把任务做好。出现信息缺口、关键判断不确定、连续尝试没有进展，或有适合独立复核、并行的子任务时，主动找最合适的成员。把你已知的情况、需要对方回答的问题和预期结果说清楚，然后继续推进你能独立完成的部分。简单明确的工作直接做。已经有人处理的事避免重复派工。',
    '需要对方实际处理问题时用 swarm_dispatch。已有成员传 to、text。用户指定的宿主或模型还没有成员席时可传 host、model、text。使用蜂群工具启动成员。派工 ID 表示请求已发出，拿到答复后再核对并整合结果。',
    '留言板发新帖用 swarm_say({text})，回复现有留言用 swarm_say({thread: "原留言消息 ID", text})。请另一位成员回复时，用 swarm_dispatch({to, text, thread: "原留言消息 ID"})，请求投递到对方信箱。收件成员先看请求里的留言引用，需要原文时用 swarm_read，再自行决定并发布回复。共享键值 swarm_board_write 用于记录状态或数值。',
    '任务依赖其他成员、提到公告栏或需要回复时，先用 swarm_context 查看与任务有关的更新，需要原文时用 swarm_read。看到别人向你求助，在能提供信息、纠错或复核时主动回答，回复发回对应信箱或原留言串。按返回示例确认回执。文件用 swarm_artifact 登记，进度用 swarm_report 汇报。',
    '需要集思广益时，先说清要做的决定、已知约束、目前缺哪方面的意见。用公告栏发一条大家都能参考的留言，点名请最合适的成员分别回答具体问题；需要他们本轮开跑时，发信箱派工并附上原留言。请成员把意见回在原帖下，方便其他人补充或质疑。你可以同时推进不依赖答复的部分。',
    '讨论适合单独开群时，用 swarm_channel 的 list 查看已有频道，或用 create 开专题频道并选择相关成员。用 swarm_say 的 channel 参数在该群发新帖，回复用 thread。入群只加入讨论，需要对方启动回合时仍走信箱派工。',
    '提交结论前，用 swarm_context 检查是否收到意见，需要细节再用 swarm_read 回读。说明哪条意见改变了你的判断，分歧还剩什么。如果关键答复还没回来，交代暂时结论和待确认的问题；无需反复刷新或把已派工写成已取得意见。',
    '',
    '【本次任务】',
    prompt,
  ].join('\n');
}
