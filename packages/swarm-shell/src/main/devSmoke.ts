/**
 * 开发期冒烟入口：只有设置了 SWARM_SMOKE_DIR 才执行，产品正常运行不会走到这里。
 * 它调用与界面完全相同的 store / RunManager 路径，把真实宿主的回合跑完，并把事件、会话、
 * 成果和总线快照写成可复核的 smoke-report.json。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunManager } from './runner';
import type { ProjectRecord, SessionRecord, SwarmStore } from './store';
import { OWNER, type TeamService } from '../../../swarm-team/src/service';

export interface SmokePlan {
  project: ProjectRecord;
  session: SessionRecord;
  prompt: string;
  host: string;
  model: string;
  peer?: SessionRecord;
  promptB?: string;
  /** 长会话 + 忙时排队场景：跑一段、发更新、给忙碌成员再派一条。 */
  queue?: boolean;
}

export interface SmokeDeps {
  team: TeamService;
  dispatch: (input: { projectId: string; memberId: string; messageId: string; text: string }) => Promise<void>;
}

const QUEUE_PROMPT =
  '在当前工作目录创建 notes.md，按顺序写五节：目标、现状、方案、风险、结论。每节先写标题，再写至少 150 字的正文；写完后把文件用 swarm_artifact 登记，并用 swarm_report 报 submitted。' +
  '上下文只在开始时用 swarm_context 读一次，不要反复整份拉取；中途有新要求再按需读增量。';

const QUEUE_UPDATE = '补充要求：notes.md 需要再包含一节「验收记录」，写清验证方式和结果；这一节请在提交前补上。';
const QUEUE_DISPATCH = '先 swarm_context 取增量看有没有新要求，再按新要求更新 notes.md；保留已有内容，新增「队列验证」一节，完成后重新用 swarm_artifact 登记同一路径并报 submitted。';

export function smokeEnabled(): boolean {
  return Boolean(process.env.SWARM_SMOKE_DIR);
}

/** 窗口加载前先把项目和成员落库，界面打开时就能按正常入口选中它们。 */
export function prepareSmoke(store: SwarmStore): SmokePlan | null {
  if (!smokeEnabled()) return null;
  const workspace = path.resolve(process.env.SWARM_SMOKE_DIR as string);
  const host = process.env.SWARM_SMOKE_HOST ?? 'CodeBuddy';
  const model = process.env.SWARM_SMOKE_MODEL ?? 'hy3';
  const queue = process.env.SWARM_SMOKE_QUEUE === '1';
  const prompt = process.env.SWARM_SMOKE_PROMPT ?? (queue ? QUEUE_PROMPT : '在当前工作目录创建 smoke-report.md，写明：独立蜂群第一次真实链路已经跑通。然后用一句话说明你写到了哪个绝对路径。');
  const project = store.createProject('冒烟验收', workspace);
  const existing = store.listSessions(project.id).find(item => item.host === host && item.member_label === '开发');
  const session = existing ?? store.createSession({ projectId: project.id, memberLabel: '开发', host, model, title: '冒烟' });

  let peer: SessionRecord | undefined;
  let promptB: string | undefined;
  if (process.env.SWARM_SMOKE_PEER === '1') {
    const found = store.listSessions(project.id).find(item => item.host === host && item.member_label === '验收');
    peer = found ?? store.createSession({ projectId: project.id, memberLabel: '验收', host, model, title: '收信冒烟' });
    // PEER_ONLY=1 时只准备成员，由 Agent 自己用 swarm_dispatch 触发，避免重复跑一遍
    promptB =
      process.env.SWARM_SMOKE_PEER_ONLY === '1'
        ? undefined
        : (process.env.SWARM_SMOKE_PROMPT_B ??
          '先调用 swarm_inbox 取你的信；把收到的第一条消息的消息 ID 和正文原样写进 receipt.md；然后用 swarm_ack 确认这条消息，并用 swarm_say 回复发件人一句「已收到 <消息 ID>」。');
  }
  return { project, session, prompt, host, model, peer, promptB, queue };
}

async function waitRun(store: SwarmStore, runId: string, timeoutMs = 300_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = store.run(runId);
    if (current && current.status !== 'running') return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('300 秒内未收尾，保留 store 里的原始事件供复核');
}

