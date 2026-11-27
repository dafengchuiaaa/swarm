import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunManager } from '../../../packages/swarm-shell/src/main/runner';
import type { HostBridge, HostReply, HostRunRequest } from '../../../packages/swarm-hosts/src/hostBridge';
import { SwarmStore } from '../../../packages/swarm-shell/src/main/store';
import { buildHandoffFacts, compactionDecision, renderHandoffBrief, startHandoff, finishHandoff, isStageTask } from '../../../packages/swarm-shell/src/main/compaction';

const dirs: string[] = [];

function openStore(): { dir: string; store: SwarmStore } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarm-compaction-'));
  dirs.push(dir);
  return { dir, store: new SwarmStore(dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(store: SwarmStore, workspace = 'D:/work/example') {
  const project = store.createProject('压缩验收', workspace);
  const session = store.createSession({ projectId: project.id, memberLabel: '开发', host: 'CodeBuddy', model: 'hy3' });
  store.bindHostSession(session.id, 'host-A');
  const run = store.startRun({ projectId: project.id, sessionId: session.id, prompt: '把压缩检测补齐并落盘成果' });
  store.finishRun(run.id, 'done', '已产出 notes.md', '', 12);
  return { project, session, run };
}

/** 模拟宿主发出的成对压缩事件：开始半截标签，完成闭合。 */
function compactOnce(store: SwarmStore, sessionId: string, projectId: string, hostSessionId: string, messageId: string, type = 'auto', context = 400_000, size = 960_000) {
  const common = { sessionId, projectId, host: 'CodeBuddy', hostSessionId };
  store.recordCompaction({ ...common, path: 'live', phase: 'start', messageId, compactType: type, contextUsed: context, contextSize: size });
  return store.recordCompaction({ ...common, path: 'live', phase: 'done', messageId, compactType: type, contextUsed: context, contextSize: size });
}

describe('压缩计数', () => {
  it('成对事件只计一次，重复完成与历史重放都不再加数', () => {
    const { store } = openStore();
    const { project, session } = seed(store);

    const first = compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    expect(first.counted).toBe(true);
    expect(first.state.confirmed_count).toBe(1);
    expect(first.state.baseline_used).toBe(400_000);

    const duplicate = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'live', phase: 'done', messageId: 'compact-maxtoken-A-1', compactType: 'auto',
    });
    expect(duplicate.counted).toBe(false);
    expect(duplicate.reason).toBe('duplicate');
    expect(duplicate.state.confirmed_count).toBe(1);

    const replay = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'replay', phase: 'done', messageId: 'compact-maxtoken-A-2',
    });
    expect(replay.counted).toBe(false);
    expect(replay.reason).toBe('replay-ignored');
    expect(replay.state.confirmed_count).toBe(1);
    store.close();
  });

  it('交错重扫 A、B、A 不会把 A 计成两次', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'A');
    compactOnce(store, session.id, project.id, 'host-A', 'B');
    const repeated = compactOnce(store, session.id, project.id, 'host-A', 'A');
    expect(repeated.counted).toBe(false);
    expect(repeated.state.confirmed_count).toBe(2);
    store.close();
  });

  it('阶段任务在首次自动压缩后收口，长程任务继续观察', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'auto');
    const { state } = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'estimate', contextUsed: 80_000, contextSize: 960_000,
    });
    expect(isStageTask('【团队目标】【阶段性任务】核对开场')).toBe(true);
    expect(isStageTask('从材料中读出“阶段性任务”')).toBe(false);
    expect(compactionDecision(state, true).level).toBe('stage');
    expect(compactionDecision(state).level).toBe('none');
    store.close();
  });

  it('手动 /compact 记账但不计入自动容量压缩', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const result = compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-manual', 'manual');
    expect(result.state.confirmed_count).toBe(1);
    expect(result.state.manual_count).toBe(1);
    expect(compactionDecision(result.state).autoCount).toBe(0);
    store.close();
  });

  it('宿主会话换了就重新起算，旧计数不延续', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    const afterSwitch = compactOnce(store, session.id, project.id, 'host-B', 'compact-maxtoken-B-1');
    expect(afterSwitch.state.host_session_id).toBe('host-B');
    expect(afterSwitch.state.confirmed_count).toBe(1);
    store.close();
  });

  it('重启后检测进度还在，计数不变', () => {
    const { dir, store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    store.close();

    const reopened = new SwarmStore(dir);
    const state = reopened.compactionState(session.id)!;
    expect(state.confirmed_count).toBe(1);
    expect(state.baseline_used).toBe(400_000);
    const again = reopened.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'live', phase: 'done', messageId: 'compact-maxtoken-A-1', compactType: 'auto',
    });
    expect(again.state.confirmed_count).toBe(1);
    reopened.close();
  });
});

