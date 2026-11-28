/**
 * 蜂群移动端访问网关 (Mobile Gateway)
 *
 * 职责：
 * 1. 局域网 Wi-Fi 访问与设备配对（6位 PIN 码 / 扫码 Token / 会话 Token 鉴权）
 * 2. 状态查询：提供三类分类（等你处理、进行中/排队、已交付/失败）与离线语音简报生成
 * 3. 产物内容按需回读与下载
 * 4. WebSocket 实时双向流（状态更新广播 + 三类核心事件精准去重推送：done, failed, waiting_for_user）
 * 5. 电脑端启停控制与配对撤销
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import type { SwarmStore } from './store';
import { TeamService, OWNER } from '../../../swarm-team/src/service';

export interface MobileClientSession {
  token: string;
  deviceName: string;
  ip: string;
  pairedAt: string;
  lastSeenAt: string;
}

export interface WaitingItem {
  id: string;
  type: 'waiting_for_user';
  memberId: string;
  memberLabel: string;
  title: string;
  question: string;
  blocker?: string;
  timestamp: string;
  requiresAction: true;
  threadId?: string;
  channelId?: string;
  channelLabel?: string;
  taskGroup?: string;
  messageId?: string;
}

export interface InProgressItem {
  id: string;
  type: 'running' | 'queued';
  memberId: string;
  memberLabel: string;
  model: string;
  title: string;
  progress: string;
  timestamp: string;
  taskGroup?: string;
  channelId?: string;
}

export interface DeliveredItem {
  id: string;
  type: 'done' | 'failed';
  memberId: string;
  memberLabel: string;
  title: string;
  conclusion: string;
  error?: string;
  rawError?: string;
  taskGroup?: string;
  artifacts: Array<{
    id: string;
    name: string;
    path: string;
    size: number;
    absolutePath?: string;
  }>;
  timestamp: string;
}

export interface AvailableProjectItem {
  id: string;
  name: string;
  kind: string;
  isRunning: boolean;
  waitingCount: number;
  inProgressCount: number;
}

export interface MobileStatePayload {
  project: { id: string; name: string; workspace: string; kind?: string } | null;
  availableProjects?: AvailableProjectItem[];
  waiting: WaitingItem[];
  inProgress: InProgressItem[];
  delivered: DeliveredItem[];
  failed: DeliveredItem[];
  members: Array<{ id: string; label: string; model: string; host: string; isRunning: boolean }>;
  briefingText: string;
  serverTime: string;
}

export interface MobileAlertMessage {
  type: 'alert';
  alertType: 'waiting_for_user' | 'done' | 'failed';
  taskId: string;
  memberLabel: string;
  title: string;
  body: string;
  timestamp: string;
}

/** 获取局域网优先的非回环 IPv4 地址 */
export function getLocalIpv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        candidates.push(net.address);
      }
    }
  }
  // 局域网私网段排前 (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  candidates.sort((a, b) => {
    const score = (ip: string) => {
      if (ip.startsWith('192.168.')) return 3;
      if (ip.startsWith('10.')) return 2;
      if (ip.startsWith('172.')) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
  return candidates.length > 0 ? candidates : ['127.0.0.1'];
}