function assertLog(store: SwarmStore, message: string): void {
  appendFileSync(path.join(path.dirname(store.file), 'shell.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function describeRun(store: SwarmStore, runId: string) {
  const run = store.run(runId)!;
  const events = store.events(runId);
  const kinds = events.reduce<Record<string, number>>((counts, event) => {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }, {});
  return {
    runId: run.id,
    sessionId: run.session_id,
    hostSessionId: store.session(run.session_id)?.host_session_id ?? null,
    promptChars: run.prompt.length,
    status: run.status,
    seconds: run.seconds,
    error: run.error,
    replyText: run.reply_text,
    eventCounts: kinds,
    providerUsage: events.filter(event => event.kind === 'usage').map(event => JSON.parse(event.payload)),
  };
}

export async function runSmoke(store: SwarmStore, runner: RunManager, plan: SmokePlan, deps?: SmokeDeps): Promise<void> {
  const runOrder: string[] = [];
  const queueLog: { updateMessageId?: string; dispatchMessageId?: string; runningAtDispatch?: string[]; queueAtDispatch?: number } = {};
  const started = Date.now();
  try {
    const runA = await runner.start({
      projectId: plan.project.id,
      sessionId: plan.session.id,
      prompt: plan.prompt,
      model: plan.model,
    });
    runOrder.push(runA.id);

    if (plan.queue && deps) {
      // 让第一个回合先真正跑起来，再发更新和派工：这时成员一定在忙，派工只能进队列。
      await new Promise(resolve => setTimeout(resolve, 10_000));
      queueLog.runningAtDispatch = store.runningRuns(plan.project.id).map(run => run.id);
      const update = deps.team.post({
        projectId: plan.project.id,
        from: OWNER,
        to: 'all',
        text: QUEUE_UPDATE,
        requiresAction: false,
      });
      queueLog.updateMessageId = update.messageIds[0];
      const assigned = deps.team.post({
        projectId: plan.project.id,
        from: OWNER,
        to: plan.session.id,
        text: QUEUE_DISPATCH,
        requiresAction: true,
      });
      queueLog.dispatchMessageId = assigned.messageIds[0];
      if (queueLog.dispatchMessageId) {
        await deps.dispatch({
          projectId: plan.project.id,
          memberId: plan.session.id,
          messageId: queueLog.dispatchMessageId,
          text: QUEUE_DISPATCH,
        });
      }
      assertLog(store, `排队场景：更新 ${queueLog.updateMessageId}，派工 ${queueLog.dispatchMessageId}，派工时在跑 ${queueLog.runningAtDispatch.join(',') || '无'}`);
    }

    await waitRun(store, runA.id);

    if (plan.peer && plan.promptB) {
      const runB = await runner.start({
        projectId: plan.project.id,
        sessionId: plan.peer.id,
        prompt: plan.promptB,
        model: plan.model,
      });
      runOrder.push(runB.id);
      await waitRun(store, runB.id);
    }

    // 由 Agent 自己派工触发的回合不在 runOrder 里，等它们也收尾再写回执
    const deadline = Date.now() + 300_000;
    await new Promise(resolve => setTimeout(resolve, 10_000));
    while (store.runningRuns(plan.project.id).length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 排队派工要等它自己的状态收尾，不能只看"此刻没有 running"
    if (plan.queue && queueLog.dispatchMessageId) {
      const queueDeadline = Date.now() + 300_000;
      while (Date.now() < queueDeadline) {
        const snapshot = store.loadBusState(plan.project.id) as { state?: { dispatches?: { id?: string; messageId?: string; status: string }[] } } | undefined;
        const dispatch = snapshot?.state?.dispatches?.find(item => item.id === queueLog.dispatchMessageId || item.messageId === queueLog.dispatchMessageId);
        if (dispatch && (dispatch.status === 'done' || dispatch.status === 'failed')) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      while (store.runningRuns(plan.project.id).length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    for (const run of store.projectRuns(plan.project.id)) {
      if (!runOrder.includes(run.id)) runOrder.push(run.id);
    }
  } catch (error) {
    appendFileSync(path.join(path.dirname(store.file), 'shell.log'), `[${new Date().toISOString()}] 冒烟异常：${(error as Error).message}\n`, 'utf8');
  }

  const bus = store.loadBusState(plan.project.id) as
    | { runId: string; state: { messages: any[]; tasks: any; artifacts: any[]; dispatches: any[]; cursors?: Record<string, any> } }
    | undefined;
  const report = {
    projectId: plan.project.id,
    workspace: plan.project.workspace,
    host: plan.host,
    model: plan.model,
    sessionId: plan.session.id,
    peerSessionId: plan.peer?.id ?? null,
    elapsedSeconds: (Date.now() - started) / 1000,
    queue: plan.queue ? queueLog : null,
    runs: runOrder.map(runId => describeRun(store, runId)),
    bus: bus
      ? {
          runId: bus.runId,
          messages: bus.state.messages.map(message => ({
            id: message.id,
            sender: message.sender,
            to: message.to,
            channel: message.channel,
            threadId: message.threadId,
            text: message.text,
            receipts: message.receipts,
            artifactIds: message.artifactIds,
          })),
          tasks: bus.state.tasks,
          artifacts: bus.state.artifacts,
          dispatches: bus.state.dispatches,
          cursors: bus.state.cursors,
        }
      : null,
    artifacts: store
      .listArtifacts(plan.session.id)
      .map(item => ({ name: item.name, path: item.path, size: item.size, verified: item.verified })),
    finishedAt: new Date().toISOString(),
  };
  const file = path.join(path.dirname(store.file), 'smoke-report.json');
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  appendFileSync(path.join(path.dirname(store.file), 'shell.log'), `[${new Date().toISOString()}] 冒烟结束：${file}\n`, 'utf8');
  console.log(`[swarm-smoke] 完成：${file}`);
}