describe('接近第二次压缩的判定', () => {
  it('宿主报触顶即判定接手，不等百分比', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    const limit = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A', path: 'live', phase: 'limit',
    });
    const decision = compactionDecision(limit.state);
    expect(decision.level).toBe('limit');
    expect(decision.basis).toContain('compact-limit-reached');
    store.close();
  });

  it('以首次实测点为基准判第二次：未到点不动，到点才接手', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1', 'auto', 400_000, 960_000);

    store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'estimate', contextUsed: 300_000, contextSize: 960_000,
    });
    expect(compactionDecision(store.compactionState(session.id)!).level).toBe('none');

    store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'estimate', contextUsed: 380_000, contextSize: 960_000,
    });
    const decision = compactionDecision(store.compactionState(session.id)!);
    expect(decision.level).toBe('handoff');
    expect(decision.basis).toContain('首次压缩实测点');
    store.close();
  });

  it('未确认首次压缩就不自动接手', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'estimate', contextUsed: 900_000, contextSize: 960_000,
    });
    expect(compactionDecision(store.compactionState(session.id)!).level).toBe('none');
    store.close();
  });
});

describe('没有压缩广播的宿主：估算档', () => {
  it('占用回落到容量的两成以上才记一次估算，且不写进已确认', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const common = { sessionId: session.id, projectId: project.id, host: 'Antigravity', hostSessionId: 'agy-1', path: 'estimate' as const };

    store.recordCompaction({ ...common, contextUsed: 900_000, contextSize: 1_048_576 });
    const small = store.recordCompaction({ ...common, contextUsed: 700_000, contextSize: 1_048_576 });
    expect(small.state.estimate_count).toBe(0);

    const drop = store.recordCompaction({ ...common, contextUsed: 300_000, contextSize: 1_048_576 });
    expect(drop.state.estimate_count).toBe(1);
    expect(drop.state.confirmed_count).toBe(0);
    store.close();
  });

  it('抓到压缩回落并按实测单轮增长预留两轮后，判接手', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    const common = { sessionId: session.id, projectId: project.id, host: 'Antigravity', hostSessionId: 'agy-1', path: 'estimate' as const };

    store.recordCompaction({ ...common, contextUsed: 900_000, contextSize: 1_048_576 });
    store.recordCompaction({ ...common, contextUsed: 300_000, contextSize: 1_048_576 });
    expect(compactionDecision(store.compactionState(session.id)!).level).toBe('watch');

    // 回落之后又长了一轮：增长 200,000，余量按两轮算约 38%
    store.recordCompaction({ ...common, contextUsed: 500_000, contextSize: 1_048_576 });
    expect(compactionDecision(store.compactionState(session.id)!).level).toBe('none');

    store.recordCompaction({ ...common, contextUsed: 700_000, contextSize: 1_048_576 });
    const decision = compactionDecision(store.compactionState(session.id)!);
    expect(decision.level).toBe('handoff');
    expect(decision.basis).toContain('估算');
    expect(decision.basis).toContain('预留两轮');
    store.close();
  });

  it('没有回落证据就不自动接手，首次压缩允许继续', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'Antigravity', hostSessionId: 'agy-1',
      path: 'estimate', contextUsed: 980_000, contextSize: 1_048_576,
    });
    const decision = compactionDecision(store.compactionState(session.id)!);
    expect(decision.level).toBe('none');
    expect(decision.basis).toContain('还没有压缩回落证据');
    store.close();
  });
});