/** 用已有结构化字段拼接简报语音，零大模型开销 */
export function buildBriefingText(state: {
  waiting: WaitingItem[];
  inProgress: InProgressItem[];
  delivered: DeliveredItem[];
  failed: DeliveredItem[];
}): string {
  const parts: string[] = ['蜂群简报。'];
  if (state.waiting.length > 0) {
    parts.push(`当前有 ${state.waiting.length} 项等待您处理：`);
    for (const item of state.waiting) {
      parts.push(`${item.memberLabel} 提出：${item.question.slice(0, 45)}。`);
    }
  }
  if (state.inProgress.length > 0) {
    parts.push(`进行中 ${state.inProgress.length} 项：`);
    for (const item of state.inProgress) {
      parts.push(
        `${item.memberLabel} 正在进行 ${item.title.slice(0, 25)}${item.progress ? `，当前进展：${item.progress.slice(0, 25)}` : ''}。`,
      );
    }
  }
  if (state.delivered.length > 0) {
    parts.push(`已交付 ${state.delivered.length} 项：`);
    for (const item of state.delivered) {
      const artCount = item.artifacts.length;
      const artDesc = artCount > 0 ? `，并登记了 ${item.artifacts.map(a => a.name).join('、')}` : '';
      parts.push(`${item.memberLabel} 完成了 ${item.title.slice(0, 25)}${artDesc}。`);
    }
  }
  if (state.failed.length > 0) {
    parts.push(`另外有 ${state.failed.length} 项运行失败：`);
    for (const item of state.failed) {
      parts.push(`${item.memberLabel}：${(item.error || '遇到错误').slice(0, 35)}。`);
    }
  }
  if (state.waiting.length === 0 && state.inProgress.length === 0 && state.delivered.length === 0 && state.failed.length === 0) {
    parts.push('当前蜂群暂无活动任务。');
  }
  return parts.join(' ');
}

export class MobileGatewayServer {
  private http = createServer((req, res) => this.handleHttp(req, res));
  private wss: WebSocketServer | null = null;
  private port = 0;
  private hostIp = '127.0.0.1';
  private pin = '';
  private isRunning = false;
  private pairedClients = new Map<string, MobileClientSession>();
  private activeWsClients = new Set<{ ws: WebSocket; token: string }>();
  private sentAlertKeys = new Set<string>();
  private staticAssetsDir: string | null = null;

  constructor(
    private readonly store: SwarmStore,
    private readonly team: TeamService,
    private readonly isSessionRunning?: (sessionId: string) => boolean,
  ) {
    this.regeneratePin();
  }

  setStaticAssetsDir(dir: string): void {
    this.staticAssetsDir = dir;
  }

  regeneratePin(): string {
    this.pin = String(randomInt(100000, 999999));
    return this.pin;
  }

