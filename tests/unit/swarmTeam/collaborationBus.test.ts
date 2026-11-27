import { describe, expect, it } from 'vitest';
import { CollaborationBus, dmChannel } from '../../../packages/swarm-team/src/collaborationBus';
import { OWNER, TeamService, type TeamDeps, type TeamSession } from '../../../packages/swarm-team/src/service';
import { DispatchQueue } from '../../../packages/swarm-team/src/dispatchQueue';

const members = [
  { id: 'lead', label: '负责人' },
  { id: 'dev', label: '开发' },
  { id: 'qa', label: '验收' },
];

const bus = () => new CollaborationBus(members, { workspace: 'D:/work/repo', channelId: 'ch:p1:main' });

it('引用公开留言的派工只进信箱，新成员可自行回到原帖回复', () => {
  const sessions: TeamSession[] = [];
  let saved: ReturnType<TeamDeps['load']>;
  const deps: TeamDeps = {
    project: id => ({ id, name: '验收', workspace: 'D:/work/repo' }),
    sessions: () => sessions,
    load: () => saved,
    save: (_project, snapshot) => { saved = snapshot; },
  };
  const [rootId] = new TeamService(deps).post({ projectId: 'p1', from: OWNER, text: '验收工作' }).messageIds;
  sessions.push({ id: 'dev', member_label: '开发', host: 'CodeBuddy', model: 'hy3', host_session_id: null });
  sessions.push({ id: 'qa', member_label: '验收', host: 'CodeBuddy', model: 'hy3', host_session_id: null });
  const team = new TeamService(deps);
  const request = team.post({ projectId: 'p1', from: OWNER, to: 'dev', text: '核对文件',
    thread: rootId, requiresAction: true });
  const [dispatchId] = request.messageIds;
  expect(request.result).toContain(`ID：${rootId}，作者：用户`);
  expect(request.result).toContain('摘要：验收工作');
  expect(team.takeInbox('p1', 'dev')).toContainEqual(expect.objectContaining({
    id: dispatchId, channel: dmChannel(OWNER, 'dev'), text: request.result,
  }));
  expect(team.bus('p1').recoverableDispatches()).toContainEqual(expect.objectContaining({ text: request.result }));
  expect(team.readMessages('p1', 'qa', [dispatchId])).toEqual([]);
  expect(team.thread('p1', OWNER, rootId)?.replies).toEqual([]);
  team.markDispatch('p1', dispatchId, { status: 'running', runId: 'R-1' });
  const { artifactIds } = team.submitArtifact({ projectId: 'p1', from: 'dev', name: '验收记录', path: 'D:/work/repo/check.md', runId: 'R-1' });
  expect(team.thread('p1', OWNER, dispatchId)?.root).toMatchObject({ id: dispatchId, artifactIds });
  team.post({ projectId: 'p1', from: 'dev', text: '已核对', thread: rootId, requiresAction: false });
  expect(team.thread('p1', 'qa', rootId)?.replies).toMatchObject([{ text: '已核对', sender: 'dev' }]);
  expect(team.artifacts('p1')[0].name).toBe('验收记录');
});

