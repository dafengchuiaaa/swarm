import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SwarmStore } from '../../../packages/swarm-shell/src/main/store';
import { RunManager } from '../../../packages/swarm-shell/src/main/runner';
import { HostBridge, type HostRunRequest } from '../../../packages/swarm-hosts/src/hostBridge';
import { BusGateway } from '../../../packages/swarm-shell/src/main/busServer';
import { OWNER, TeamService, type TeamDeps } from '../../../packages/swarm-team/src/service';

const dirs: string[] = [];

function openStore(): { dir: string; store: SwarmStore } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarm-store-'));
  dirs.push(dir);
  return { dir, store: new SwarmStore(dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(store: SwarmStore) {
  const project = store.createProject('蜂群任务', 'D:/work/example');
  const session = store.createSession({ projectId: project.id, memberLabel: '开发', host: 'CodeBuddy', model: 'hy3' });
  store.bindHostSession(session.id, 'host-session-1');
  return { project, session };
}

it('从 SQLite 恢复已有 256 条消息的项目后，仍能回复旧帖并再次恢复', () => {
  const { dir, store } = openStore();
  const { project } = seed(store);
  function service(database: SwarmStore): TeamService {
    return new TeamService({
      project: id => database.project(id),
      sessions: id => database.listSessions(id),
      load: id => database.loadBusState(id) as ReturnType<TeamDeps['load']>,
      save: (id, snapshot) => database.saveBusState(id, snapshot),
    });
  }
  let rootId: string;
  try {
    const team = service(store);
    [rootId] = team.post({ projectId: project.id, from: OWNER, text: '首帖' }).messageIds;
    for (let index = 2; index <= 256; index += 1) {
      team.post({ projectId: project.id, from: OWNER, text: `消息 ${index}` });
    }
  } finally {
    store.close();
  }

  const reopened = new SwarmStore(dir);
  try {
    const team = service(reopened);
    const [replyId] = team.post({ projectId: project.id, from: OWNER, text: '回复首帖', thread: rootId }).messageIds;
    expect(service(reopened).thread(project.id, OWNER, rootId)?.replies.map(message => message.id)).toEqual([replyId]);
    expect(service(reopened).bus(project.id).snapshot().messages).toHaveLength(257);
  } finally {
    reopened.close();
  }
});

it('运行器登记链接工作区内的产物，并保留缺失文件提示和思考事件', async () => {
  const { dir, store } = openStore();
  try {
    const realWorkspace = path.join(realpathSync.native(dir), 'workspace');
    const workspace = path.join(dir, 'alias');
    mkdirSync(realWorkspace);
    symlinkSync(realWorkspace, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    const project = store.createProject('成果验收', workspace);
    const session = store.createSession({ projectId: project.id, memberLabel: '开发', host: 'CodeBuddy', model: 'hy3' });
    const report = path.join(realWorkspace, '验收 记录.md');
    writeFileSync(report, '验收完成');
    const reportedPath = process.platform === 'win32' ? report : './验收 记录.md';
    const bridge = new class extends HostBridge {
      override async run(runId: string) {
        this.emit('event', { runId, kind: 'reasoning', payload: '准备核对成果' });
        this.emit('event', { runId, kind: 'chunk', payload: `交付 "${reportedPath}"，待补 \`./待补.md\`。` });
        return { text: '', sessionId: '', model: '', seconds: 0 };
      }
    }();
    const finished = await new Promise<{ runId: string; missing: string[] }>((resolve, reject) => {
      const runner = new RunManager(store, bridge, (channel, payload) => {
        if (channel === 'run:done') resolve(payload as { runId: string; missing: string[] });
        if (channel === 'run:error') reject(new Error((payload as { error: string }).error));
      });
      void runner.start({ projectId: project.id, sessionId: session.id, prompt: '登记验收文件' }).catch(reject);
    });
    expect(store.listArtifacts(session.id)).toMatchObject([{ path: realpathSync.native(report), verified: 1 }]);
    expect(finished.missing).toEqual([path.join(workspace, '待补.md')]);
    expect(store.events(finished.runId).map(event => event.kind)).toEqual(['reasoning', 'chunk']);
  } finally {
    store.close();
  }
});

it.each([false, true])('开场附带待看消息且省掉取信调用（结果唤醒 %s）', async wakeup => {
  const { dir, store } = openStore();
  const project = store.createProject('团队协作', dir);
  const member = store.createSession({ projectId: project.id, memberLabel: '开发', host: 'CodeBuddy', model: 'test' });
  const team = new TeamService({
    project: id => store.project(id),
    sessions: id => store.listSessions(id),
    load: id => store.loadBusState(id) as ReturnType<TeamDeps['load']>,
    save: (id, snapshot) => store.saveBusState(id, snapshot),
  });
  const [dispatchId] = team.post({ projectId: project.id, from: OWNER, to: member.id, text: '主派工' }).messageIds;
  const [messageId] = team.post({ projectId: project.id, from: OWNER, to: member.id, text: '补充约束' }).messageIds;
  team.post({ projectId: project.id, from: OWNER, to: 'all', text: '一般公告' });
  let toolCalls = 0;
  const gateway = new BusGateway(team, undefined, () => { toolCalls += 1; });
  const requests: HostRunRequest[] = [];
  let receiptBeforeAck: string | undefined;
  let ackResult: unknown;
  const bridge = new class extends HostBridge {
    override async run(_id: string, request: HostRunRequest) {
      requests.push(request);
      if (requests.length === 1) {
        receiptBeforeAck = team.bus(project.id).inbox(member.id)
          .find(message => message.id === messageId)?.receipts[member.id];
        const response = await fetch(`${request.tools?.env.SWARM_BUS_URL}/tool`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${request.tools?.env.SWARM_BUS_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: 'swarm_ack', args: { message_ids: [messageId] } }),
        });
        ackResult = await response.json();
      }
      return { text: '收到', sessionId: '', model: '', seconds: 0 };
    }
  }();
  try {
    await gateway.listen();
    const runner = new RunManager(store, bridge, () => {}, {
      issue: (...args) => gateway.issue(...args),
      revoke: token => gateway.revoke(token),
      server: { command: 'node', args: ['server.mjs'] },
    });
    const firstRun = await runner.start({ projectId: project.id, sessionId: member.id, prompt: '主派工', dispatchId, wakeup });
    await vi.waitFor(() => expect(runner.isRunning(firstRun.id)).toBe(false));
    const first = requests[0];
    expect(first.prompt.match(/主派工/g)).toHaveLength(1);
    expect(first.prompt).toContain(`[${messageId}]`);
    expect(first.prompt).toContain('补充约束');
    expect(first.prompt).not.toContain('一般公告');
    if (wakeup) expect(first.prompt).toContain('swarm_read 取结果');
    expect(receiptBeforeAck).toBe('queued');
    expect(ackResult).toMatchObject({ ok: true });
    expect(toolCalls).toBe(1);
    const emptyRun = await runner.start({ projectId: project.id, sessionId: member.id, prompt: '主派工', dispatchId, wakeup });
    await vi.waitFor(() => expect(runner.isRunning(emptyRun.id)).toBe(false));
    expect(requests[1].prompt).not.toContain('【开场信箱】');
    expect(requests[1].prompt).not.toContain('swarm_inbox');
    expect(toolCalls).toBe(1);
  } finally {
    (gateway as unknown as { http: { close: () => void } }).http.close();
    store.close();
  }
});

describe('会话整理状态', () => {
  it('改名、置顶、分组、归档落库，重启后保持，且不改写成员和宿主续接 ID', () => {
    const { dir, store } = openStore();
    const { project, session } = seed(store);
    const meta = store.updateConversationMeta({
      projectId: project.id,
      sessionId: session.id,
      title: '发行核查',
      pinned: true,
      groupName: '发行',
    });
    expect(meta.pinned).toBe(1);
    expect(meta.archived).toBe(0);
    store.close();

    const reopened = new SwarmStore(dir);
    const list = reopened.listConversationMeta(project.id);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('发行核查');
    expect(list[0].group_name).toBe('发行');

    const record = reopened.session(session.id)!;
    expect(record.member_label).toBe('开发');
    expect(record.host).toBe('CodeBuddy');
    expect(record.host_session_id).toBe('host-session-1');

    const archived = reopened.updateConversationMeta({ projectId: project.id, sessionId: session.id, archived: true, pinned: false });
    expect(archived.pinned).toBe(0);
    expect(archived.archived).toBe(1);
    expect(archived.group_name).toBe('发行');
    expect(archived.title).toBe('发行核查');
    reopened.close();
  });

  it('只改分组时不动标题，只改标题时不动分组', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    store.updateConversationMeta({ projectId: project.id, sessionId: session.id, title: '标题 A', groupName: '组 A' });
    const second = store.updateConversationMeta({ projectId: project.id, sessionId: session.id, groupName: '组 B' });
    expect(second.title).toBe('标题 A');
    expect(second.group_name).toBe('组 B');
    const third = store.updateConversationMeta({ projectId: project.id, sessionId: session.id, title: '标题 B' });
    expect(third.group_name).toBe('组 B');
    expect(third.title).toBe('标题 B');
    store.close();
  });
});