  async start(preferredPort = 3818): Promise<{ host: string; port: number; url: string; pin: string; qrSvg: string }> {
    if (this.isRunning) {
      return this.getStatus();
    }
    const ips = getLocalIpv4Addresses();
    this.hostIp = ips[0] || '127.0.0.1';

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws: WebSocket, token: string) => {
      const client = { ws, token };
      this.activeWsClients.add(client);
      ws.on('close', () => this.activeWsClients.delete(client));
      ws.on('error', () => this.activeWsClients.delete(client));
      // 发送当前初始状态摘要
      ws.send(JSON.stringify({ type: 'connected', serverTime: new Date().toISOString() }));
    });

    this.http.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${this.hostIp}`);
      if (url.pathname !== '/api/mobile/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      if (!this.pairedClients.has(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // 更新客户端 lastSeen
      const client = this.pairedClients.get(token);
      if (client) client.lastSeenAt = new Date().toISOString();

      this.wss?.handleUpgrade(request, socket, head, ws => {
        this.wss?.emit('connection', ws, token);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.http.listen(preferredPort, '0.0.0.0', () => {
        this.port = (this.http.address() as AddressInfo).port;
        this.isRunning = true;
        resolve();
      });
      this.http.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // 端口被占用时换动态端口
          this.http.listen(0, '0.0.0.0', () => {
            this.port = (this.http.address() as AddressInfo).port;
            this.isRunning = true;
            resolve();
          });
        } else {
          reject(err);
        }
      });
    });

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    for (const client of this.activeWsClients) {
      try {
        client.ws.close(1000, 'Server stopping');
      } catch {}
    }
    this.activeWsClients.clear();
    await new Promise<void>(resolve => {
      this.wss?.close(() => {
        this.http.close(() => {
          this.isRunning = false;
          resolve();
        });
      });
    });
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    host: string;
    port: number;
    url: string;
    pin: string;
    qrSvg: string;
    pairedCount: number;
    pairedClients: MobileClientSession[];
  }> {
    const url = `http://${this.hostIp}:${this.port}`;
    const qrData = JSON.stringify({ swarm: true, host: this.hostIp, port: this.port, pin: this.pin });
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(qrData, { type: 'svg', margin: 1 });
    } catch {}

    return {
      isRunning: this.isRunning,
      host: this.hostIp,
      port: this.port,
      url,
      pin: this.pin,
      qrSvg,
      pairedCount: this.pairedClients.size,
      pairedClients: Array.from(this.pairedClients.values()),
    };
  }

  revokeClient(token: string): boolean {
    const existed = this.pairedClients.delete(token);
    for (const client of this.activeWsClients) {
      if (client.token === token) {
        try {
          client.ws.close(4001, 'Pairing revoked');
        } catch {}
        this.activeWsClients.delete(client);
      }
    }
    return existed;
  }

  revokeAll(): void {
    this.pairedClients.clear();
    for (const client of this.activeWsClients) {
      try {
        client.ws.close(4001, 'All pairings revoked');
      } catch {}
    }
    this.activeWsClients.clear();
  }

  /** 当桌面或总线状态发生改变时触发，扫描三类事件并执行严格单次去重推送 */
  notifyStateChanged(projectId?: string): void {
    if (!this.isRunning || this.activeWsClients.size === 0) {
      return;
    }
    const targetProjectId = projectId || this.resolveActiveProjectId();
    if (!targetProjectId) {
      return;
    }

    try {
      const state = this.getMobileState(targetProjectId);

      // 1. 扫描「等你处理」事件
      for (const item of state.waiting) {
        const key = `wait:${item.id}`;
        if (!this.sentAlertKeys.has(key)) {
          this.sentAlertKeys.add(key);
          this.broadcast({
            type: 'alert',
            alertType: 'waiting_for_user',
            taskId: item.id,
            memberLabel: item.memberLabel,
            title: '等你处理',
            body: `${item.memberLabel}：${item.question.slice(0, 60)}`,
            timestamp: item.timestamp,
          });
        }
      }

      // 2. 扫描「已交付/完成」事件
      for (const item of state.delivered) {
        if (item.type === 'done') {
          const key = `done:${item.id}`;
          if (!this.sentAlertKeys.has(key)) {
            this.sentAlertKeys.add(key);
            const artInfo = item.artifacts.length > 0 ? `（成果: ${item.artifacts.map(a => a.name).join(', ')}）` : '';
            this.broadcast({
              type: 'alert',
              alertType: 'done',
              taskId: item.id,
              memberLabel: item.memberLabel,
              title: '任务已交付',
              body: `${item.memberLabel} 交付了 ${item.title}${artInfo}`,
              timestamp: item.timestamp,
            });
          }
        }
      }

      // 3. 扫描「失败」事件
      for (const item of state.failed) {
        const key = `fail:${item.id}`;
        if (!this.sentAlertKeys.has(key)) {
          this.sentAlertKeys.add(key);
          this.broadcast({
            type: 'alert',
            alertType: 'failed',
            taskId: item.id,
            memberLabel: item.memberLabel,
            title: '任务失败',
            body: `${item.memberLabel}：${item.error || '遇到错误'}`,
            timestamp: item.timestamp,
          });
        }
      }

      // 广播常规状态更新通知
      this.broadcast({ type: 'state:changed', timestamp: new Date().toISOString() });
    } catch (err) {
      // 容错处理，避免影响主流程
    }
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.activeWsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch {}
      }
    }
  }

  private resolveActiveProjectId(): string | undefined {
    const projects = this.store.listProjects();
    if (projects.length === 0) return undefined;

    // 1. 优先寻找当前有正在运行（running）会话的项目（包括 inbox）
    for (const project of projects) {
      const sessions = this.store.listSessions(project.id);
      if (sessions.some(s => this.isSessionRunning ? this.isSessionRunning(s.id) : false)) {
        return project.id;
      }
    }

    // 2. 寻找最近有活跃派工（running 或 queued）的项目
    for (const project of projects) {
      const snapshots = this.team.projectBuses(project.id).map(bus => bus.snapshot());
      const hasActive = snapshots.some(snap =>
        snap.dispatches.some(d => d.status === 'running' || d.status === 'queued')
      );
      if (hasActive) {
        return project.id;
      }
    }

    // 3. 寻找最近有更新的项目（按 updated_at 倒序，优先非 inbox）
    const sorted = [...projects].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const activeNormal = sorted.find(p => p.kind !== 'inbox');
    return activeNormal?.id ?? sorted[0]?.id;
  }

  /** 状态聚合引擎：精准生成「等你处理」、「进行中/排队」、「已交付」三层分类 */
  getMobileState(projectId: string): MobileStatePayload {
    const project = this.store.project(projectId);
    if (!project) {
      return {
        project: null,
        availableProjects: [],
        waiting: [],
        inProgress: [],
        delivered: [],
        failed: [],
        members: [],
        briefingText: '当前项目不存在',
        serverTime: new Date().toISOString(),
      };
    }

    const allProjects = this.store.listProjects();
    const availableProjects: AvailableProjectItem[] = allProjects.map(p => {
      const pSessions = this.store.listSessions(p.id);
      const isRunning = pSessions.some(s => this.isSessionRunning ? this.isSessionRunning(s.id) : false);
      const pSnapshots = this.team.projectBuses(p.id).map(bus => bus.snapshot());
      const waitingCount = pSnapshots.flatMap(s => s.messages).filter(
        m => m.requiresAction && (m.to === OWNER || m.to === 'all') && m.receipts[OWNER] !== 'processed'
      ).length;
      const inProgressCount = pSnapshots.flatMap(s => s.dispatches).filter(
        d => d.status === 'running' || d.status === 'queued'
      ).length + (isRunning ? 1 : 0);
      return {
        id: p.id,
        name: p.name || (p.kind === 'inbox' ? '自由对话任务' : '项目'),
        kind: p.kind,
        isRunning,
        waitingCount,
        inProgressCount,
      };
    });

    const snapshots = this.team.projectBuses(projectId).map(bus => bus.snapshot());
    const snapshot = {
      messages: snapshots.flatMap(item => item.messages),
      dispatches: snapshots.flatMap(item => item.dispatches),
      tasks: snapshots.flatMap(item => Object.values(item.tasks)),
    };
    const sessions = this.store.listSessions(projectId);
    const sessionMap = new Map(sessions.map(s => [s.id, s]));

    const waiting: WaitingItem[] = [];
    const inProgress: InProgressItem[] = [];
    const delivered: DeliveredItem[] = [];
    const failed: DeliveredItem[] = [];

    // 1. 等你处理 (waiting_for_user)
    // 来源 A: requiresAction 为 true 且发给用户/全体但未处理的消息
    for (const msg of snapshot.messages) {
      if (msg.requiresAction && (msg.to === OWNER || msg.to === 'all') && msg.receipts[OWNER] !== 'processed') {
        const senderSession = sessionMap.get(msg.sender);
        waiting.push({
          id: msg.id,
          messageId: msg.id,
          type: 'waiting_for_user',
          memberId: msg.sender,
          memberLabel: this.team.labelOf(projectId, msg.sender),
          title: msg.text.split('\n')[0].slice(0, 35) || '请用户决定',
          question: msg.text,
          timestamp: msg.time,
          requiresAction: true,
          threadId: msg.threadId,
          channelId: msg.channel,
          channelLabel: msg.channel ? (msg.channel === 'default' ? '主线' : msg.channel) : undefined,
          taskGroup: senderSession?.group_id,
        });
      }
    }

    // 来源 B: 明确处于 blocked 状态且带 blocker 说明的任务
    for (const task of Object.values(snapshot.tasks)) {
      if (task.report === 'blocked' && task.blocker) {
        if (!waiting.some(w => w.id === task.id)) {
          const ownerSession = sessionMap.get(task.owner);
          waiting.push({
            id: task.id,
            messageId: task.id,
            type: 'waiting_for_user',
            memberId: task.owner,
            memberLabel: task.ownerLabel || this.team.labelOf(projectId, task.owner),
            title: `阻塞：${task.blocker.slice(0, 30)}`,
            question: task.blocker,
            blocker: task.blocker,
            timestamp: task.updated,
            requiresAction: true,
            taskGroup: ownerSession?.group_id,
          });
        }
      }
    }

    // 2. 进行中 / 排队 (in_progress)
    // 来源 A: dispatches 状态为 running 或 queued
    for (const dispatch of snapshot.dispatches) {
      if (dispatch.status === 'running' || dispatch.status === 'queued') {
        const session = sessionMap.get(dispatch.owner);
        const task = session && this.team.taskOf(projectId, dispatch.owner);
        inProgress.push({
          id: dispatch.id,
          type: dispatch.status,
          memberId: dispatch.owner,
          memberLabel: this.team.labelOf(projectId, dispatch.owner),
          model: session?.model ?? '',
          title: dispatch.reason || '派工处理中',
          progress: task?.next || (dispatch.status === 'running' ? '正在执行' : '等待空闲排队'),
          timestamp: dispatch.updated,
          taskGroup: session?.group_id,
        });
      }
    }

    // 来源 B: 正在跑的活跃 session
    for (const session of sessions) {
      const isRunning = this.isSessionRunning ? this.isSessionRunning(session.id) : false;
      if (isRunning && !inProgress.some(item => item.memberId === session.id && item.type === 'running')) {
        const task = this.team.taskOf(projectId, session.id);
        inProgress.push({
          id: `running:${session.id}`,
          type: 'running',
          memberId: session.id,
          memberLabel: session.member_label,
          model: session.model,
          title: task?.next ? `任务进行中` : '思考与回答中',
          progress: task?.next || '正在生成回复',
          timestamp: new Date().toISOString(),
          taskGroup: session.group_id,
        });
      }
    }

    // 3. 已交付 (delivered) & 失败 (failed)
    const allArtifacts = this.team.artifacts(projectId);
    for (const dispatch of snapshot.dispatches) {
      const session = sessionMap.get(dispatch.owner);
      if (dispatch.status === 'done') {
        const relatedArtifacts = allArtifacts
          .filter(a => (dispatch.runId && a.runId === dispatch.runId) || a.owner === dispatch.owner)
          .map(a => ({
            id: a.id,
            name: a.name,
            path: a.path || '',
            size: a.size || 0,
            absolutePath: a.absolutePath,
          }));

        delivered.push({
          id: dispatch.id,
          type: 'done',
          memberId: dispatch.owner,
          memberLabel: this.team.labelOf(projectId, dispatch.owner),
          title: dispatch.reason || '已完成任务',
          conclusion: dispatch.reason || '任务已成功交付',
          taskGroup: session?.group_id,
          artifacts: relatedArtifacts,
          timestamp: dispatch.updated,
        });
      } else if (dispatch.status === 'failed') {
        failed.push({
          id: dispatch.id,
          type: 'failed',
          memberId: dispatch.owner,
          memberLabel: this.team.labelOf(projectId, dispatch.owner),
          title: dispatch.reason || '任务异常中断',
          conclusion: '执行失败',
          error: dispatch.error || dispatch.reason || '未知错误',
          rawError: dispatch.error || dispatch.reason || '任务异常中断',
          taskGroup: session?.group_id,
          artifacts: [],
          timestamp: dispatch.updated,
        });
      }
    }

    // 如果还没有 dispatches，读取 runs 中的最新交付成果
    if (delivered.length === 0) {
      for (const session of sessions) {
        const runs = this.store.sessionRuns(session.id);
        const lastDoneRun = runs.filter(r => r.status === 'done').slice(-1)[0];
        if (lastDoneRun) {
          const runArtifacts = this.store.listArtifacts(session.id).filter(a => a.run_id === lastDoneRun.id);
          delivered.push({
            id: lastDoneRun.id,
            type: 'done',
            memberId: session.id,
            memberLabel: session.member_label,
            title: lastDoneRun.prompt.slice(0, 35) || '已完成回合',
            conclusion: lastDoneRun.reply_text.slice(0, 200),
            taskGroup: session.group_id,
            artifacts: runArtifacts.map(a => ({
              id: a.id,
              name: a.name,
              path: a.path,
              size: a.size,
              absolutePath: path.resolve(project.workspace, a.path),
            })),
            timestamp: lastDoneRun.ended_at || lastDoneRun.started_at,
          });
        }
      }
    }

    // 成员列表
    const members = sessions.map(s => ({
      id: s.id,
      label: s.member_label,
      model: s.model,
      host: s.host,
      isRunning: this.isSessionRunning ? this.isSessionRunning(s.id) : false,
    }));

    // 语音简报文本
    const briefingText = buildBriefingText({ waiting, inProgress, delivered, failed });

    return {
      project: {
        id: project.id,
        name: project.name,
        workspace: project.workspace,
        kind: project.kind,
      },
      availableProjects,
      waiting,
      inProgress,
      delivered,
      failed,
      members,
      briefingText,
      serverTime: new Date().toISOString(),
    };
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url ?? '/', `http://${this.hostIp}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. 配对接口 POST /api/mobile/pair
    if (pathname === '/api/mobile/pair' && method === 'POST') {
      this.readJsonBody(req, body => {
        const pin = String(body.pin ?? '').trim();
        const deviceName = String(body.deviceName ?? 'iQOO Neo9 Pro').trim();
        if (pin !== this.pin) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: '配对码错误或已失效' }));
          return;
        }

        const token = randomUUID();
        const client: MobileClientSession = {
          token,
          deviceName,
          ip: req.socket.remoteAddress || 'unknown',
          pairedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        };
        this.pairedClients.set(token, client);

        const activeProjectId = this.resolveActiveProjectId();
        const project = activeProjectId ? this.store.project(activeProjectId) : null;

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            token,
            projectId: activeProjectId,
            projectName: project?.name ?? '蜂群',
          }),
        );
      });
      return;
    }

    // 2. 解绑接口 POST /api/mobile/unpair
    if (pathname === '/api/mobile/unpair' && method === 'POST') {
      this.readJsonBody(req, body => {
        const token = String(body.token ?? '');
        this.revokeClient(token);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // 3. 鉴权检验
    const authHeader = req.headers.authorization ?? '';
    const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const token = tokenFromHeader || parsedUrl.searchParams.get('token') || '';

    // 静态文件无需鉴权直接服务（供配对页面与单页应用加载）
    if (this.staticAssetsDir && (pathname === '/' || pathname.startsWith('/assets/') || pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.svg') || pathname.endsWith('.ico'))) {
      this.serveStaticFile(pathname, res);
      return;
    }

    if (!token || !this.pairedClients.has(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, message: '未授权或配对已失效，请重新配对' }));
      return;
    }

    // 更新 client 的 lastSeen
    const client = this.pairedClients.get(token);
    if (client) client.lastSeenAt = new Date().toISOString();

    // 4. 获取整体状态 GET /api/mobile/state
    if (pathname === '/api/mobile/state' && method === 'GET') {
      const projectId = parsedUrl.searchParams.get('projectId') || this.resolveActiveProjectId();
      if (!projectId) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: '无可用项目' }));
        return;
      }
      const state = this.getMobileState(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
      return;
    }

    // 5. 获取语音简报文本 GET /api/mobile/briefing
    if (pathname === '/api/mobile/briefing' && method === 'GET') {
      const projectId = parsedUrl.searchParams.get('projectId') || this.resolveActiveProjectId();
      if (!projectId) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ text: '当前没有活动项目。' }));
        return;
      }
      const state = this.getMobileState(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text: state.briefingText }));
      return;
    }

    // 6. 产物内容回读与下载 GET /api/mobile/artifacts/:id
    if (pathname.startsWith('/api/mobile/artifacts/') && method === 'GET') {
      const artifactId = pathname.replace('/api/mobile/artifacts/', '');
      const projectId = parsedUrl.searchParams.get('projectId') || this.resolveActiveProjectId();
      if (!projectId) {
        res.writeHead(404);
        res.end('Project not found');
        return;
      }
      const artifacts = this.team.artifacts(projectId);
      const target = artifacts.find(a => a.id === artifactId);
      if (!target || !target.absolutePath || !fs.existsSync(target.absolutePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('产物文件不存在');
        return;
      }

      const ext = path.extname(target.absolutePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (['.txt', '.md', '.log', '.json', '.ts', '.js', '.py'].includes(ext)) {
        contentType = 'text/plain; charset=utf-8';
      } else if (['.png'].includes(ext)) {
        contentType = 'image/png';
      } else if (['.jpg', '.jpeg'].includes(ext)) {
        contentType = 'image/jpeg';
      } else if (['.svg'].includes(ext)) {
        contentType = 'image/svg+xml';
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(target.name)}"`,
      });
      fs.createReadStream(target.absolutePath).pipe(res);
      return;
    }

    // 7. 手机端快捷决策/回复接口 POST /api/mobile/reply
    if (pathname === '/api/mobile/reply' && method === 'POST') {
      this.readJsonBody(req, body => {
        const messageId = String(body.messageId ?? '').trim();
        const replyText = String(body.replyText ?? '').trim();
        const targetProjectId = String(body.projectId ?? '').trim() || this.resolveActiveProjectId();
        const threadId = body.threadId ? String(body.threadId).trim() : undefined;
        const channel = body.channel ? String(body.channel).trim() : undefined;

        if (!targetProjectId || !messageId || !replyText) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: '缺少必填参数 (messageId, replyText)' }));
          return;
        }

        try {
          const buses = this.team.projectBuses(targetProjectId);
          const targetBus = buses.find(b => b.snapshot().messages.some(m => m.id === messageId));
          const targetMsg = targetBus?.snapshot().messages.find(m => m.id === messageId);

          const finalThread = threadId || targetMsg?.threadId || (targetMsg ? targetMsg.id : undefined);
          const targetTo = targetMsg?.sender;

          // 发送决策回复至总线
          this.team.post({
            projectId: targetProjectId,
            from: OWNER,
            sessionId: targetTo,
            to: targetTo,
            text: replyText,
            thread: finalThread,
          });

          // 将原等待提问消息标记为已由用户处理
          this.team.ack(targetProjectId, OWNER, [messageId]);

          // 触发状态改变与事件广播
          this.notifyStateChanged(targetProjectId);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: '决策回复已送达蜂群总线' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: (err as Error).message }));
        }
      });
      return;
    }

    // 默认 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  private serveStaticFile(reqPath: string, res: ServerResponse): void {
    if (!this.staticAssetsDir) {
      res.writeHead(404);
      res.end();
      return;
    }
    const safePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
    const fullPath = path.resolve(this.staticAssetsDir, safePath);
    if (!fullPath.startsWith(path.resolve(this.staticAssetsDir)) || !fs.existsSync(fullPath)) {
      // SPA fallback to index.html
      const fallback = path.resolve(this.staticAssetsDir, 'index.html');
      if (fs.existsSync(fallback)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(fallback).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.json': 'application/json',
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  }

  private readJsonBody(req: IncomingMessage, onDone: (body: Record<string, any>) => void): void {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        onDone(JSON.parse(raw));
      } catch {
        onDone({});
      }
    });
  }
}
