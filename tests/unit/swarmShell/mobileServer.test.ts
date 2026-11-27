import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  MobileGatewayServer,
  buildBriefingText,
  getLocalIpv4Addresses,
} from '../../../packages/swarm-shell/src/main/mobileServer';
import { SwarmStore } from '../../../packages/swarm-shell/src/main/store';
import { TeamService, OWNER } from '../../../packages/swarm-team/src/service';
import { DispatchQueue } from '../../../packages/swarm-team/src/dispatchQueue';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

describe('Mobile Gateway & Logic', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SwarmStore;
  let team: TeamService;
  let dispatchQueue: DispatchQueue;
  let server: MobileGatewayServer;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mobile-test-'));
    dbPath = path.join(tmpDir, 'test-mobile.sqlite3');
    store = new SwarmStore(dbPath);
    const p = store.createProject('测试蜂群项目', tmpDir);
    projectId = p.id;

    team = new TeamService({
      project: id => store.project(id),
      sessions: id => store.listSessions(id),
      load: id => store.loadBusState(id) as never,
      save: (id, snap) => store.saveBusState(id, snap as never),
    });

    dispatchQueue = new DispatchQueue();
    server = new MobileGatewayServer(store, team, dispatchQueue);
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getLocalIpv4Addresses 返回合法的非回环 IPv4', () => {
    const ips = getLocalIpv4Addresses();
    expect(ips.length).toBeGreaterThan(0);
    for (const ip of ips) {
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });

  it('buildBriefingText 能直接拼装多分类语音简报文本', () => {
    const text = buildBriefingText({
      waiting: [
        {
          id: 'w1',
          type: 'waiting_for_user',
          memberId: 'm1',
          memberLabel: 'Gemini',
          title: '等待用户确认',
          question: '是否同意切换到生产环境？',
          timestamp: '2026-11-19T01:00:00Z',
          requiresAction: true,
        },
      ],
      inProgress: [
        {
          id: 'p1',
          type: 'running',
          memberId: 'm2',
          memberLabel: 'DeepSeek',
          model: 'deepseek-v3',
          title: '构建内核模块',
          progress: '正在编译 C++ 扩展',
          timestamp: '2026-11-19T01:05:00Z',
        },
      ],
      delivered: [
        {
          id: 'd1',
          type: 'done',
          memberId: 'm3',
          memberLabel: 'Qwen',
          title: '产出架构报告',
          conclusion: '已完成评估',
          artifacts: [{ id: 'a1', name: 'report.pdf', path: 'report.pdf', size: 1024 }],
          timestamp: '2026-11-19T01:10:00Z',
        },
      ],
      failed: [],
    });

    expect(text).toContain('蜂群简报');
    expect(text).toContain('当前有 1 项等待您处理');
    expect(text).toContain('Gemini 提出：是否同意切换到生产环境？');
    expect(text).toContain('进行中 1 项');
    expect(text).toContain('DeepSeek 正在进行 构建内核模块');
    expect(text).toContain('已交付 1 项');
    expect(text).toContain('Qwen 完成了 产出架构报告');
  });

  it('配对流程：错误 PIN 被拒，正确 PIN 获得令牌且可查询状态', async () => {
    const status = await server.start(0);
    expect(status.isRunning).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(status.pin).toMatch(/^\d{6}$/);
    expect(status.qrSvg).toContain('<svg');

    const pairUrl = `http://127.0.0.1:${status.port}/api/mobile/pair`;

    // 1. 错误 PIN
    const failRes = await fetch(pairUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    expect(failRes.status).toBe(400);

    // 2. 正确 PIN
    const pairRes = await fetch(pairUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: status.pin, deviceName: 'iQOO Neo9 Pro' }),
    });
    expect(pairRes.status).toBe(200);
    const pairData = await pairRes.json();
    expect(pairData.ok).toBe(true);
    expect(pairData.token).toBeTruthy();
    expect(pairData.projectName).toBe('测试蜂群项目');

    // 3. 无 token 访问被拒 401
    const unauthRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state`);
    expect(unauthRes.status).toBe(401);

    // 4. 带 token 访问成功 200
    const stateRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state?token=${pairData.token}`);
    expect(stateRes.status).toBe(200);
    const stateData = await stateRes.json();
    expect(stateData.project.name).toBe('测试蜂群项目');
    expect(Array.isArray(stateData.waiting)).toBe(true);
    expect(Array.isArray(stateData.inProgress)).toBe(true);
    expect(Array.isArray(stateData.delivered)).toBe(true);

    // 5. 解绑后再次访问返回 401
    const unpairRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/unpair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pairData.token }),
    });
    expect(unpairRes.status).toBe(200);

    const recheckRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/state?token=${pairData.token}`);
    expect(recheckRes.status).toBe(401);
  });

  it('事件去重推送：三类事件只提醒一次，不重复打扰', async () => {
    const status = await server.start(0);
    const pairRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: status.pin }),
    });
    const { token } = await pairRes.json();

    // 注册一个测试成员
    const session = store.createSession({
      projectId,
      memberLabel: 'Gemini助手',
      host: 'Antigravity',
      model: 'gemini-3.8-flash',
    });
    team.refreshMembers(projectId);

    // 建立 WebSocket 连接
    const ws = new WebSocket(`ws://127.0.0.1:${status.port}/api/mobile/ws?token=${token}`);
    const receivedAlerts: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'alert') {
          receivedAlerts.push(msg);
        }
      } catch {}
    });

    // 模拟添加一条明确等用户处理的消息
    team.post({
      projectId,
      from: session.id,
      to: OWNER,
      text: '请确认是否发布新版本到测试服务器？',
      requiresAction: true,
    });

    const debugState = server.getMobileState(projectId);
    expect(debugState.waiting.length).toBe(1);

    // 触发状态改变通知
    server.notifyStateChanged(projectId);

    // 等待通知到达
    await new Promise(r => setTimeout(r, 200));

    expect(receivedAlerts.length).toBe(1);
    expect(receivedAlerts[0].alertType).toBe('waiting_for_user');
    expect(receivedAlerts[0].title).toBe('等你处理');
    expect(receivedAlerts[0].body).toContain('请确认是否发布新版本');

    // 再次调用 notifyStateChanged，验证去重（不会重复产生 alert）
    server.notifyStateChanged(projectId);
    await new Promise(r => setTimeout(r, 100));

    expect(receivedAlerts.length).toBe(1); // 依然只有 1 条！

    ws.close();
  });

  it('手机端快捷回复接口：POST /api/mobile/reply 写回总线并清除 waiting', async () => {
    const status = await server.start(0);
    const pairRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: status.pin }),
    });
    const { token } = await pairRes.json();

    const session = store.createSession({
      projectId,
      memberLabel: '评审员',
      host: 'Antigravity',
      model: 'gemini-3.8-flash',
    });
    team.refreshMembers(projectId);

    team.post({
      projectId,
      from: session.id,
      to: OWNER,
      text: '方案A还是方案B？请选择。',
      requiresAction: true,
    });

    const beforeState = server.getMobileState(projectId);
    expect(beforeState.waiting.length).toBe(1);
    const targetMsgId = beforeState.waiting[0].id;

    // 手机端发起快捷回复
    const replyRes = await fetch(`http://127.0.0.1:${status.port}/api/mobile/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        projectId,
        messageId: targetMsgId,
        replyText: '执行方案A，继续推进。',
      }),
    });
    const replyJson = await replyRes.json();
    if (replyRes.status !== 200) {
      console.error('reply error:', replyJson);
    }
    expect(replyRes.status).toBe(200);
    expect(replyJson.ok).toBe(true);

    // 验证状态已更新：waiting 被清除
    const afterState = server.getMobileState(projectId);
    expect(afterState.waiting.length).toBe(0);

    // 验证总线上已经记录了用户的回复
    const busSnapshot = team.bus(projectId).snapshot();
    const userReplies = busSnapshot.messages.filter(m => m.sender === OWNER);
    expect(userReplies.some(m => m.text.includes('执行方案A'))).toBe(true);
  });
});
