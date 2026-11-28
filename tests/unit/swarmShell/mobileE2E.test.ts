import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MobileGatewayServer } from '../../../packages/swarm-shell/src/main/mobileServer';
import { SwarmStore } from '../../../packages/swarm-shell/src/main/store';
import { TeamService, OWNER } from '../../../packages/swarm-team/src/service';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

describe('Mobile App End-to-End Workflow', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SwarmStore;
  let team: TeamService;
  let server: MobileGatewayServer;
  let projectId: string;
  let sessionA: any;
  let sessionB: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mobile-e2e-'));
    dbPath = path.join(tmpDir, 'test-e2e.sqlite3');
    store = new SwarmStore(dbPath);
    const p = store.createProject('E2E真实协同项目', tmpDir);
    projectId = p.id;

    sessionA = store.createSession({
      projectId,
      memberLabel: 'Gemini架构师',
      host: 'Antigravity',
      model: 'gemini-3.8-flash',
    });
    sessionB = store.createSession({
      projectId,
      memberLabel: 'DeepSeek工程师',
      host: 'Antigravity',
      model: 'deepseek-v3',
    });

    team = new TeamService({
      project: id => store.project(id),
      sessions: id => store.listSessions(id),
      load: id => store.loadBusState(id) as never,
      save: (id, snap) => store.saveBusState(id, snap as never),
    });
    team.refreshMembers(projectId);

    server = new MobileGatewayServer(store, team);
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('完整走通：配对 -> 进度上报 -> 成果交付 -> 等用户决策 -> 离线语音简报 -> 撤销解绑', async () => {
    // 1. 启动服务与配对
    const status = await server.start(0);
    const pairRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: status.pin, deviceName: 'iQOO Neo9 Pro' }),
    });
    const pairData = await pairRes.json();
    expect(pairData.ok).toBe(true);
    const token = pairData.token;

    // 2. 建立长连接并监听三类警报
    const ws = new WebSocket(`ws://127.0.0.1:${status.port}/api/mobile/ws?token=${token}`);
    const alerts: any[] = [];
    const stateUpdates: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'alert') alerts.push(msg);
        if (msg.type === 'state:changed') stateUpdates.push(msg);
      } catch {}
    });

    // 3. 模拟 DeepSeek 开始派工任务
    const posted = team.post({
      projectId,
      from: OWNER,
      to: sessionB.id,
      text: '请生成系统性能优化测试报告',
      requiresAction: true,
      eventId: 'evt-1',
    });
    const dispatchId = posted.messageIds[0];
    team.markDispatch(projectId, dispatchId, { status: 'running' });
    team.report({
      projectId,
      from: sessionB.id,
      progress: 'in_progress',
      next: '正在收集 CPU 与内存基准数据',
    });
    server.notifyStateChanged(projectId);

    await new Promise(r => setTimeout(r, 100));

    // 手机端拉取状态，验证「进行中」
    const state1Res = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state?token=${token}`);
    const state1 = await state1Res.json();
    expect(state1.inProgress.length).toBeGreaterThan(0);
    expect(state1.inProgress[0].progress).toContain('正在收集 CPU 与内存基准数据');

    // 4. 模拟 DeepSeek 交付真实成果文件
    const reportFilePath = path.join(tmpDir, 'benchmark_report.md');
    fs.writeFileSync(reportFilePath, '# 性能测试成果\n\n测试结论：各项指标全绿，内存开销减少 40%。', 'utf8');

    team.submitArtifact({
      projectId,
      from: sessionB.id,
      name: 'benchmark_report.md',
      path: reportFilePath,
    });
    team.markDispatch(projectId, dispatchId, { status: 'done' });
    server.notifyStateChanged(projectId);

    await new Promise(r => setTimeout(r, 150));

    // 验证手机收到「任务完成」Alert
    const doneAlert = alerts.find(a => a.alertType === 'done');
    expect(doneAlert).toBeTruthy();
    expect(doneAlert.title).toBe('任务已交付');

    // 手机端读取产物内容
    const state2Res = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state?token=${token}`);
    const state2 = await state2Res.json();
    expect(state2.delivered.length).toBeGreaterThan(0);
    const deliveredArtifact = state2.delivered[0].artifacts[0];
    expect(deliveredArtifact.name).toBe('benchmark_report.md');

    const artContentRes = await fetch(
      `http://127.0.0.1:${status.port}/api/mobile/artifacts/${deliveredArtifact.id}?token=${token}`,
    );
    expect(artContentRes.status).toBe(200);
    const artContent = await artContentRes.text();
    expect(artContent).toContain('# 性能测试成果');
    expect(artContent).toContain('内存开销减少 40%');

    // 5. 模拟 Gemini 提出需要用户处理的决策事项
    team.post({
      projectId,
      from: sessionA.id,
      to: OWNER,
      text: '请确认是否允许将基准调优策略合并进生产主干？',
      requiresAction: true,
      eventId: 'evt-decision-1',
    });
    server.notifyStateChanged(projectId);

    await new Promise(r => setTimeout(r, 150));

    // 验证手机收到「等你处理」Alert
    const waitAlert = alerts.find(a => a.alertType === 'waiting_for_user');
    expect(waitAlert).toBeTruthy();
    expect(waitAlert.title).toBe('等你处理');
    expect(waitAlert.body).toContain('请确认是否允许将基准调优策略合并');

    // 6. 验证离线语音简报生成
    const briefingRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/briefing?token=${token}`);
    const briefing = await briefingRes.json();
    expect(briefing.text).toContain('蜂群简报');
    expect(briefing.text).toContain('等待您处理');
    expect(briefing.text).toContain('已交付');

    // 7. 电脑端撤销配对
    server.revokeClient(token);
    const afterRevokeRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state?token=${token}`);
    expect(afterRevokeRes.status).toBe(401);

    ws.close();
  });
});