describe('新会话接手', () => {
  it('换出真实的新席位，旧席位与新会话 ID 不同且旧历史仍可读', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'CodeBuddy', hostSessionId: 'host-A',
      path: 'estimate', contextUsed: 380_000, contextSize: 960_000,
    });

    const result = startHandoff(store, session.id, { pendingDispatches: ['队列还有 1 条'] });
    expect(result.ok).toBe(true);
    expect(result.toSessionId).toBeTruthy();
    expect(result.toSessionId).not.toBe(session.id);

    const successor = store.session(result.toSessionId!)!;
    expect(successor.parent_session_id).toBe(session.id);
    expect(successor.member_label).toBe(session.member_label);
    expect(successor.host_session_id).toBeNull();
    expect(successor.group_id).toBe(session.group_id);

    const old = store.session(session.id)!;
    expect(old.host_session_id).toBe('host-A');
    expect(store.sessionRuns(session.id)).toHaveLength(1);
    expect(store.successorOf(session.id)).toBeUndefined();
    expect(store.compactionState(session.id)!.handoff_state).toBe('requested');
    const takeover = store.startRun({ projectId: project.id, sessionId: successor.id, prompt: result.brief! });
    store.bindHostSession(successor.id, 'host-B');
    store.finishRun(takeover.id, 'done', '已接手。', '', 1);
    expect(finishHandoff(store, session.id, takeover.id)).toBeUndefined();
    expect(store.successorOf(session.id)).toBe(successor.id);
    expect(store.collaborationMemberId(successor.id)).toBe(session.id);
    store.close();
  });

  it('Codex rollout 与 Qoder compact_boundary 的记录形状，按普通自动压缩只计一次', () => {
    const { store } = openStore();
    const { project, session } = seed(store);

    const codex = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'GPT / Codex', hostSessionId: 'codex-thread-1',
      path: 'live', phase: 'done', messageId: 'codex-compact:codex-thread-1:2304',
      compactType: '', contextUsed: 120_000, contextSize: 258_400,
    });
    expect(codex.counted).toBe(true);
    expect(codex.reason).toBe('auto');
    expect(codex.state.confirmed_count).toBe(1);

    const qoder = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'Qoder CLI', hostSessionId: 'codex-thread-1',
      path: 'live', phase: 'done', messageId: 'qoder-compact:thread-1:uuid-1',
      compactType: '', contextUsed: 90_000, contextSize: 200_000,
    });
    expect(qoder.counted).toBe(true);
    expect(qoder.state.confirmed_count).toBe(2);

    const rescan = store.recordCompaction({
      sessionId: session.id, projectId: project.id, host: 'Qoder CLI', hostSessionId: 'codex-thread-1',
      path: 'live', phase: 'done', messageId: 'qoder-compact:thread-1:uuid-1', compactType: '',
    });
    expect(rescan.counted).toBe(false);
    expect(rescan.reason).toBe('duplicate');
    expect(rescan.state.confirmed_count).toBe(2);
    store.close();
  });

  it('只接一次：重复触发不再开新会话', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    const first = startHandoff(store, session.id);
    expect(first.ok).toBe(true);
    const second = startHandoff(store, session.id);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('不重复');
    expect(store.successorOf(session.id)).toBeUndefined();
    store.recoverInterruptedHandoffs();
    expect(store.compactionState(session.id)?.handoff_state).toBe('failed');
    expect(store.successorOf(session.id)).toBeUndefined();
    store.close();
  });

  it('宿主回合失败后不把待办转给新席位', () => {
    const { store } = openStore();
    const { project, session } = seed(store);
    compactOnce(store, session.id, project.id, 'host-A', 'compact-maxtoken-A-1');
    const requested = startHandoff(store, session.id);
    const takeover = store.startRun({ projectId: project.id, sessionId: requested.toSessionId!, prompt: requested.brief! });
    store.finishRun(takeover.id, 'failed', '', '宿主退出', 1);
    expect(finishHandoff(store, session.id, takeover.id, '宿主退出')).toBe('宿主退出');
    expect(store.compactionState(session.id)?.handoff_state).toBe('failed');
    expect(store.successorOf(session.id)).toBeUndefined();
    expect(store.session(session.id)?.host_session_id).toBe('host-A');
    store.close();
  });

  it('交接不成时保留旧席位与待办，只留可读原因', () => {
    const { store } = openStore();
    const project = store.createProject('空任务', 'D:/work/example');
    const session = store.createSession({ projectId: project.id, memberLabel: '开发', host: 'CodeBuddy', model: 'hy3' });
    const result = startHandoff(store, session.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有可交接的目标');
    expect(store.session(session.id)).toBeDefined();
    expect(store.successorOf(session.id)).toBeUndefined();
    store.close();
  });

  it('交接材料取自记录：目标、成果路径、在途派工都在，不靠模型回忆', () => {
    const { store } = openStore();
    const { project, session, run } = seed(store);
    store.addArtifact({
      project_id: project.id, session_id: session.id, run_id: run.id,
      name: 'notes.md', path: 'D:/work/example/notes.md', size: 5446, verified: 1,
    });
    const facts = buildHandoffFacts(store, session.id, { pendingDispatches: ['队列 1 条'] });
    expect(facts.goal).toContain('压缩检测');
    expect(facts.artifacts).toEqual([{ path: 'D:/work/example/notes.md', verified: true }]);
    expect(facts.dispatches).toEqual(['队列 1 条']);
    const brief = renderHandoffBrief(store.session(session.id), facts);
    expect(brief).toContain('D:/work/example/notes.md');
    expect(brief).toContain('【成果路径】');
    expect(brief).toContain('不要重复已完成的派工');
    store.close();
  });
});

