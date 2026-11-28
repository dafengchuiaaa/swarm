/**
 * 独立蜂群 Electron 入口。
 *
 * 宿主能力通过 packages/swarm-hosts 的 Python 桥以进程边界接入。
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HostBridge } from '../../../swarm-hosts/src/hostBridge';
import { TeamService, OWNER } from '../../../swarm-team/src/service';
import { DispatchQueue } from '../../../swarm-team/src/dispatchQueue';
import { BusGateway } from './busServer';
import { RunManager } from './runner';
import { MobileGatewayServer } from './mobileServer';
import { registerMobileIpc } from './mobileIpc';
import { buildPublicBoard } from './publicBoard';
import { SwarmStore, defaultDataDir } from './store';
import type { SessionRecord } from './store';
import { finishHandoff, startHandoff } from './compaction';
import type { CompactionDecision } from './compaction';
import { ensureMemberWorktree } from './worktree';
import { StallMonitor } from './stallMonitor';
import type { HostCatalog } from '../shared/types';
import {
  canDetachInspector,
  inspectorKey,
  toOccupiedItem,
  type InspectorOccupancyPayload,
  type InspectorSnapshot,
  type OccupiedInspectorItem,
} from '../shared/inspectorSync';
import { runSmoke, prepareSmoke } from './devSmoke';

const isDev = !app.isPackaged;

function hostsDir(): string {
  if (process.env.SWARM_HOSTS_DIR) return path.resolve(process.env.SWARM_HOSTS_DIR);
  let cursor = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(cursor, 'packages', 'swarm-hosts', 'python');
    if (existsSync(candidate)) return candidate;
    cursor = path.dirname(cursor);
  }
  return path.resolve(__dirname, '../../../../packages/swarm-hosts/python');
}

let mainWindow: BrowserWindow | null = null;
let store: SwarmStore;
let bridge: HostBridge;
let runner: RunManager;
let team: TeamService;
let gateway: BusGateway;
let mobileServer: MobileGatewayServer;
let quitting = false;

/** 独立部署时 MCP 服务脚本在仓库里；打包后随 resources 一起走。 */
function mcpServerPath(): string {
  if (process.env.SWARM_MCP_SERVER) return path.resolve(process.env.SWARM_MCP_SERVER);
  let cursor = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(cursor, 'packages', 'swarm-team', 'mcp', 'server.mjs');
    if (existsSync(candidate)) return candidate;
    cursor = path.dirname(cursor);
  }
  return path.resolve(__dirname, '../../../../packages/swarm-team/mcp/server.mjs');
}

/** Windows 下 GUI 进程的 stdout 常被吞掉，启动过程一律同时写一份文件，便于复核原始错误。 */
function logLine(message: string): void {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(defaultDataDir(), { recursive: true });
    appendFileSync(path.join(defaultDataDir(), 'shell.log'), `[${stamp}] ${message}\n`, 'utf8');
  } catch {
    // 日志写不进去不能影响启动
  }
  console.log(`[swarm] ${message}`);
}

function toWindow(channel: string, payload: unknown): void {
  // 主窗口与拆出的侧栏窗口都要收到事件，各自维护自己的视图。
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
  if (channel === 'team:changed') {
    mobileServer?.notifyStateChanged((payload as { projectId?: string })?.projectId);
  }
}

/** 主窗与拆出的侧栏/会话窗共用同一份前端：开发期都走 Vite，避免分窗读到旧的 out/ 构建。 */
function loadRenderer(win: BrowserWindow, hash?: string): void {
  const devUrl = isDev && process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined);
}

function createWindow(): void {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 700,
    backgroundColor: '#f2f7f7',
    titleBarStyle: 'hidden',
    title: '蜂群',
    icon: path.join(app.getAppPath(), 'assets', 'swarm.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:state', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:state', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const { win } of inspectorWindows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    for (const { win } of sessionWindows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    if (!quitting) app.quit();
  });

  loadRenderer(mainWindow);

  mainWindow.webContents.on('console-message' as never, ((_event: unknown, ...rest: any[]) => {
    const details = rest[0];
    const isNew = typeof details === 'object' && details !== null;
    const message = isNew ? String(details.message ?? '') : String(rest[1] ?? '');
    const level = isNew ? String(details.level ?? '') : String(rest[0] ?? '');
    const bad = /error|warning/i.test(level) || Number(level) >= 2;
    if (bad) logLine(`渲染进程[${level}]：${message}`);
  }) as never);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 自定义标题栏的窗口控件（渲染层 ui-polish 绑定）；按发送者窗口生效，拆出的侧栏窗口同样可用。
ipcMain.on('win:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('win:maximize', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', event => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle('win:isMaximized', event => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
// 真实系统拖拽里 dragend 的坐标/dropEffect 会被外部放置目标改写，渲染层改问主进程要 OS 光标的窗内坐标。
ipcMain.handle('win:cursorClient', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  return { x: point.x - bounds.x, y: point.y - bounds.y };
});

// ---------------------------------------------------------------- 拆出的侧栏窗口（支持多窗口并发拆出，关闭即收回）
interface DetachedInspectorEntry {
  id: string;
  win: BrowserWindow;
  ready: boolean;
  snapshot: InspectorSnapshot;
}

const inspectorWindows = new Map<string, DetachedInspectorEntry>();
let inspectorSeq = 0;
let mainInspectorSnapshot: InspectorSnapshot = { mode: 'files', sessionId: null, open: false };

function inspectorWindowTitle(snapshot: InspectorSnapshot): string {
  if (snapshot.mode === 'session' && snapshot.sessionId) {
    const label = store?.session(snapshot.sessionId)?.member_label;
    return label ? `蜂群 · 侧栏 · ${label}` : '蜂群 · 侧栏 · 会话';
  }
  if (snapshot.mode === 'preview' && snapshot.preview?.name) {
    return `蜂群 · 侧栏 · ${snapshot.preview.name}`;
  }
  if (snapshot.mode === 'thread') return '蜂群 · 侧栏 · 讨论';
  return '蜂群 · 侧栏 · 产出';
}

function buildInspectorOccupancy(): InspectorOccupancyPayload {
  const items: OccupiedInspectorItem[] = [];
  const mainItem = toOccupiedItem('main', mainInspectorSnapshot);
  if (mainItem) items.push(mainItem);
  for (const entry of inspectorWindows.values()) {
    if (entry.win.isDestroyed()) continue;
    const item = toOccupiedItem(entry.id, entry.snapshot);
    if (item) items.push(item);
  }
  return { items };
}

function broadcastInspectorOccupancy(): void {
  const payload = buildInspectorOccupancy();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inspector:occupancy', payload);
  for (const entry of inspectorWindows.values()) {
    if (!entry.win.isDestroyed() && entry.ready) entry.win.webContents.send('inspector:occupancy', payload);
  }
}

function focusInspectorByKey(key: string): boolean {
  if (key.startsWith('session:')) {
    const sessionWin = sessionWindows.get(key.slice('session:'.length));
    if (sessionWin && !sessionWin.win.isDestroyed()) {
      if (sessionWin.win.isMinimized()) sessionWin.win.restore();
      sessionWin.win.focus();
      return true;
    }
  }
  for (const entry of inspectorWindows.values()) {
    if (entry.win.isDestroyed()) continue;
    if (inspectorKey(entry.snapshot) === key) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.focus();
      return true;
    }
  }
  return false;
}