describe('swarm-team 的协作总线', () => {
  it('子任务回传只唤醒发起会话一次，忙时顺序保留，重启后按 ID 读取结果', () => {
    const team = bus();
    const [child] = team.accept('lead', JSON.stringify({
      result: '核对', messages: [{ to: 'dev', text: '核对', requires_action: true }],
    })).messageIds;
    const wake = team.finishDispatch(child, { status: 'done', runId: 'R-child' })!;
    expect(wake.memberId).toBe('lead');
    expect(team.finishDispatch(child, { status: 'done', runId: 'R-child' })).toBeUndefined();
    const restored = new CollaborationBus(members, {
      workspace: 'D:/work/repo', channelId: team.channelId, runId: team.runId, state: team.snapshot(),
    });
    const queued = restored.recoverableDispatches();
    expect(queued).toMatchObject([{ dispatch: { id: wake.messageId, owner: 'lead', reason: 'dispatch_result' }, text: wake.text }]);
    const queue = new DispatchQueue();
    queue.add({ id: 'busy', projectId: 'p', sessionId: 'lead', text: '正在做的事' });
    queue.takeNext('lead');
    queue.add({ id: wake.messageId, projectId: 'p', sessionId: wake.memberId, text: wake.text });
    expect(queue.takeNext('lead')).toBeUndefined();
    expect(queue.pending('lead')).toBe(1);
    queue.settleById('busy', 'done');
    expect(queue.takeNext('lead')?.id).toBe(wake.messageId);
    const read = (id: string) => id === 'R-child' ? '这是子任务的实际结果' : undefined;
    expect(restored.takeInbox('lead')[0]?.text).not.toContain('实际结果');
    expect(restored.readMessages('lead', [wake.messageId], 4000, 0, read)[0]?.text).toContain('这是子任务的实际结果');
    const longResult = () => '结果'.repeat(1000);
    const firstPage = restored.readMessages('lead', [wake.messageId], undefined, 0, longResult)[0];
    expect(firstPage.text).toHaveLength(800);
    expect(firstPage.next_offset).toBe(800);
    expect(restored.readMessages('lead', [wake.messageId], undefined, 800, longResult)[0].text).toHaveLength(800);
    expect(restored.readMessages('qa', [wake.messageId], 4000, 0, read)).toEqual([]);
    restored.ack('lead', [wake.messageId]);
    expect(restored.wakeupNeeded(wake.messageId)).toBe(false);
    expect(restored.resultInbox('lead')).toMatchObject([{ id: wake.messageId, processed: true }]);
    expect(restored.finishDispatch(wake.messageId, { status: 'done', runId: 'R-parent' })).toBeUndefined();
    expect(restored.recoverableDispatches()).toEqual([]);
  });

  it('子任务启动失败也给原发起者留信箱结果，说明原始错误', () => {
    const team = bus();
    const [child] = team.accept('lead', JSON.stringify({
      result: '核对', messages: [{ to: 'dev', text: '核对', requires_action: true }],
    })).messageIds;
    const wake = team.finishDispatch(child, { status: 'failed', error: '宿主不可用' })!;
    expect(team.readMessages('lead', [wake.messageId])[0]?.text).toContain('宿主不可用');
    expect(team.resultInbox('lead')).toMatchObject([{ id: wake.messageId, processed: false }]);
  });

  it('专题频道按成员隔离，归档只读，恢复后保留讨论串', () => {
    const team = new CollaborationBus([{ id: OWNER, label: '我' }, ...members], { channelId: 'ch:p1:main' });
    const topic = team.createChannel('lead', '容量复核', ['dev']);
    const [root] = team.accept('lead', JSON.stringify({
      result: '请复核容量', messages: [{ to: 'all', channel: topic.id, text: '请复核容量' }],
    })).messageIds;
    expect(team.listChannels('qa').map(channel => channel.id)).toEqual([team.channelId]);
    expect(team.readMessages('qa', [root])).toEqual([]);
    expect(team.channelView('qa', topic.id).roots).toEqual([]);
    expect(team.channelView(OWNER, topic.id).roots[0]?.id).toBe(root);
    expect(team.channelView(OWNER, team.channelId).roots).toEqual([]);
    expect(() => team.recentChannelMessages('qa', topic.id, 8)).toThrow('未加入');
    expect(() => team.archiveChannel('dev', topic.id, true)).toThrow('创建者');
    team.inviteChannel('dev', topic.id, ['qa']);
    team.inviteChannel('dev', topic.id, ['qa']);
    expect(team.inbox('qa').filter(message => message.kind === 'system')).toMatchObject([{ to: 'qa', requiresAction: false }]);
    expect(team.recentChannelMessages('qa', topic.id, 8)[0]?.id).toBe(root);
    const [reply] = team.accept('qa', JSON.stringify({
      result: '核对意见', messages: [{ to: 'all', channel: topic.id, thread: root, text: '核对意见' }],
    })).messageIds;
    expect(team.inbox('lead')[0]).toMatchObject({ id: reply, threadId: root });
    expect(team.inbox('dev').some(message => message.id === reply)).toBe(false);
    team.archiveChannel(OWNER, topic.id, true);
    const restored = new CollaborationBus(team.memberList(), {
      state: team.snapshot(), channelId: team.channelId, runId: team.runId,
    });
    expect(restored.threadView('qa', root)?.replies[0]?.id).toBe(reply);
    const post = JSON.stringify({ result: '补充', messages: [{ to: 'all', channel: topic.id, text: '补充' }] });
    expect(() => restored.accept('qa', post)).toThrow('已归档');
    restored.archiveChannel(OWNER, topic.id, false);
    expect(restored.accept('qa', post).messageIds).toHaveLength(1);
  });

  it('公开回帖只提醒原帖作者，重开后待确认的提醒仍在信箱', () => {
    const team = bus();
    const [root] = team.accept('lead', JSON.stringify({
      result: '请复核', messages: [{ to: 'all', text: '请复核' }],
    })).messageIds;
    const [reply] = team.accept('dev', JSON.stringify({
      result: '复核意见', messages: [{ to: 'all', text: '复核意见', thread: root }],
    })).messageIds;
    expect(team.threadView('qa', root)?.replies.map(message => message.id)).toEqual([reply]);
    expect(team.inbox('qa').some(message => message.id === reply)).toBe(false);
    expect(team.takeInbox('lead', 1)[0]).toMatchObject({ id: reply, threadId: root });
    expect(team.dispatchOf(reply)).toBeUndefined();
    const restored = new CollaborationBus(members, {
      workspace: 'D:/work/repo', channelId: 'ch:p1:main', state: team.snapshot(),
    });
    expect(restored.inbox('lead').map(message => message.id)).toContain(reply);
    restored.ack('lead', [reply]);
    expect(restored.inbox('lead').map(message => message.id)).not.toContain(reply);
    expect(restored.threadView('qa', root)?.replies.map(message => message.id)).toEqual([reply]);
  });

  it('普通文字原样返回，不产生消息', () => {
    const team = bus();
    const result = team.accept('dev', '我先看一遍代码结构');
    expect(result.result).toBe('我先看一遍代码结构');
    expect(result.messageIds).toEqual([]);
    expect(team.snapshot().messages).toHaveLength(0);
  });

  it('同一 eventId 重试不重复投递，内容变化直接报错', () => {
    const team = bus();
    const envelope = JSON.stringify({ result: '完成初版', messages: [{ to: 'lead', text: '初版已提交' }] });
    team.accept('dev', envelope, { eventId: 'evt-1' });
    expect(team.accept('dev', envelope, { eventId: 'evt-1' }).messageIds).toEqual([]);
    expect(team.snapshot().messages).toHaveLength(1);
    expect(() => team.accept('dev', JSON.stringify({ result: '换了内容' }), { eventId: 'evt-1' })).toThrow(
      '重复投递的内容发生变化',
    );
  });

  it('群发落项目频道，点对点自动落双方私信频道', () => {
    const team = bus();
    team.accept('dev', JSON.stringify({
      result: '同步',
      messages: [
        { to: 'all', text: '主线进度' },
        { to: 'lead', text: '只给你看' },
      ],
    }));
    const state = team.snapshot();
    expect(state.messages[0].channel).toBe('ch:p1:main');
    expect(state.messages[1].channel).toBe(dmChannel('lead', 'dev'));
    expect(state.messages[1].receipts).toEqual({ lead: 'queued' });
  });

  it('私信不进第三人视野，频道视图只返回本频道消息', () => {
    const team = bus();
    team.accept('dev', JSON.stringify({
      result: '同步',
      messages: [
        { to: 'all', text: '主线进度' },
        { to: 'lead', text: '只给你看' },
      ],
    }));
    expect(team.channelView('lead', 'ch:p1:main').roots.map(m => m.text)).toEqual(['主线进度']);
    expect(team.channelView('qa', 'ch:p1:main').roots.map(m => m.text)).toEqual(['主线进度']);
    expect(team.channelView('lead', dmChannel('lead', 'dev')).roots.map(m => m.text)).toEqual(['只给你看']);
    // 不在 DM 双方的成员看不到对方私信频道
    expect(team.channelView('qa', dmChannel('lead', 'dev')).roots).toEqual([]);
  });

  it('讨论串必须挂在同频道根消息上', () => {
    const team = bus();
    const root = team.accept('dev', JSON.stringify({ result: '开工', messages: [{ to: 'all', text: '先做接口' }] })).messageIds[0];
    team.accept('lead', JSON.stringify({ result: '回复', messages: [{ to: 'all', text: '同意', thread: root }] }));
    const view = team.threadView('qa', root)!;
    expect(view.replies.map(m => m.text)).toEqual(['同意']);
    expect(() => team.accept('qa', JSON.stringify({ result: '乱挂', messages: [{ to: 'all', text: '跑题', thread: 'M-不存在' }] }))).toThrow();
  });

  it('取信：takeInbox 只返回给本人且推进到 delivered，确认后 processed', () => {
    const team = bus();
    team.accept('dev', JSON.stringify({ result: '请你看', messages: [{ to: 'lead', text: '请看缺口' }] }));
    const taken = team.takeInbox('lead');
    expect(taken.map(m => m.text)).toEqual(['请看缺口']);
    expect(team.snapshot().messages[0].receipts.lead).toBe('delivered');
    expect(team.takeInbox('lead')).toEqual([]);
    team.ack('lead', [taken[0].id]);
    expect(team.snapshot().messages[0].receipts.lead).toBe('processed');
    // 别人取不到这条私信
    expect(team.takeInbox('qa')).toEqual([]);
  });

  it('共享板版本对不上只记冲突，不覆盖', () => {
    const team = bus();
    team.accept('dev', JSON.stringify({ result: '写板', updates: [{ key: '接口契约', value: 'v1', expected_version: 0 }] }));
    const conflict = team.accept('qa', JSON.stringify({ result: '再写', updates: [{ key: '接口契约', value: 'v2', expected_version: 0 }] }));
    expect(conflict.conflicts).toHaveLength(1);
    expect(team.snapshot().board['接口契约'].value).toBe('v1');
    expect(team.snapshot().messages.some(m => m.kind === 'conflict')).toBe(true);
  });

  it('任务更新：过期版本、越权改别人任务、阻塞不写原因都要拦住', () => {
    const team = bus();
    const devTask = team.taskOf('dev')!;
    expect(() => {
      team.accept('dev', JSON.stringify({ result: '报进度', task_updates: [{ expected_version: devTask.version + 5, progress: 'in_progress' }] }));
    }).toThrow('任务更新已过期');
    expect(() => {
      team.accept('dev', JSON.stringify({ result: '改别人的', task_updates: [{ task_id: team.taskOf('qa')!.id, progress: 'submitted' }] }));
    }).toThrow('只能更新自己本轮绑定的任务');
    expect(() => {
      team.accept('dev', JSON.stringify({ result: '卡住', task_updates: [{ progress: 'blocked' }] }));
    }).toThrow('报告阻塞时必须说明原因');
  });

  it('交付物：内容直接收，路径越界拒绝', () => {
    const team = bus();
    const ok = team.accept('dev', JSON.stringify({
      result: '交文档',
      artifacts: [{ name: '说明.md', content: '# 结论' }, { name: '图.png', path: 'D:/work/repo/out/图.png' }],
    }));
    expect(ok.artifactIds).toHaveLength(2);
    expect(() =>
      team.accept('dev', JSON.stringify({ result: '夹带', artifacts: [{ name: '密.txt', path: 'C:/Windows/win.ini' }] })),
    ).toThrow('交付物路径必须在本轮工作目录内');
  });

  it('新成员加入补自己的任务，不重复绑定', () => {
    const team = bus();
    const late = team.addMember({ id: 'pm', label: '产品' });
    expect(team.taskOf('pm')?.id).toBe(late.id);
    expect(() => team.addMember({ id: 'pm', label: '产品' })).toThrow('成员已存在');
  });

  it('快照可整份恢复，消息 ID 不变（重启后还能读到同一条）', () => {
    const team = bus();
    const id = team.accept('dev', JSON.stringify({ result: '落库', messages: [{ to: 'lead', text: '重启后还在' }] })).messageIds[0];
    const restored = new CollaborationBus(members, { workspace: 'D:/work/repo', state: team.snapshot() });
    expect(restored.snapshot().messages[0].id).toBe(id);
    expect(restored.inbox('lead').map(m => m.text)).toEqual(['重启后还在']);
  });

  it('增量上下文只补一次，条目有界，私信仍只给收发双方', () => {
    const team = bus();
    for (let index = 0; index < 6; index += 1) {
      team.accept('dev', JSON.stringify({ result: `第 ${index} 条`, messages: [{ to: 'lead', text: `进度 ${index}` }] }));
    }
    team.accept('qa', JSON.stringify({ result: '私信', messages: [{ to: 'dev', text: '只给开发看' }] }));
    const first = team.takeContext('lead', 3);
    expect(first.items.length).toBeLessThanOrEqual(3);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.items.every(item => item.kind !== 'message' || !item.text.includes('只给开发看'))).toBe(true);
    expect(first.metrics.chars).toBe(first.items.reduce((sum, item) => sum + item.text.length, 0));
    const second = team.takeContext('lead', 8);
    expect(second.items.filter(item => item.kind === 'message')).toHaveLength(4);
    // 前面已经送过的消息不会在第二次读取时再补一遍
    expect(new Set([...first.items.map(item => item.id), ...second.items.map(item => item.id)]).size).toBe(
      first.items.length + second.items.length,
    );
    expect(team.takeContext('lead', 8).items.filter(item => item.kind === 'message')).toHaveLength(0);
    // 私信不会被第三人从上下文里拿到
    expect(team.takeContext('qa', 8).items.some(item => item.text.includes('只给开发看'))).toBe(false);
  });

  it('按消息 id 回读原文，别人的私信读不到', () => {
    const team = bus();
    const [mainId, dmId] = team.accept('dev', JSON.stringify({
      result: '两条',
      messages: [
        { to: 'all', text: '主线全文' },
        { to: 'lead', text: '私信全文' },
      ],
    })).messageIds;
    expect(team.readMessages('lead', [mainId, dmId]).map(item => item.text)).toEqual(['主线全文', '私信全文']);
    expect(team.readMessages('qa', [mainId]).map(item => item.text)).toEqual(['主线全文']);
    expect(team.readMessages('qa', [dmId])).toEqual([]);
  });

  it('长消息按返回位置续读，单页有上限且不拆开 emoji', () => {
    const team = bus();
    const body = '甲'.repeat(3999) + '🐝' + '乙'.repeat(3997) + '末尾';
    const [id] = team.accept('dev', JSON.stringify({
      result: '补充',
      messages: [{ to: 'lead', text: body }],
    })).messageIds;
    const [first] = team.readMessages('lead', [id], 10000);
    expect(first).toMatchObject({ text: body.slice(0, 3999), next_offset: 3999, total_chars: body.length });
    const [second] = team.readMessages('lead', [id], 4000, first.next_offset!);
    const [last] = team.readMessages('lead', [id], 4000, second.next_offset!);
    expect(last).toMatchObject({ truncated: false, next_offset: null });
    expect(first.text + second.text + last.text).toBe(body);
    expect(team.readMessages('qa', [id], 4000, first.next_offset!)).toEqual([]);
    expect(() => team.readMessages('lead', [id], 4000, -1)).toThrow('offset');
  });

  it('超过旧游标的 ID 上限后仍只补新消息，重启后也从原位置继续', () => {
    const team = bus();
    const ids = Array.from({ length: 90 }, (_, index) => team.accept('dev', JSON.stringify({
      result: '进度',
      messages: [{ to: 'lead', text: `进度 ${index}` }],
    })).messageIds[0]);
    const received = Array.from({ length: 5 }, () => team.takeContext('lead', 32))
      .flatMap(page => page.items.filter(item => item.kind === 'message').map(item => item.id));
    expect(received).toEqual(ids);

    const snapshot = team.snapshot();
    const restored = new CollaborationBus(members, { workspace: 'D:/work/repo', state: snapshot });
    expect(restored.takeContext('lead').items).toEqual([]);

    // 模拟只保留最近消息 ID 的旧版快照。
    delete snapshot.cursors!.lead.nextMessageIndex;
    const migrated = new CollaborationBus(members, { workspace: 'D:/work/repo', state: snapshot });
    const newId = migrated.accept('dev', JSON.stringify({ result: '进度', messages: [{ to: 'lead', text: '新进度' }] })).messageIds[0];
    expect(migrated.takeContext('lead').items.map(item => item.id)).toEqual([newId]);
  });

  it('派工状态与消息 id 绑定：排队 → 执行 → 完成/失败都写回同一条', () => {
    const team = bus();
    const messageId = team.accept('dev', JSON.stringify({
      result: '派工',
      messages: [{ to: 'lead', text: '请处理这个缺口', requires_action: true }],
    })).messageIds[0];
    const queued = team.dispatchOf(messageId)!;
    expect(queued.status).toBe('queued');
    expect(team.markDispatch(messageId, { status: 'running', runId: 'R-1' })?.status).toBe('running');
    expect(team.markDispatch(messageId, { status: 'failed', error: '宿主额度用完' })?.error).toBe('宿主额度用完');
    expect(team.dispatchOf(messageId)?.runId).toBe('R-1');
  });

  it('增量读取在确认前可重试，确认后不会重送', () => {
    const team = bus();
    const [id] = team.accept('dev', JSON.stringify({ result: '更新', messages: [{ to: 'lead', text: '补充' }] })).messageIds;
    const page = team.takeContext('lead', 8, false);
    expect(page.items.some(item => item.id === id)).toBe(true);
    expect(team.takeContext('lead', 8, false).items).toEqual(page.items);
    team.confirmContext('lead', page.cursor);
    expect(team.takeContext('lead', 8, false).items).toEqual([]);
  });

  it('从快照只恢复明确派给成员且尚未收尾的派工', () => {
    const team = bus();
    const [queued, running, done] = team.accept('dev', JSON.stringify({ result: '派工', messages: [
      { to: 'lead', text: '继续处理', requires_action: true },
      { to: 'lead', text: '正在处理', requires_action: true },
      { to: 'lead', text: '已结束', requires_action: true },
    ] })).messageIds;
    team.markDispatch(running, { status: 'running', runId: 'R-1' });
    team.markDispatch(done, { status: 'done' });
    const restored = new CollaborationBus(members, { workspace: 'D:/work/repo', state: team.snapshot() });
    expect(restored.recoverableDispatches().map(({ dispatch, text }) => [dispatch.id, dispatch.status, text])).toEqual([
      [queued, 'queued', '继续处理'], [running, 'running', '正在处理'],
    ]);
  });
});