it('旧回合释放队列之前发出交接，运行入口把交接正文送到新宿主会话', async () => {
  const { dir, store } = openStore();
  const { project, session } = seed(store, dir);
  const requests: HostRunRequest[] = [];
  const bridge = Object.assign(new EventEmitter(), {
    run(_id: string, request: HostRunRequest): Promise<HostReply> {
      requests.push(request);
      return Promise.resolve({ text: requests.length === 1 ? '旧回合结束' : '已接手', model: 'hy3',
        sessionId: requests.length === 1 ? 'host-A' : 'host-B', seconds: 1 });
    },
  });
  const takeoverId = 'takeover-test';
  const events: string[] = [];
  const runner = new RunManager(store, bridge as unknown as HostBridge, (kind, payload) => {
    if (kind !== 'run:done') return;
    const { runId } = payload as { runId: string };
    if (runId === takeoverId) {
      expect(finishHandoff(store, session.id, runId)).toBeUndefined();
      events.push('confirmed');
    } else {
      expect(store.compactionState(session.id)?.handoff_state).toBe('requested');
      expect(store.successorOf(session.id)).toBeUndefined();
      events.push('settled-old');
    }
  }, undefined, from => {
    const result = startHandoff(store, from, { unread: ['信箱 result-42'] });
    expect(result.ok).toBe(true);
    void runner.start({ runId: takeoverId, projectId: project.id, sessionId: result.toSessionId!,
      prompt: result.brief!, handoffProbe: true });
  });
  compactOnce(store, session.id, project.id, 'host-A', 'limit-boundary');
  store.recordCompaction({ sessionId: session.id, projectId: project.id, host: 'CodeBuddy',
    hostSessionId: 'host-A', phase: 'limit' });
  await runner.start({ projectId: project.id, sessionId: session.id, prompt: '当前回合' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(events).toEqual(['settled-old', 'confirmed']);
  expect(requests[0].sessionId).toBe('host-A');
  expect(requests[1].sessionId).toBeNull();
  expect(requests[1].prompt).toContain('把压缩检测补齐并落盘成果');
  expect(requests[1].prompt).toContain('信箱 result-42');
  expect(store.session(store.successorOf(session.id)!)?.host_session_id).toBe('host-B');
  store.close();
});