function createInspectorWindow(rawSnapshot: InspectorSnapshot): { ok: boolean; windowId?: string; reason?: string; message?: string } {
  const snapshot: InspectorSnapshot = { ...rawSnapshot, open: true };
  const valid = canDetachInspector(snapshot);
  if (!valid.ok) return { ok: false, reason: 'empty', message: valid.message };

  if (snapshot.mode === 'session' && snapshot.sessionId) {
    const existingSession = sessionWindows.get(snapshot.sessionId);
    if (existingSession && !existingSession.win.isDestroyed()) {
      if (existingSession.win.isMinimized()) existingSession.win.restore();
      existingSession.win.focus();
      return { ok: false, reason: 'duplicate', message: '该成员已在独立会话窗口打开，已为你聚焦' };
    }
  }

  const key = inspectorKey(snapshot);
  for (const existing of inspectorWindows.values()) {
    if (existing.win.isDestroyed()) continue;
    if (inspectorKey(existing.snapshot) === key) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return { ok: false, reason: 'duplicate', windowId: existing.id, message: '该内容已在独立窗口打开，已为你聚焦' };
    }
  }

  const id = String(++inspectorSeq);
  const previous = [...inspectorWindows.values()].reverse().find(item => !item.win.isDestroyed());
  let position: { x: number; y: number } | undefined;
  if (previous) {
    const prevBounds = previous.win.getBounds();
    const area = screen.getDisplayMatching(prevBounds).workArea;
    const x = Math.min(prevBounds.x + 28, area.x + Math.max(0, area.width - 460));
    const y = Math.min(prevBounds.y + 28, area.y + Math.max(0, area.height - 780));
    position = { x, y };
  }

  const win = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 340,
    minHeight: 480,
    ...(position ? { x: position.x, y: position.y } : {}),
    backgroundColor: '#f2f7f7',
    titleBarStyle: 'hidden',
    title: inspectorWindowTitle(snapshot),
    icon: path.join(app.getAppPath(), 'assets', 'swarm.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const entry: DetachedInspectorEntry = { id, win, ready: false, snapshot };
  inspectorWindows.set(id, entry);

  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:state', true);
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:state', false);
  });
  win.on('closed', () => {
    inspectorWindows.delete(id);
    broadcastInspectorOccupancy();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  loadRenderer(win, `inspector=${encodeURIComponent(id)}`);
  broadcastInspectorOccupancy();
  return { ok: true, windowId: id };
}

ipcMain.handle('inspector:detach', (_event, snapshot: InspectorSnapshot) => createInspectorWindow(snapshot));
ipcMain.handle('inspector:focus', (_event, key: string) => focusInspectorByKey(String(key ?? '')));
ipcMain.on('inspector:ready', (event, windowId?: string) => {
  if (event.sender === mainWindow?.webContents) {
    mainWindow.webContents.send('inspector:occupancy', buildInspectorOccupancy());
    return;
  }
  const entry = (windowId ? inspectorWindows.get(String(windowId)) : undefined)
    ?? [...inspectorWindows.values()].find(item => !item.win.isDestroyed() && item.win.webContents === event.sender);
  if (!entry || entry.win.isDestroyed()) return;
  entry.ready = true;
  entry.win.webContents.send('inspector:occupancy', buildInspectorOccupancy());
  entry.win.webContents.send('inspector:show', entry.snapshot);
});
ipcMain.on('inspector:state', (event, snapshot: InspectorSnapshot) => {
  if (event.sender === mainWindow?.webContents) {
    mainInspectorSnapshot = { ...snapshot };
    broadcastInspectorOccupancy();
    return;
  }
  const entry = [...inspectorWindows.values()].find(item => !item.win.isDestroyed() && item.win.webContents === event.sender);
  if (!entry || entry.win.isDestroyed()) return;
  entry.snapshot = { ...entry.snapshot, ...snapshot, open: true };
  entry.win.setTitle(inspectorWindowTitle(entry.snapshot));
  broadcastInspectorOccupancy();
});
ipcMain.on('inspector:context', (_event, context: Partial<InspectorSnapshot>) => {
  for (const entry of inspectorWindows.values()) {
    if (entry.win.isDestroyed()) continue;
    if (Array.isArray(context?.detachedSessions)) entry.snapshot.detachedSessions = context.detachedSessions;
    if (entry.ready) entry.win.webContents.send('inspector:context', context);
  }
});
ipcMain.on('inspector:swap', (event, payload: { sessionId?: string }) => {
  const entry = [...inspectorWindows.values()].find(item => !item.win.isDestroyed() && item.win.webContents === event.sender);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('inspector:swap', { sessionId: payload?.sessionId, windowId: entry?.id });
  }
});
ipcMain.on('inspector:assign', (_event, payload: { windowId?: string; sessionId?: string; mainSessionId?: string }) => {
  const entry = payload?.windowId ? inspectorWindows.get(String(payload.windowId)) : undefined;
  if (!entry || entry.win.isDestroyed() || !payload?.sessionId) return;
  entry.snapshot = {
    ...entry.snapshot,
    mode: 'session',
    sessionId: payload.sessionId,
    mainSessionId: payload.mainSessionId ?? entry.snapshot.mainSessionId,
    open: true,
  };
  entry.win.setTitle(inspectorWindowTitle(entry.snapshot));
  broadcastInspectorOccupancy();
  if (entry.ready) {
    entry.win.webContents.send('inspector:assign', {
      sessionId: payload.sessionId,
      mainSessionId: payload.mainSessionId,
    });
  }
});

// ---------------------------------------------------------------- 拆出的会话窗口（一条会话一个窗口）
const sessionWindows = new Map<string, { win: BrowserWindow; projectId: string }>();