describe('会话内搜索', () => {
  it('只沿同一会话的回合检索提问、回复和正文事件，按回合先后返回', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const other = store.createSession({ projectId: project.id, memberLabel: '验收', host: 'CodeBuddy', model: 'hy3' });

    const first = store.startRun({ projectId: project.id, sessionId: session.id, prompt: '排查缓存问题' });
    store.appendEvent(first.id, 1, 'reasoning', '先确认缓存键');
    store.appendEvent(first.id, 2, 'chunk', '缓存');
    store.finishRun(first.id, 'done', '已经修好缓存', '', 1.2);
    const second = store.startRun({ projectId: project.id, sessionId: session.id, prompt: '再检查缓存命中率' });
    store.finishRun(second.id, 'done', '无新增问题', '', 0.8);
    const outside = store.startRun({ projectId: project.id, sessionId: other.id, prompt: '缓存不是这条会话的' });
    store.finishRun(outside.id, 'done', '', '', 0.1);

    const hits = store.searchSession(session.id, '缓存');
    expect(hits.map(hit => [hit.runId, hit.field])).toEqual([
      [first.id, 'prompt'],
      [first.id, 'reply'],
      [first.id, 'reasoning'],
      [first.id, 'chunk'],
      [second.id, 'prompt'],
    ]);
    expect(hits[0].index).toBe(2);
    expect(hits.every(hit => hit.runId !== outside.id)).toBe(true);
    expect(store.searchSession(session.id, '   ')).toEqual([]);

    const rounds = store.sessionRuns(session.id);
    expect(rounds.map(run => run.id)).toEqual([first.id, second.id]);
    store.close();
  });

  it('英文关键词忽略大小写，同一段正文的多次命中按位置排列', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const run = store.startRun({ projectId: project.id, sessionId: session.id, prompt: 'Fix Cache and cache again' });
    store.finishRun(run.id, 'done', 'cache fixed', '', 0.5);
    const hits = store.searchSession(session.id, 'CACHE');
    expect(hits.map(hit => [hit.field, hit.index])).toEqual([
      ['prompt', 4],
      ['prompt', 14],
      ['reply', 0],
    ]);
    store.close();
  });
});

describe('会话回合读取', () => {
  it('分享用的回合列表包含提问和回复，按时间正序', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const first = store.startRun({ projectId: project.id, sessionId: session.id, prompt: '第一问' });
    store.finishRun(first.id, 'done', '第一答', '', 1);
    const second = store.startRun({ projectId: project.id, sessionId: session.id, prompt: '第二问' });
    store.finishRun(second.id, 'failed', '第二答不完整', '宿主中断', 2);
    const rounds = store.sessionRuns(session.id);
    expect(rounds.map(run => [run.prompt, run.reply_text])).toEqual([['第一问', '第一答'], ['第二问', '第二答不完整']]);
    store.close();
  });
});