function createSessionWindow(projectId: string, sessionId: string): void {
  const existing = sessionWindows.get(sessionId);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return;
  }
  const session = store.session(sessionId);
  const project = store.project(projectId);
  if (!session || !project || session.project_id !== projectId) throw new Error('会话不存在');
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 560,
    minHeight: 480,
    backgroundColor: '#f2f7f7',
    titleBarStyle: 'hidden',
    title: `蜂群 · ${session.member_label}`,
    icon: path.join(app.getAppPath(), 'assets', 'swarm.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const entry = { win, projectId };
  sessionWindows.set(sessionId, entry);
  win.on('maximize', () => win.webContents.send('win:state', true));
  win.on('unmaximize', () => win.webContents.send('win:state', false));
  win.on('closed', () => {
    sessionWindows.delete(sessionId);
    toWindow('session-window:closed', { sessionId, projectId: entry.projectId });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.once('did-finish-load', () => toWindow('session-window:opened', { sessionId, projectId: entry.projectId }));
  loadRenderer(win, `session=${projectId}&id=${sessionId}`);
}

ipcMain.handle('session:detach', (_event, input: { projectId: string; sessionId: string }) => {
  createSessionWindow(input.projectId, input.sessionId);
  return true;
});
ipcMain.handle('session:reattach', (_event, sessionId: string) => {
  sessionWindows.get(sessionId)?.win.close();
  return true;
});

// 独立窗口把会话拖回来：开始时让主窗亮出接收层；松手时 OS 光标在主窗内就关窗塞回（closed 事件会让主窗打开该会话）。
ipcMain.on('session:dragback', (event, payload: { phase?: string; sessionId?: string }) => {
  const sessionId = String(payload?.sessionId ?? '');
  const phase = payload?.phase === 'start' ? 'start' : 'end';
  toWindow('session:dragback', { phase, sessionId });
  if (phase !== 'end' || !mainWindow || mainWindow.isDestroyed()) return;
  const entry = sessionWindows.get(sessionId);
  if (!entry || entry.win.isDestroyed() || entry.win.webContents !== event.sender) return;
  const point = screen.getCursorScreenPoint();
  const bounds = mainWindow.getBounds();
  const over = point.x >= bounds.x && point.y >= bounds.y
    && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
  if (over) entry.win.close();
});

async function hostCatalog(): Promise<HostCatalog> {
  return await bridge.catalog() as HostCatalog;
}

function registerIpc(): void {
  ipcMain.handle('system:quotas', async () => (await bridge.request<{ accounts: unknown }>('quotas', {}, 40_000)).accounts);
  ipcMain.handle('system:codeBuddyModels', async () =>
    (await bridge.request<{ catalog: unknown }>('codebuddy:models', {}, 18_000)).catalog,
  );
  ipcMain.handle('system:hostEnabled', async (_event, host: string, enabled: boolean) =>
    (await bridge.request<{ catalog: unknown }>('host:set_enabled', { host, enabled })).catalog,
  );
  ipcMain.handle('system:hostPath', async (_event, host: string, file: string) =>
    (await bridge.request<{ catalog: unknown }>('host:set_path', { host, path: file })).catalog,
  );
  ipcMain.handle('system:probeHost', async (_event, host: string, file: string) =>
    (await bridge.request<{ message: string }>('host:probe', { host, path: file }, 15_000)).message,
  );
  ipcMain.handle('system:pickHostPath', async (_event, host: string) => {
    const result = await dialog.showOpenDialog({ title: '选择宿主入口', properties: ['openFile'],
      filters: [{ name: '本机程序', extensions: host === 'ZCode' ? ['cjs', 'js'] : host === 'Qoder' ? ['exe'] : ['exe', 'cmd'] }] });
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle('project:default', () => store.inboxProject());
  ipcMain.handle('system:paths', () => ({
    dataDir: defaultDataDir(),
    dbFile: store.file,
    python: bridge.pythonCommand,
    hostsDir: hostsDir(),
    electron: process.versions.electron,
  }));

  ipcMain.handle('system:getStallMonitor', () => ({ enabled: store.getStallMonitorEnabled() }));
  ipcMain.handle('system:setStallMonitor', (_event, enabled: boolean) => {
    const next = Boolean(enabled);
    store.setStallMonitorEnabled(next);
    stallMonitor?.setEnabled(next);
    logLine(`防卡死巡检已${next ? '开启' : '关闭'}`);
    return { enabled: next };
  });

  ipcMain.handle('system:catalog', async () => {
    try {
      return await hostCatalog();
    } catch (error) {
      return { hosts: [], models: {}, thoughtLevels: {}, error: (error as Error).message };
    }
  });

  ipcMain.handle('project:list', () => store.listProjects());

  ipcMain.handle('project:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择已有工作区',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:create', (_event, input: { name?: string; workspace: string }) => {
    const workspace = path.resolve(input.workspace);
    if (!existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`);
    const name = (input.name ?? '').trim() || path.basename(workspace) || '未命名项目';
    return store.createProject(name, workspace);
  });

  ipcMain.handle('session:list', (_event, projectId: string) => store.listSessions(projectId));

  // 「最近」：跨项目一把捞，侧栏只呈现一条时间线。
  ipcMain.handle('session:recent', () => store.recentSessions());

  ipcMain.handle(
    'session:create',
    (_event, input: { projectId: string; memberLabel: string; host: string; model: string; effort?: string;
      groupId?: string; channelId?: string; scopeSessionId?: string }) => {
      const project = store.project(input.projectId);
      if (!project) throw new Error('项目不存在');
      const anchor = input.scopeSessionId ? store.session(input.scopeSessionId) : undefined;
      if (input.scopeSessionId && anchor?.project_id !== project.id) throw new Error('会话不在当前项目');
      if (input.channelId) {
        if (project.kind === 'inbox' && !anchor) throw new Error('请先打开一个会话');
        const bus = team.bus(project.id, anchor?.id);
        if (input.channelId === bus.channelId) throw new Error('主线会自动加入项目成员');
        bus.assertCanPost(input.channelId, OWNER);
      }
      const session = store.createSession({
        projectId: input.projectId,
        memberLabel: input.memberLabel.trim() || '成员',
        host: input.host,
        model: input.model,
        effort: input.effort ?? '',
        groupId: project.kind === 'inbox' ? anchor?.group_id || input.groupId : input.groupId,
        parentSessionId: project.kind === 'inbox' ? anchor?.id : undefined,
      });
      team.refreshMembers(project.id);
      if (input.channelId) {
        team.manageChannel({ projectId: project.id, sessionId: anchor?.id, from: OWNER, operation: 'invite',
          channelId: input.channelId, memberIds: [session.id] });
      }
      return session;
    },
  );

  ipcMain.handle('session:move', (_event, input: { sessionId: string; projectId: string }) => {
    const session = store.session(input.sessionId);
    if (!session) throw new Error('会话不存在');
    const target = store.project(input.projectId);
    if (!target) throw new Error('目标项目不存在');
    if (session.project_id === target.id) return session;
    if (runner.runningSession(session.id)) throw new Error('会话正在执行，等回合结束后再移动');
    const from = session.project_id;
    const moved = store.moveSession(session.id, target.id);
    team.refreshMembers(from);
    team.refreshMembers(target.id);
    // 拆出的会话窗口仍绑着旧项目：通知它就地位换绑（只改 hash 是 fragment 导航，渲染层不会重启）。
    const detached = sessionWindows.get(session.id);
    if (detached && !detached.win.isDestroyed()) {
      detached.projectId = target.id;
      detached.win.webContents.send('session:moved', { sessionId: session.id, projectId: target.id });
    }
    for (const entry of inspectorWindows.values()) {
      if (!entry.win.isDestroyed() && entry.snapshot.sessionId === session.id) entry.win.close();
    }
    toWindow('team:changed', { projectId: from });
    toWindow('team:changed', { projectId: target.id });
    return moved;
  });

  ipcMain.handle('session:delete', (_event, sessionId: string) => {
    const session = store.session(sessionId);
    if (!session) throw new Error('会话不存在');
    if (runner.runningSession(sessionId)) throw new Error('会话正在执行，先停止回合再删除');
    sessionWindows.get(sessionId)?.win.close();
    for (const entry of inspectorWindows.values()) {
      if (!entry.win.isDestroyed() && entry.snapshot.sessionId === sessionId) entry.win.close();
    }
    store.deleteSession(sessionId);
    team.refreshMembers(session.project_id);
    toWindow('team:changed', { projectId: session.project_id });
    return true;
  });

  ipcMain.handle('project:update', (_event, input: { id: string; name?: string; archived?: boolean }) => {
    const updated = store.updateProject(input.id, input);
    if (!updated) throw new Error('项目不存在');
    toWindow('projects:changed', {});
    return updated;
  });

  ipcMain.handle('project:delete', (_event, projectId: string) => {
    const project = store.project(projectId);
    if (!project) throw new Error('项目不存在');
    if (store.runningRuns(projectId).length) throw new Error('项目里还有正在执行的回合，先停止再删除');
    for (const session of store.listSessions(projectId)) sessionWindows.get(session.id)?.win.close();
    for (const entry of inspectorWindows.values()) {
      if (!entry.win.isDestroyed() && entry.snapshot.projectId === projectId) entry.win.close();
    }
    store.deleteProject(projectId);
    team.forget(projectId);
    toWindow('projects:changed', {});
    toWindow('team:changed', { projectId });
    return true;
  });

  ipcMain.handle('run:get', (_event, runId: string) => {
    const run = store.run(runId);
    return run ? { run, events: store.events(run.id) } : null;
  });
  ipcMain.handle('run:list', (_event, projectId: string) => store.listRunSummaries(projectId));
  ipcMain.handle('conversation:search', (_event, input: { sessionId: string; query: string }) =>
    store.searchSession(input.sessionId, input.query),
  );
  ipcMain.handle('conversation:turns', (_event, sessionId: string) => store.sessionRuns(sessionId)
    .map(run => ({ run, events: store.events(run.id) })));
  ipcMain.handle('conversation:transcript', (_event, sessionId: string) => store.sessionRuns(sessionId));
  ipcMain.handle('conversation:meta', (_event, projectId: string) => store.listConversationMeta(projectId));
  ipcMain.handle(
    'conversation:update',
    (
      _event,
      input: { projectId: string; sessionId: string; title?: string; pinned?: boolean; groupName?: string; archived?: boolean },
    ) => {
      const session = store.session(input.sessionId);
      if (session?.project_id !== input.projectId) throw new Error('会话不属于这个项目');
      const meta = store.updateConversationMeta(input);
      toWindow('team:changed', { projectId: input.projectId });
      return meta;
    },
  );
  ipcMain.handle('conversation:openFolder', async (_event, projectId: string) => {
    const project = store.project(projectId);
    if (!project) return { ok: false, message: '项目不存在' };
    if (!existsSync(project.workspace)) return { ok: false, message: `目录不存在：${project.workspace}` };
    const error = await shell.openPath(project.workspace);
    return error ? { ok: false, message: error } : { ok: true };
  });
  ipcMain.handle('share:export', async (_event, input: { defaultName: string; content: string }) => {
    const result = await dialog.showSaveDialog({
      title: '导出会话 Markdown',
      defaultPath: path.join(app.getPath('documents'), input.defaultName || '会话.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, input.content, 'utf8');
    return result.filePath;
  });
  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle(
    'run:start',
    (_event, input: { projectId: string; sessionId: string; prompt: string; model?: string; effort?: string }) => {
      const memberId = store.collaborationMemberId(input.sessionId);
      const sessionId = activeMemberId(memberId);
      if (store.compactionState(sessionId)?.handoff_state === 'requested') {
        throw new Error('正在确认新会话接手，请等本次接手完成');
      }
      return runner.start({ ...input, sessionId });
    },
  );

  ipcMain.handle('run:cancel', (_event, runId: string) => {
    runner.cancel(runId);
    return true;
  });

  ipcMain.handle('run:steer', (_event, input: { runId: string; text: string }) => {
    runner.steer(input.runId, input.text);
    return true;
  });

  ipcMain.handle('artifact:list', (_event, sessionId: string) => store.listArtifacts(sessionId));
  ipcMain.handle('artifact:read', (_event, filePath: string) => {
    try {
      const info = statSync(filePath);
      if (!info.isFile()) return { ok: false, message: '不是普通文件，无法预览' };
      if (info.size > 2_000_000) return { ok: false, message: '文件超过 2MB，请用系统程序打开' };
      const buffer = readFileSync(filePath);
      if (buffer.includes(0)) return { ok: false, message: '二进制文件无法文本预览，请用系统程序打开' };
      return { ok: true, text: buffer.toString('utf8') };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });

  ipcMain.handle('artifact:open', async (_event, filePath: string) => {
    if (!existsSync(filePath)) return { ok: false, message: `文件不存在：${filePath}` };
    const stat = statSync(filePath);
    if (!stat.isFile()) return { ok: false, message: `不是文件：${filePath}` };
    const error = await shell.openPath(filePath);
    return error ? { ok: false, message: error } : { ok: true };
  });

  ipcMain.handle('artifact:reveal', (_event, filePath: string) => {
    if (!existsSync(filePath)) return { ok: false, message: `文件不存在：${filePath}` };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.on('system:log', (_event, message: string) => logLine(`渲染进程：${message}`));

  registerMobileIpc(() => mobileServer);

  // ---------------------------------------------------------------- 团队频道

  ipcMain.handle('team:state', (_event, projectId: string, sessionId?: string) => {
    if (sessionId) restoreOpeningMessage(projectId, sessionId);
    return {
      project: store.project(projectId),
      members: team.members(projectId, sessionId),
      channels: store.project(projectId)?.kind === 'inbox' && !sessionId ? [] : team.channels(projectId, sessionId),
      board: team.board(projectId, sessionId),
      artifacts: team.artifacts(projectId, sessionId),
    };
  });

  ipcMain.handle('team:result-inbox', (_event, input: { projectId: string; sessionId: string; messageId?: string; offset?: number }) => {
    if (store.session(input.sessionId)?.project_id !== input.projectId) throw new Error('会话不在当前项目');
    const items = team.resultInbox(input.projectId, input.sessionId);
    if (!input.messageId) return items;
    if (!items.some(item => item.id === input.messageId)) throw new Error('信箱里没有这条结果');
    return team.readMessages(input.projectId, input.sessionId, [input.messageId], 4000, input.offset ?? 0)[0] ?? null;
  });

  ipcMain.handle('team:view', (_event, input: { projectId: string; viewer?: string; sessionId?: string; channel?: string }) =>
    store.project(input.projectId)?.kind === 'inbox' && !input.sessionId && (!input.viewer || input.viewer === OWNER)
      ? { channel: null, roots: [], replies: {} }
      : team.view(input.projectId, input.viewer ?? OWNER, input.channel, input.sessionId),
  );

  ipcMain.handle('team:channel', (_event, input: { projectId: string; sessionId?: string;
    operation: 'create' | 'invite' | 'archive' | 'restore'; name?: string; channelId?: string; memberIds?: string[] }) => {
    if (store.project(input.projectId)?.kind === 'inbox' && !input.sessionId) throw new Error('请先打开一个会话');
    const channel = team.manageChannel({ ...input, from: OWNER });
    toWindow('team:changed', { projectId: input.projectId });
    return channel;
  });

  ipcMain.handle('team:thread', (_event, input: { projectId: string; viewer?: string; sessionId?: string; rootId: string }) =>
    store.project(input.projectId)?.kind === 'inbox' && !input.sessionId && (!input.viewer || input.viewer === OWNER)
      ? undefined
      : team.thread(input.projectId, input.viewer ?? OWNER, input.rootId, input.sessionId),
  );

  ipcMain.handle('team:publicBoard', (_event, input: { projectId: string; sessionId?: string }) =>
    buildPublicBoard(store, team, input),
  );

  ipcMain.handle(
    'team:launch',
    async (
      _event,
      input: {
        projectId?: string;
        name?: string;
        workspace?: string;
        goal: string;
        leader: { label: string; host: string; model: string; effort?: string };
        members: { label: string; host: string; model: string; effort?: string; duty?: string }[];
      },
    ) => {
      const goal = String(input.goal ?? '').trim();
      if (!goal) throw new Error('团队目标不能为空');
      if (goal.length > 4000) throw new Error('团队目标过长');
      if (!input.leader?.host) throw new Error('主导者必须选择宿主');
      const members = (input.members ?? []).filter(item => item && item.host);
      if (!members.length) throw new Error('至少需要一个成员');
      if (members.length > 6) throw new Error('成员最多 6 人');

      let project = input.projectId ? store.project(input.projectId) : undefined;
      if (!project) {
        // 兜底工作区不能落在自由对话容器上，否则团队会被建进「自由对话」里。
        const workspace = input.workspace
          ? path.resolve(input.workspace)
          : store.listProjects().find(item => item.kind !== 'inbox')?.workspace;
        if (!workspace) throw new Error('先选择工作区');
        if (!existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`);
        project = store.createProject((input.name ?? '').trim() || '蜂群任务', workspace);
      }

      const leader = store.createSession({
        projectId: project.id,
        memberLabel: input.leader.label.trim() || '主导者',
        host: input.leader.host,
        model: input.leader.model,
        effort: input.leader.effort ?? '',
        title: `主导者 · ${goal.slice(0, 24)}`,
      });
      const created = members.map(member =>
        store.createSession({
          projectId: project.id,
          memberLabel: member.label.trim() || '成员',
          host: member.host,
          model: member.model,
          effort: member.effort ?? '',
          title: `${member.label.trim() || '成员'} · ${goal.slice(0, 24)}`,
          groupId: leader.group_id,
          // 团队席位挂在主导者下面：右侧成员列表按这条关系列人，左侧只留主会话。
          parentSessionId: leader.id,
        }),
      );
      team.refreshMembers(project.id);

      const roster = [
        `【团队目标】${goal}`,
        `【主导者】${leader.member_label}（${leader.host} / ${leader.model}）`,
        '【分工】',
        ...created.map((session, index) => {
          const duty = members[index].duty?.trim();
          return `- ${session.member_label}（${session.host} / ${session.model}）${duty ? `：${duty}` : ''}`;
        }),
      ].join('\n');
      const broadcast = team.post({ projectId: project.id, sessionId: leader.id, from: OWNER, to: 'all', text: roster, requiresAction: false });
      const briefingText = [
        roster,
        `【成员 ID（派工用）】${created.map(session => `${session.member_label}=${session.id}`).join('、')}`,
        '',
        '你是这个团队的主导者。成员已经创建好，不要再新建成员；直接用上面的成员 ID 给每位成员各派一件具体任务（swarm_dispatch 的 to 填成员 ID，写清产出、验收方式和相关文件），你自己同时推进主线。',
        '每完成一步用 swarm_report 报进度；交付文件用 swarm_artifact 登记真实工作区路径；在主线用 swarm_say 说明结论。',
      ].join('\n');
      const briefing = team.post({
        projectId: project.id,
        from: OWNER,
        to: leader.id,
        text: briefingText,
        requiresAction: true,
      });
      const dispatchMessageId = briefing.messageIds[0];
      toWindow('team:changed', { projectId: project.id });
      if (dispatchMessageId) {
        await dispatchToMember({ projectId: project.id, memberId: leader.id, messageId: dispatchMessageId, text: briefingText });
      }
      return {
        project,
        leader: { ...leader, taskId: team.taskOf(project.id, leader.id)?.id ?? null },
        members: created.map(session => ({ ...session, taskId: team.taskOf(project.id, session.id)?.id ?? null })),
        messageId: broadcast.messageIds[0] ?? null,
        dispatchMessageId: dispatchMessageId ?? null,
      };
    },
  );

  ipcMain.handle('team:post', (_event, input: { projectId: string; sessionId?: string; text: string; to?: string; thread?: string; channel?: string; evidence?: string[] }) => {
    if (store.project(input.projectId)?.kind === 'inbox' && !input.sessionId) throw new Error('请先打开一个会话');
    const accepted = team.post({
      projectId: input.projectId,
      sessionId: input.sessionId,
      from: OWNER,
      to: input.to ?? 'all',
      text: input.text,
      thread: input.thread,
      channel: input.channel,
      evidence: input.evidence,
      requiresAction: false,
    });
    toWindow('team:changed', { projectId: input.projectId });
    return accepted;
  });

  ipcMain.handle(
    'team:dispatch',
    async (_event, input: { projectId: string; sessionId?: string; memberId: string; text: string; thread?: string; evidence?: string[] }) => {
      if (store.project(input.projectId)?.kind === 'inbox' && !input.sessionId) throw new Error('请先打开一个会话');
      const accepted = team.post({
        projectId: input.projectId,
        sessionId: input.sessionId,
        from: OWNER,
        to: input.memberId,
        text: input.text,
        thread: input.thread,
        evidence: input.evidence,
        requiresAction: true,
      });
      toWindow('team:changed', { projectId: input.projectId });
      const messageId = accepted.messageIds[0];
      if (messageId) await dispatchToMember({ projectId: input.projectId, memberId: input.memberId, messageId, text: accepted.result });
      return accepted;
    },
  );
}

/** 派工队列：成员忙时保留任务，原回合结束后按顺序接起；同一 messageId 只对应一个回合。 */
const dispatchQueue = new DispatchQueue();
const handoffRuns = new Map<string, { from: string; to: string; decision: CompactionDecision }>();

/** 已完成接手的席位：新派工一律落到接手会话，旧会话只留历史，不重复执行也不丢单。 */
function activeMemberId(sessionId: string): string {
  let current = sessionId;
  while (true) {
    const next = store.successorOf(current);
    if (!next || next === current) return current;
    current = next;
  }
}

const memberWorkspaceModes = new Map<string, 'worktree' | 'inherit'>();
const projectActivityAt = new Map<string, number>();
let stallMonitor: StallMonitor | undefined;

function touchProjectActivity(projectId: string): void {
  if (projectId) projectActivityAt.set(projectId, Date.now());
}

async function dispatchToMember(action: {
  projectId: string;
  memberId: string;
  messageId: string;
  text: string;
  workspaceMode?: 'worktree' | 'inherit';
}): Promise<void> {
  if (!action.memberId || action.memberId === OWNER) return;
  touchProjectActivity(action.projectId);
  const memberId = store.collaborationMemberId(action.memberId);
  if (action.workspaceMode) memberWorkspaceModes.set(memberId, action.workspaceMode);
  if (team.dispatchOf(action.projectId, action.messageId)?.status === 'done') return;
  const session = store.session(memberId);
  if (session?.project_id !== action.projectId) {
    logLine(`派工失败：成员 ${memberId} 不属于项目 ${action.projectId}`);
    finishQueuedDispatch(action.projectId, action.messageId, { status: 'failed', error: `成员 ${memberId} 不属于项目` });
    toWindow('team:changed', { projectId: action.projectId });
    return;
  }
  if (dispatchQueue.add({ id: action.messageId, projectId: action.projectId, sessionId: session.id, text: action.text }) === 'duplicate') {
    logLine(`派工 ${action.messageId} 已登记，忽略重复触发`);
    return;
  }
  const activeId = activeMemberId(memberId);
  if (runner.runningSession(activeId) || store.compactionState(activeId)?.handoff_state === 'requested') {
    team.markDispatch(action.projectId, action.messageId, { status: 'queued', runId: undefined, error: undefined });
    logLine(`成员 ${session.member_label} 正忙，派工 ${action.messageId} 已排队（该成员待执行 ${dispatchQueue.pending(session.id)} 条）`);
    toWindow('team:changed', { projectId: action.projectId });
    return;
  }
  // 空闲也按队列顺序取最早的一条，避免新派工插到旧任务前面。
  await pumpQueue(session.id);
}

async function provisionDispatchMember(input: {
  projectId: string;
  from: string;
  host: string;
  model: string;
  label?: string;
  dedicated?: boolean;
  workspaceMode?: 'worktree' | 'inherit';
}): Promise<string> {
  const key = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const catalogue = await hostCatalog();
  const host = catalogue.hosts.find(item => key(item.name) === key(input.host));
  if (!host?.adapter || !host.ready) throw new Error(`宿主未就绪：${input.host}`);
  const models = catalogue.models[host.name] ?? [];
  const model = models.find(([label, id]) => key(id) === key(input.model) || key(label) === key(input.model));
  if (!model) {
    if (models.length) {
      const listing = models.map(([label, id]) => `${label}（${id}）`).join('、');
      throw new Error(`宿主 ${host.name} 没有模型「${input.model}」；可用：${listing}`);
    }
    if (host.name === 'Qoder') throw new Error('Qoder 模型清单读取失败，无法确认模型；请用 to 指定已有成员');
    if (!/^[\w.:-]+$/.test(input.model)) throw new Error('请提供宿主模型 ID');
  }
  const modelId = model?.[1] ?? input.model;
  const fromSession = store.session(input.from);
  // 非专用分片时，只在「同一条主会话派出的子席位」里复用
  if (!input.dedicated) {
    const siblings = store
      .listSessions(input.projectId)
      .filter(session => session.parent_session_id && session.parent_session_id === input.from);
    const existing = siblings.find(session => session.host === host.name && key(session.model) === key(modelId));
    if (existing) {
      store.markDispatched(existing.id);
      if (input.workspaceMode) memberWorkspaceModes.set(existing.id, input.workspaceMode);
      return existing.id;
    }
  }
  const session = store.createSession({
    projectId: input.projectId,
    memberLabel: input.label?.trim() || model?.[0] || modelId,
    host: host.name,
    model: modelId,
    effort: '',
    groupId: fromSession?.group_id,
    parentSessionId: input.from,
  });
  if (input.workspaceMode) memberWorkspaceModes.set(session.id, input.workspaceMode);
  if (input.workspaceMode !== 'inherit') {
    const project = store.project(input.projectId);
    if (project) {
      const wt = ensureMemberWorktree(project.workspace, session.id);
      if (wt.isolated) store.updateSessionWorktree(session.id, wt.path);
    }
  }
  store.markDispatched(session.id);
  team.refreshMembers(input.projectId);
  toWindow('team:changed', { projectId: input.projectId });
  return session.id;
}

function restoreDispatchQueue(): void {
  const sessions = new Set<string>();
  for (const projectId of store.busProjectIds()) {
    if (!store.project(projectId)) continue;
    for (const { dispatch, text } of team.projectBuses(projectId).flatMap(bus => bus.recoverableDispatches())) {
      if (dispatch.status === 'queued') {
        if (dispatch.owner === OWNER) continue;
        dispatchQueue.add({ id: dispatch.id, projectId, sessionId: dispatch.owner, text });
        sessions.add(dispatch.owner);
        continue;
      }
      const run = dispatch.runId ? store.run(dispatch.runId) : undefined;
      const result = team.finishDispatch(projectId, dispatch.id, {
        status: run?.status === 'done' ? 'done' : 'failed',
        runId: run?.id,
        error: run?.status === 'done' ? undefined : run?.error || '进程重启，本轮中断',
      });
      const wake = result?.wakeup;
      if (wake) {
        dispatchQueue.add({ id: wake.messageId, projectId, sessionId: wake.memberId, text: wake.text });
        sessions.add(wake.memberId);
      }
    }
  }
  for (const sessionId of sessions) void pumpQueue(sessionId);
}

/** 真正开一个回合；失败时把原始错误写进同一条派工记录，队列继续往下走。 */
async function startDispatch(id: string, session: SessionRecord): Promise<void> {
  const item = dispatchQueue.get(id);
  if (!item) return;
  if (runner.runningSession(session.id)) return;
  touchProjectActivity(item.projectId);
  const mode = memberWorkspaceModes.get(session.id);
  if (!session.worktree_path && session.parent_session_id && mode !== 'inherit') {
    const project = store.project(item.projectId);
    if (project) {
      const wt = ensureMemberWorktree(project.workspace, session.id);
      if (wt.isolated) {
        store.updateSessionWorktree(session.id, wt.path);
        session = store.session(session.id) ?? session;
      }
    }
  }
  const wakeup = team.dispatchOf(item.projectId, id)?.reason === 'dispatch_result';
  const prompt = wakeup ? `子任务${item.text.endsWith('失败。') ? '失败' : '完成'}。信箱 ${id}。` : buildDispatchPrompt(id, item.text);
  logLine(`派工 ${id} 开跑：成员 ${session.member_label}，注入 ${prompt.length} 字`);
  const runId = `R-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  dispatchQueue.assign(id, runId);
  team.markDispatch(item.projectId, id, { status: 'claimed', runId, error: undefined });
  try {
    await runner.start({ projectId: item.projectId, sessionId: session.id, prompt, runId, dispatchId: id, wakeup });
    if (dispatchQueue.get(id)?.status === 'running') {
      team.markDispatch(item.projectId, id, { status: 'running', runId, error: undefined });
    }
  } catch (error) {
    const message = (error as Error).message || '启动失败';
    dispatchQueue.settleById(id, 'failed', message);
    finishQueuedDispatch(item.projectId, id, { status: 'failed', error: message });
    logLine(`派工 ${id} 启动失败：${message}`);
  }
  toWindow('team:changed', { projectId: item.projectId });
  if (!runner.runningSession(session.id)) await pumpQueue(session.id);
}

/** 回合结束后接起该成员队列里的下一条；没有排队就什么都不做。接手后队列按接手会话执行。 */
async function pumpQueue(sessionId: string): Promise<void> {
  if (quitting) return;
  sessionId = store.collaborationMemberId(sessionId);
  const target = activeMemberId(sessionId);
  if (runner.runningSession(target) || store.compactionState(target)?.handoff_state === 'requested') return;
  const item = dispatchQueue.takeNext(sessionId);
  if (!item) return;
  if (!team.wakeupNeeded(item.projectId, item.id)) {
    dispatchQueue.settleById(item.id, 'done');
    if (team.markDispatch(item.projectId, item.id, { status: 'done' })) {
      dispatchQueue.discardSettled(item.id);
    }
    return pumpQueue(sessionId);
  }
  const session = store.session(target);
  if (session?.project_id !== item.projectId) {
    dispatchQueue.settleById(item.id, 'failed', '成员会话不存在');
    finishQueuedDispatch(item.projectId, item.id, { status: 'failed', error: '成员会话不存在' });
    toWindow('team:changed', { projectId: item.projectId });
    return pumpQueue(sessionId);
  }
  await startDispatch(item.id, session);
}

/** 接手：本轮已收尾才换会话，队列和待办原样带到新席位，失败只留可读原因。 */
function handoffMember(sessionId: string, decision: CompactionDecision): void {
  const session = store.session(sessionId);
  if (!session || runner.runningSession(sessionId)) return;
  const memberId = store.collaborationMemberId(sessionId);
  try {
    const bus = team.bus(session.project_id, memberId);
    const task = bus.taskOf(memberId);
    const result = startHandoff(store, sessionId, {
      goal: store.sessionRuns(memberId)[0]?.prompt,
      scope: decision.level === 'stage' ? '阶段性任务，收口并保留待办，等待下一阶段任务' : '长程任务',
      next: task?.next,
      evidence: task?.evidence,
      unread: bus.inbox(memberId).slice(0, 16).map(message => `信箱 ${message.id}`),
      pendingDispatches: bus.recoverableDispatches().filter(({ dispatch }) =>
        dispatch.owner === memberId && dispatch.status === 'queued').map(({ dispatch }) => `派工 ${dispatch.id}`),
    });
    if (!result.ok || !result.toSessionId || !result.brief) {
      logLine(`接手未完成：${result.error}`);
      toWindow('run:handoff', { ok: false, sessionId, error: result.error, decision });
      return;
    }
    const runId = `R-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    handoffRuns.set(runId, { from: sessionId, to: result.toSessionId, decision });
    void runner.start({
      projectId: session.project_id, sessionId: result.toSessionId, runId, handoffProbe: true,
      prompt: `${result.brief}\n本回合只接收交接。不执行任务、不写文件、不调用工具，只回复：已接手`,
    }).catch(error => onRunFinished({ runId, error: String(error) }));
  } catch (error) {
    const message = String(error);
    store.markHandoff(sessionId, 'failed', { reason: message });
    logLine(`接手异常：${message}`);
    toWindow('run:handoff', { ok: false, sessionId, error: message, decision });
  }
}

function finishQueuedDispatch(projectId: string, id: string, outcome: { status: 'done' | 'failed'; runId?: string; error?: string }): void {
  const result = team.finishDispatch(projectId, id, outcome);
  if (result?.status === outcome.status) dispatchQueue.discardSettled(id);
  const wake = result?.wakeup;
  if (wake) void dispatchToMember({ projectId, ...wake }).catch(error =>
    logLine(`续接 ${wake.messageId} 失败：${(error as Error).message}`));
}

/** 用真实运行结果更新派工状态；失败保留宿主给的原始错误。没绑定派工的回合也要接着放行该成员队列。 */
function onRunFinished(input: { runId: string; error?: string }): void {
  const handoff = handoffRuns.get(input.runId);
  if (handoff) {
    handoffRuns.delete(input.runId);
    const memberId = store.collaborationMemberId(handoff.from);
    const error = finishHandoff(store, handoff.from, input.runId, input.error);
    logLine(error ? `接手失败：${error}` : `已接手：${handoff.from} → ${handoff.to}`);
    toWindow('run:handoff', { ok: !error, sessionId: handoff.from, toSessionId: handoff.to, error, decision: handoff.decision });
    const successor = store.session(handoff.to);
    if (successor) {
      toWindow('team:changed', { projectId: successor.project_id });
      const task = team.taskOf(successor.project_id, memberId);
      if (!error && handoff.decision.level !== 'stage' && dispatchQueue.pending(memberId) === 0
        && task?.next && task.report !== 'submitted') {
        void runner.start({
          projectId: successor.project_id, sessionId: successor.id,
          prompt: '按已收到的交接和团队待办继续同一任务，从记录的下一步开始。',
        }).catch(error => logLine(`接手后继续任务失败：${String(error)}`));
        return;
      }
    }
    void pumpQueue(memberId);
    return;
  }
  const run = store.run(input.runId);
  const sessionId = run?.session_id;
  const item = dispatchQueue.settle(input.runId, input.error ? 'failed' : 'done', input.error);
  if (item) {
    finishQueuedDispatch(item.projectId, item.id, {
      status: input.error ? 'failed' : 'done',
      runId: input.runId,
      error: input.error,
    });
    logLine(`派工 ${item.id} ${input.error ? `失败：${input.error}` : '完成'}（run ${input.runId}）`);
    toWindow('team:changed', { projectId: item.projectId });
  }
  mobileServer?.notifyStateChanged();
  if (sessionId) void pumpQueue(sessionId);
}

/** 派工提示只带这一件事和回读方式，不再要求把整份上下文重新拉一遍。 */
function buildDispatchPrompt(messageId: string, text: string): string {
  return [
    `项目里有人给你派了一件需要行动的事（派工 ID / 消息 ID：${messageId}）：`,
    text,
    '',
    '需要上下文时用 swarm_context 取增量。上面就是完整派工，蜂群已经送达，请直接执行，无需为这条派工另发回执。',
    '直接交付上面要求的结果，最终回复会保存在你的成员回合。只有实际生成文件时用 swarm_artifact 登记，需要通知其他成员时才用 swarm_say。',
  ].join('\n');
}

function restoreOpeningMessage(projectId: string, sessionId: string): boolean {
  return team.ensureOpeningMessage(projectId, sessionId, sessionIds => store.firstUserTaskPrompt(projectId, sessionIds));
}

function readDispatchResult(runId: string): string | undefined {
  const run = store.run(runId);
  if (!run) return undefined;
  const artifacts = store.listArtifacts(run.session_id).filter(item => item.run_id === runId);
  return [run.reply_text, ...artifacts.map(item => `产物：${item.path}`)].filter(Boolean).join('\n');
}

async function boot(): Promise<void> {
  logLine(`启动：数据目录 ${defaultDataDir()}，宿主桥目录 ${hostsDir()}`);
  store = new SwarmStore(defaultDataDir());
  const interrupted = store.markInterrupted();

  bridge = new HostBridge(hostsDir());
  logLine('启动宿主桥…');
  await bridge.start();
  logLine(`宿主桥就绪：${bridge.pythonCommand}`);
  bridge.on('bridge-exit', code => {
    if (!quitting) {
      logLine(`宿主桥退出 code=${code}`);
      toWindow('system:bridge-down', { code });
    }
  });

  team = new TeamService({
    project: id => store.project(id),
    sessions: id => store.listSessions(id).filter(session => !store.isHandoffSuccessor(session.id)),
    load: id => store.loadBusState(id) as never,
    save: (id, snapshot) => store.saveBusState(id, snapshot as never),
    readRunResult: runId => readDispatchResult(runId),
  });
  gateway = new BusGateway(
    team,
    action => void dispatchToMember(action),
    projectId => {
      touchProjectActivity(projectId);
      toWindow('team:changed', { projectId });
    },
    provisionDispatchMember,
  );
  stallMonitor = new StallMonitor({
    enabled: store.getStallMonitorEnabled(),
    scan: () => {
      const candidates: Array<{ projectId: string; pendingCount: number; lastActivityAt: number; signature: string }> = [];
      for (const project of store.listProjects()) {
        if (project.archived || project.kind === 'inbox') continue;
        const sessions = store.listSessions(project.id).filter(s => !store.isHandoffSuccessor(s.id));
        if (!sessions.length) continue;
        const anyRunning = sessions.some(s => Boolean(runner.runningSession(activeMemberId(s.id))));
        if (anyRunning) continue;
        const pendingDispatches = team
          .projectBuses(project.id)
          .flatMap(bus => bus.recoverableDispatches())
          .filter(item => item.dispatch.status === 'queued' || item.dispatch.status === 'claimed' || item.dispatch.status === 'running');
        if (!pendingDispatches.length) continue;
        const signature = pendingDispatches.map(d => `${d.dispatch.id}:${d.dispatch.status}`).sort().join('|');
        candidates.push({
          projectId: project.id,
          pendingCount: pendingDispatches.length,
          lastActivityAt: projectActivityAt.get(project.id) ?? 0,
          signature,
        });
      }
      return candidates;
    },
    onStall: candidate => {
      try {
        team.post({
          projectId: candidate.projectId,
          from: OWNER,
          to: 'all',
          text: `【防卡死巡检】检测到当前有 ${candidate.pendingCount} 条未完结派工，但所有成员已空闲超过阈值。请检查是否有成员在相互等待或需要手动介入。`,
        });
        toWindow('team:changed', { projectId: candidate.projectId });
      } catch (error) {
        logLine(`防卡死提醒写入失败：${(error as Error).message}`);
      }
    },
  });
  await gateway.listen();
  logLine(`协作网关就绪：${gateway.url}`);

  const emit = (channel: string, payload: unknown): void => {
    if (channel === 'run:start') {
      const { run } = payload as { run: { project_id: string; session_id: string } };
      try {
        if (!store.isHandoffSuccessor(run.session_id) && restoreOpeningMessage(run.project_id, run.session_id)) {
          toWindow('team:changed', { projectId: run.project_id });
        }
      } catch (error) {
        logLine(`留言板首条写入失败：${(error as Error).message}`);
      }
    }
    toWindow(channel, payload);
    if (channel === 'run:done') onRunFinished({ runId: (payload as { runId: string }).runId });
    if (channel === 'run:error') onRunFinished({ runId: (payload as { runId: string }).runId, error: (payload as { error: string }).error });
  };
  runner = new RunManager(store, bridge, emit, {
    issue: (projectId, memberId, runId, dispatchId) => gateway.issue(projectId, memberId, runId, dispatchId),
    revoke: token => gateway.revoke(token),
    server: { command: process.execPath, args: [mcpServerPath()] },
  }, handoffMember);
  logLine(`MCP 服务脚本：${mcpServerPath()}`);
  registerIpc();

  mobileServer = new MobileGatewayServer(store, team, sessionId => Boolean(runner?.runningSession(sessionId)));
  const mobileStaticDir = path.resolve(__dirname, '../../packages/swarm-mobile/dist');
  if (existsSync(mobileStaticDir)) {
    mobileServer.setStaticAssetsDir(mobileStaticDir);
  }
  try {
    const mobileInit = await mobileServer.start();
    logLine(`移动端网关就绪：${mobileInit.url}（PIN: ${mobileInit.pin}）`);
  } catch (err) {
    logLine(`移动端网关启动失败：${(err as Error).message}`);
  }

  const smokePlan = prepareSmoke(store);
  createWindow();

  app.on('before-quit', () => {
    quitting = true;
    stallMonitor?.stop();
    bridge.stop();
    void mobileServer?.stop();
  });
  app.on('will-quit', () => {
    store.close();
  });

  if (interrupted) logLine(`上次有 ${interrupted} 个运行未收尾，已标为中断`);
  store.recoverInterruptedHandoffs();
  restoreDispatchQueue();
  logLine(`窗口已创建，数据目录 ${defaultDataDir()}`);

  if (smokePlan) {
    mainWindow?.webContents.once('did-finish-load', () => {
      logLine(`开始真实回合：${smokePlan.host} / ${smokePlan.model}`);
      runSmoke(store, runner, smokePlan, { team, dispatch: dispatchToMember }).catch(error =>
        logLine(`冒烟失败：${(error as Error).message}`),
      );
    });
  }
}

app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(boot).catch(error => {
  logLine(`启动失败：${(error as Error).stack ?? (error as Error).message}`);
  dialog.showErrorBox('蜂群启动失败', `${(error as Error).message}\n\n宿主桥目录：${hostsDir()}`);
  setTimeout(() => app.quit(), 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
