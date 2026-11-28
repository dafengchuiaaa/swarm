import './style.css';
import MarkdownIt from 'markdown-it';
import type {
  ArtifactView,
  ConversationMetaView,
  ConversationSearchHitView,
  HostCatalog,
  HostModelCatalog,
  ModelDetails,
  ProjectView,
  RecentSessionView,
  SessionView,
  TranscriptEntry,
} from '../shared/types';
import { createModelPicker } from './modelPicker';
import { createDraftStore, safeStorage } from './draftStore';
import { createQuotaPanel } from './quotaPanel';
import {
  canDetachInspector,
  findOccupiedByKey,
  inspectorKey,
  occupiedSessionIds,
  type InspectorSnapshot,
  type OccupiedInspectorItem,
} from '../shared/inspectorSync';
import {
  addCustomSeriesAvatar,
  entryAvatarUrl,
  removeCustomSeriesAvatar,
  removeSeriesAvatar,
  resolveMemberAvatar,
  selectSeriesAvatar,
} from './avatarLibrary';
import './ui-polish';

type Any = Record<string, any>;

const api = (window as unknown as { swarm: Any }).swarm;
const markdown = new MarkdownIt({ html: false, breaks: true }).disable(['image', 'autolink']);
// Model references stay text. Verified files have their own open action.
markdown.validateLink = () => true;
markdown.renderer.rules.link_open = () => '<span class="reply-reference">';
markdown.renderer.rules.link_close = () => '</span>';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const DISPATCH_HEAD = '项目里有人给你派了一件需要行动的事（派工 ID / 消息 ID：';
const DISPATCH_TAIL = '需要上下文时用 swarm_context';

/**
 * 派工提示送到宿主时是「抬头 + 正文 + 蜂群附加指令」拼成的一条 prompt。
 * 这里把三段拆开：正文给人看，附加指令必须能展开核对，不能当没发过。
 */
function parseDispatchPrompt(prompt: string): { body: string; header: string; footer: string } | null {
  if (!prompt.startsWith(DISPATCH_HEAD)) return null;
  const start = prompt.indexOf('\n') + 1;
  const tailAt = prompt.lastIndexOf(`\n\n${DISPATCH_TAIL}`);
  if (!start || tailAt <= start) return null;
  return {
    body: prompt.slice(start, tailAt).trim(),
    header: prompt.slice(0, start).trim(),
    footer: prompt.slice(tailAt + 2).trim(),
  };
}

function displayPrompt(prompt: string): string {
  return parseDispatchPrompt(prompt)?.body ?? prompt;
}

interface AvatarTarget {
  targetKey: string;
  sender?: string;
  host?: string;
  model?: string;
  label: string;
}

interface AvatarCropSession {
  img: HTMLImageElement;
  name: string;
  scale: number;
  offsetX: number;
  offsetY: number;
}

let avatarPickerTarget: AvatarTarget | null = null;
let avatarPickerAnchor: HTMLElement | null = null;
let avatarCrop: AvatarCropSession | null = null;

function applyAvatarToButton(button: HTMLButtonElement, target: AvatarTarget): void {
  const resolved = resolveMemberAvatar(target);
  const img = button.querySelector('img') ?? el('img', 'chat-avatar-img');
  img.alt = target.label;
  img.src = resolved.url;
  if (!img.parentElement) button.append(img);
  button.title = `${target.label} · ${resolved.series.label}（${resolved.active.name}）\n点击打开专属头像库`;
  button.setAttribute('aria-label', `${target.label}的头像，点击打开${resolved.series.label}头像库`);
}

function avatarButton(target: AvatarTarget): HTMLButtonElement {
  const button = el('button', 'chat-avatar');
  button.type = 'button';
  button.dataset.avatarKey = target.targetKey;
  if (target.sender) button.dataset.avatarSender = target.sender;
  if (target.host) button.dataset.avatarHost = target.host;
  if (target.model) button.dataset.avatarModel = target.model;
  button.dataset.avatarLabel = target.label;
  applyAvatarToButton(button, target);
  button.onclick = event => {
    event.stopPropagation();
    openAvatarPicker(target, button);
  };
  button.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
    openChatAvatarMenu(target, button, { x: event.clientX, y: event.clientY });
  };
  return button;
}

function openChatAvatarMenu(target: AvatarTarget, anchor: HTMLElement, at: { x: number; y: number }): void {
  closeConversationMenu();
  const { series, active, entries } = resolveMemberAvatar(target);
  const menu = el('div', 'conv-menu');
  menu.setAttribute('role', 'menu');
  const add = (label: string, run: () => void, danger = false, disabled = false) => {
    const btn = el('button', danger ? 'danger' : undefined, label);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.setAttribute('role', 'menuitem');
    btn.onclick = () => {
      closeConversationMenu();
      run();
    };
    menu.append(btn);
  };
  add('更换头像…', () => openAvatarPicker(target, anchor));
  add(
    entries.length <= 1 ? '删除当前头像（至少保留一项）' : '删除当前头像',
    () => {
      if (!removeSeriesAvatar(series.id, active.id, active.custom)) {
        toast('该系列至少保留一个头像');
        return;
      }
      refreshRenderedAvatars();
      if (avatarPickerTarget) renderAvatarPickerGrid(avatarPickerTarget);
      toast(`已从「${series.label}」删除头像：${active.name}`);
    },
    true,
    entries.length <= 1,
  );
  positionMenu(menu, at, anchor);
  armMenuDismiss(menu);
}

function openAvatarOptionMenu(
  target: AvatarTarget,
  seriesId: string,
  seriesLabel: string,
  item: { id: string; name: string; custom: boolean },
  totalCount: number,
  at: { x: number; y: number },
  anchor: HTMLElement,
): void {
  closeConversationMenu();
  const menu = el('div', 'conv-menu');
  menu.setAttribute('role', 'menu');
  const add = (label: string, run: () => void, danger = false, disabled = false) => {
    const btn = el('button', danger ? 'danger' : undefined, label);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.setAttribute('role', 'menuitem');
    btn.onclick = () => {
      closeConversationMenu();
      run();
    };
    menu.append(btn);
  };
  add('设为当前头像', () => {
    selectSeriesAvatar(seriesId, item.id);
    refreshRenderedAvatars();
    closeAvatarPicker();
    toast(`已更新「${seriesLabel}」头像：${item.name}`);
  });
  add(
    totalCount <= 1 ? '删除此头像（至少保留一项）' : '删除此头像',
    () => {
      if (!removeSeriesAvatar(seriesId, item.id, item.custom)) {
        toast('该系列至少保留一个头像');
        return;
      }
      refreshRenderedAvatars();
      renderAvatarPickerGrid(target);
      if (avatarPickerAnchor) positionAvatarPicker(avatarPickerAnchor);
      toast(`已删除头像：${item.name}`);
    },
    true,
    totalCount <= 1,
  );
  positionMenu(menu, at, anchor);
  armMenuDismiss(menu);
}

function refreshRenderedAvatars(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button.chat-avatar[data-avatar-key]')) {
    applyAvatarToButton(button, {
      targetKey: button.dataset.avatarKey ?? '',
      sender: button.dataset.avatarSender,
      host: button.dataset.avatarHost,
      model: button.dataset.avatarModel,
      label: button.dataset.avatarLabel ?? '',
    });
  }
}

function exitAvatarCrop(): void {
  avatarCrop = null;
  const cropBox = $('#avatar-crop-box');
  if (cropBox) cropBox.hidden = true;
  const grid = $('#avatar-picker-grid');
  if (grid) grid.hidden = false;
  const addBtn = $<HTMLButtonElement>('#avatar-picker-add');
  if (addBtn) addBtn.hidden = false;
}

function drawAvatarCrop(canvas: HTMLCanvasElement, session: AvatarCropSession, size = canvas.width): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const iw = session.img.naturalWidth || session.img.width;
  const ih = session.img.naturalHeight || session.img.height;
  if (!iw || !ih) return;
  const baseScale = Math.max(size / iw, size / ih);
  const drawW = iw * baseScale * session.scale;
  const drawH = ih * baseScale * session.scale;
  const maxShiftX = Math.max(0, (drawW - size) / 2);
  const maxShiftY = Math.max(0, (drawH - size) / 2);
  session.offsetX = Math.max(-maxShiftX, Math.min(maxShiftX, session.offsetX));
  session.offsetY = Math.max(-maxShiftY, Math.min(maxShiftY, session.offsetY));
  const dx = (size - drawW) / 2 + session.offsetX;
  const dy = (size - drawH) / 2 + session.offsetY;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(session.img, dx, dy, drawW, drawH);
}

function exportAvatarCropDataUrl(session: AvatarCropSession): string {
  const preview = $<HTMLCanvasElement>('#avatar-crop-canvas');
  const previewSize = preview.width || 200;
  const outSize = 512;
  const ratio = outSize / previewSize;
  const out = document.createElement('canvas');
  out.width = outSize;
  out.height = outSize;
  const scaled: AvatarCropSession = {
    img: session.img,
    name: session.name,
    scale: session.scale,
    offsetX: session.offsetX * ratio,
    offsetY: session.offsetY * ratio,
  };
  drawAvatarCrop(out, scaled, outSize);
  return out.toDataURL('image/webp', 0.94);
}

function positionAvatarPicker(anchor: HTMLElement): void {
  const picker = $('#avatar-picker');
  if (!picker || picker.hidden) return;
  const rect = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth || 356;
  const ph = picker.offsetHeight || 340;
  const left = Math.max(8, Math.min(rect.left, innerWidth - pw - 8));
  const top = rect.bottom + 8 + ph <= innerHeight - 8
    ? rect.bottom + 8
    : Math.max(8, rect.top - ph - 8);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

function closeAvatarPicker(): void {
  exitAvatarCrop();
  const picker = $('#avatar-picker');
  if (picker) picker.hidden = true;
  avatarPickerTarget = null;
  avatarPickerAnchor = null;
}

function renderAvatarPickerGrid(target: AvatarTarget): void {
  const { series, active, entries } = resolveMemberAvatar(target);
  const isOwner = series.id === 'owner';
  $('#avatar-picker-title').textContent = isOwner ? '我的头像' : `${series.label} · 专属头像库`;
  $('#avatar-picker-sub').textContent = `当前：${active.name}`;
  $('#avatar-picker-foot').textContent = isOwner
    ? '我的头像可自由自定义添加图片并切换'
    : '不同平台的同系列模型共用此专属库';

  const grid = $('#avatar-picker-grid');
  grid.replaceChildren();
  for (const item of entries) {
    const cell = el('div', 'avatar-option-wrap');
    const pick = el('button', 'avatar-option');
    pick.type = 'button';
    if (active.id === item.id) pick.classList.add('active');
    pick.title = `${item.name}（${item.tag}）\n来源：${item.credit}`;
    const thumb = el('img', 'avatar-option-img');
    thumb.src = entryAvatarUrl(item);
    thumb.alt = item.name;
    pick.append(thumb, el('span', 'avatar-option-name', item.name));
    pick.onclick = () => {
      selectSeriesAvatar(series.id, item.id);
      refreshRenderedAvatars();
      closeAvatarPicker();
      toast(`已更新「${series.label}」头像：${item.name}`);
    };
    pick.oncontextmenu = event => {
      event.preventDefault();
      event.stopPropagation();
      openAvatarOptionMenu(target, series.id, series.label, item, entries.length, { x: event.clientX, y: event.clientY }, pick);
    };
    cell.append(pick);

    if (item.custom) {
      const del = el('button', 'avatar-option-del', '×');
      del.type = 'button';
      del.title = '删除这个自定义头像';
      del.setAttribute('aria-label', `删除 ${item.name}`);
      del.onclick = event => {
        event.stopPropagation();
        removeCustomSeriesAvatar(series.id, item.id);
        refreshRenderedAvatars();
        renderAvatarPickerGrid(target);
      };
      cell.append(del);
    }
    grid.append(cell);
  }
}

function openAvatarPicker(target: AvatarTarget, anchor: HTMLElement): void {
  const picker = $('#avatar-picker');
  if (!picker) return;
  const sameSeries = avatarPickerTarget
    ? resolveMemberAvatar(avatarPickerTarget).series.id === resolveMemberAvatar(target).series.id
    : false;
  if (!picker.hidden && sameSeries && avatarPickerAnchor === anchor) {
    closeAvatarPicker();
    return;
  }
  exitAvatarCrop();
  avatarPickerTarget = target;
  avatarPickerAnchor = anchor;
  renderAvatarPickerGrid(target);
  picker.hidden = false;
  positionAvatarPicker(anchor);
}

/**
 * 用户消息气泡：右侧头像 + 名字在上方，下面紧接气泡正文；如果是派工提示，下面挂可展开的「蜂群附加指令」。
 */
function promptNode(prompt: string): HTMLElement {
  const wrap = el('div', 'turn user chat-turn');
  const col = el('div', 'chat-col');
  const meta = el('div', 'chat-meta');
  meta.append(el('span', 'who', '我'));
  const parsed = parseDispatchPrompt(prompt);
  const bubble = el('div', 'bubble', parsed ? parsed.body : prompt);
  col.append(meta, bubble);
  if (parsed) {
    const details = el('details', 'dispatch-raw');
    details.append(el('summary', '', '蜂群附加指令 · 查看实际发送的完整内容'));
    details.append(el('pre', 'dispatch-raw-body', prompt));
    const copy = el('button', 'ghost mini-btn', '复制完整内容');
    copy.type = 'button';
    copy.onclick = event => {
      event.preventDefault();
      void api.copyText(prompt).then(() => toast('已复制实际发送的完整内容'));
    };
    details.append(copy);
    col.append(details);
  }
  const avatar = avatarButton({ targetKey: 'owner', sender: 'owner', label: '我' });
  wrap.append(col, avatar);
  return wrap;
}

function renderReply(body: HTMLElement, text: string): void {
  body.innerHTML = markdown.render(text);
  body.classList.add('markdown');
}

interface TaskView {
  id: string;
  report: 'none' | 'in_progress' | 'submitted' | 'blocked' | 'done';
  acceptance: 'pending' | 'accepted' | 'rejected';
  version: number;
  next: string;
  blocker: string;
  evidence: string[];
}

interface MemberView {
  id: string;
  label: string;
  task: TaskView | null;
  unread: number;
  resultUnread?: number;
  channel: string;
  host?: string;
  model?: string;
  host_session_id?: string | null;
}

interface ChannelView {
  id: string;
  name: string;
  kind: 'channel' | 'dm';
  memberId?: string;
  memberIds?: string[];
  archived?: boolean;
  main?: boolean;
}

interface DecodedMessage {
  id: string;
  sender: string;
  senderLabel: string;
  to: string;
  toLabel: string;
  text: string;
  time: string;
  kind: string;
  evidence: string[];
  artifactIds: string[];
  requiresAction: boolean;
  receipts: Record<string, string>;
  threadId?: string;
  dispatch?: { id: string; status: string; error?: string; runId?: string };
}

interface TeamState {
  project: ProjectView;
  members: MemberView[];
  channels: ChannelView[];
  board: Record<string, { value: string; version: number; updated: string }>;
  artifacts: (Any & { id: string; name: string; owner: string; memberLabel: string; absolutePath?: string })[];
}

interface LiveTurn {
  root: HTMLElement;
  thinking: HTMLDetailsElement;
  thinkingLabel: HTMLElement;
  thinkingBody: HTMLElement;
  thinkingText: string;
  usageData: Record<string, number>;
  progress: HTMLElement;
  activity: HTMLDetailsElement;
  body: HTMLElement;
  status: HTMLElement;
  usage: HTMLElement;
  artifacts: HTMLElement;
}

interface RunSummary {
  id: string;
  session_id: string;
  status: TranscriptEntry['run']['status'];
  prompt: string;
  started_at: string;
}

const state: {
  catalog: HostCatalog | null;
  projects: ProjectView[];
  project: ProjectView | null;
  sessions: SessionView[];
  team: TeamState | null;
  channel: ChannelView | null;
  roots: DecodedMessage[];
  replies: Record<string, DecodedMessage[]>;
  thread: { root: DecodedMessage; replies: DecodedMessage[] } | null;
  threadRootId: string | null;
  runSession: SessionView | null;
  artifacts: ArtifactView[];
  live: Map<string, LiveTurn>;
  running: string | null;
  runs: RunSummary[];
  selectedRun: string | null;
  view: 'task' | 'team';
  showResults: boolean | null;
  inspectorOpen: boolean;
  occupiedInspectors: OccupiedInspectorItem[];
  inspMode: 'files' | 'preview' | 'session' | 'thread';
  inspectorSession: SessionView | null;
  inspArtifacts: ArtifactView[];
  inspRunning: string | null;
  preview: { path: string; name: string } | null;
  boardFirst: string | null;
  boardRoots: { at: number; line: string }[];
  conversations: Record<string, ConversationMetaView>;
  archivedVisible: boolean;
  projectsArchivedVisible: boolean;
  detachedSessions: Set<string>;
  expandedThreads: Set<string>;
  threadDrafts: Record<string, string>;
  openReplyRoot: string | null;
  search: { query: string; hits: ConversationSearchHitView[]; index: number } | null;
  share: { session: SessionView; runs: TranscriptEntry['run'][] } | null;
  expandedProjects: Set<string>;
  projectSessions: Record<string, SessionView[]>;
  /** 自由对话容器：会话归属上仍需要它，界面上不再单独暴露。 */
  inbox: ProjectView | null;
  /** 「最近」：跨项目的时间线，侧栏只有这一条列表。 */
  recent: RecentSessionView[];
  railQuery: string;
  navStack: { projectId: string; sessionId: string | null }[];
  navIndex: number;
} = {
  catalog: null,
  projects: [],
  project: null,
  sessions: [],
  team: null,
  channel: null,
  roots: [],
  replies: {},
  thread: null,
  threadRootId: null,
  runSession: null,
  artifacts: [],
  live: new Map(),
  running: null,
  runs: [],
  selectedRun: null,
  view: 'task',
  showResults: null,
  inspectorOpen: false,
  occupiedInspectors: [],
  inspMode: 'files',
  inspectorSession: null,
  inspArtifacts: [],
  inspRunning: null,
  preview: null,
  boardFirst: null,
  boardRoots: [],
  conversations: {},
  archivedVisible: false,
  projectsArchivedVisible: false,
  detachedSessions: new Set(),
  expandedThreads: new Set(),
  threadDrafts: {},
  openReplyRoot: null,
  search: null,
  share: null,
  expandedProjects: new Set(),
  projectSessions: {},
  inbox: null,
  recent: [],
  railQuery: '',
  navStack: [],
  navIndex: -1,
};

let refreshTimer: number | null = null;
let transcriptRequest = 0;
let searchTimer: number | null = null;
let convMenu: HTMLElement | null = null;
// 草稿落盘：重启后按会话恢复；存储不可用时自动降级为内存。
const draftStorage = safeStorage(typeof localStorage !== 'undefined' ? localStorage : null);
const drafts = createDraftStore(draftStorage);
const HOME_DRAFT_KEY = 'swarm.draft.home';
let homeDraftTimer: number | null = null;

function saveHomeDraft(): void {
  const text = $<HTMLTextAreaElement>('#home-prompt').value;
  try {
    if (text) draftStorage.setItem(HOME_DRAFT_KEY, text);
    else draftStorage.removeItem(HOME_DRAFT_KEY);
  } catch {
    // 存储失败不影响输入
  }
}

function scheduleHomeDraft(): void {
  if (homeDraftTimer) window.clearTimeout(homeDraftTimer);
  homeDraftTimer = window.setTimeout(() => {
    homeDraftTimer = null;
    saveHomeDraft();
  }, 300);
}

const quotaPanel = createQuotaPanel(
  $('.quota-rail'), $('#quota-list'), $('#side-foot'), $<HTMLButtonElement>('#quota-refresh'),
  () => state.catalog, () => api.quotas(),
);
const nativeModelCatalogs: Partial<Record<string, HostModelCatalog>> = {};

function updateNativeModels(host: string, catalog: HostModelCatalog): void {
  nativeModelCatalogs[host] = catalog;
  if ($<HTMLSelectElement>('#home-host').value === host) syncHomeModels();
  if (!$('#member-dialog').hidden && $<HTMLSelectElement>('#member-host').value === host) syncMemberModels();
  if (!$('#team-dialog').hidden) {
    if ($<HTMLSelectElement>('#team-leader-host').value === host) syncTeamLeaderModels();
    for (const row of $('#team-member-rows').querySelectorAll<HTMLElement>('.team-member-row')) {
      const rowHost = row.querySelector('.team-member-host') as HTMLSelectElement;
      const rowModel = row.querySelector('.team-member-model') as HTMLSelectElement;
      if (rowHost.value === host) fillModelSelect(rowModel, host, rowModel.value);
    }
  }
  if (state.runSession?.host === host) {
    const model = $<HTMLSelectElement>('#model-select');
    const effort = $<HTMLSelectElement>('#effort-select');
    fillModelSelect(model, host, model.value || state.runSession.model, state.runSession.model);
    syncEffort(host, model.value, effort.disabled ? preferredEffort(host, state.runSession) : effort.value);
  }
}

async function refreshNativeModels(): Promise<void> {
  const host = state.catalog?.hosts.find(item => item.ready && item.nativeModelCatalog);
  if (!host) return;
  const catalog = await api.codeBuddyModels().catch(() => null);
  if (catalog) updateNativeModels(host.name, catalog);
}

function toast(message: string): void {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  window.setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

// ---------------------------------------------------------------- 侧栏

let dragSessionId: string | null = null;
let navApplying = false;

function ageLabel(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function sessionSearchText(session: SessionView): string {
  return `${session.member_label} ${session.host} ${session.model}`.toLowerCase();
}

function nestTitle(session: SessionView): string {
  return conversationTitle(session);
}

/** 自由对话容器混在项目列表数据里，但渲染时要摘出去：它不是用户的项目。 */
function pickInbox(): void {
  state.inbox = state.projects.find(project => project.kind === 'inbox') ?? null;
}

/** 跨项目会话的兜底标题：最近一次提问的第一行，随「最近」一起取回。 */
const recentTitles = new Map<string, string>();

/** 把「最近」行里的整理状态并进会话表，改名/置顶/归档在各项目同一份数据。 */
function adoptRecent(rows: RecentSessionView[]): void {
  state.recent = rows;
  for (const row of rows) {
    recentTitles.set(row.id, firstLine(row.last_prompt ?? ''));
    if (state.conversations[row.id]) continue;
    state.conversations[row.id] = {
      session_id: row.id,
      project_id: row.project_id,
      title: row.meta_title,
      pinned: row.pinned,
      group_name: '',
      archived: row.archived,
      updated_at: row.updated_at,
    };
  }
}

/** 「最近」的时间线：一次跨项目捞回来，切项目不需要重拉，列表本身也不随项目变化。 */
async function refreshRecent(): Promise<void> {
  pickInbox();
  try {
    adoptRecent((await api.recentSessions()) as RecentSessionView[]);
  } catch {
    state.recent = [];
  }
}

async function ensureProjectSessions(projectId: string): Promise<void> {
  if (projectId === state.project?.id) {
    state.projectSessions[projectId] = state.sessions;
    return;
  }
  if (state.projectSessions[projectId]) return;
  const [sessions, meta] = await Promise.all([
    api.listSessions(projectId),
    api.conversationMeta(projectId).catch(() => [] as ConversationMetaView[]),
  ]);
  state.projectSessions[projectId] = sessions;
  for (const item of meta as ConversationMetaView[]) {
    if (!state.conversations[item.session_id]) state.conversations[item.session_id] = item;
  }
  renderProjects();
}

function toggleProjectExpand(project: ProjectView): void {
  if (state.expandedProjects.has(project.id)) state.expandedProjects.delete(project.id);
  else {
    state.expandedProjects.add(project.id);
    void ensureProjectSessions(project.id);
  }
  renderProjects();
}

function pushNav(projectId: string, sessionId: string | null): void {
  if (navApplying) return;
  const current = state.navStack[state.navIndex];
  if (current && current.projectId === projectId && current.sessionId === sessionId) return;
  state.navStack = state.navStack.slice(0, state.navIndex + 1);
  state.navStack.push({ projectId, sessionId });
  if (state.navStack.length > 60) state.navStack.shift();
  state.navIndex = state.navStack.length - 1;
  renderNavButtons();
}

function renderNavButtons(): void {
  $<HTMLButtonElement>('#nav-back').disabled = state.navIndex <= 0;
  $<HTMLButtonElement>('#nav-forward').disabled = state.navIndex >= state.navStack.length - 1;
}

async function applyNav(index: number): Promise<void> {
  const entry = state.navStack[index];
  if (!entry || navApplying) return;
  state.navIndex = index;
  renderNavButtons();
  navApplying = true;
  try {
    if (state.project?.id !== entry.projectId) {
      const project = state.projects.find(item => item.id === entry.projectId);
      if (!project) return;
      await selectProject(project);
    }
    if (entry.sessionId) {
      const session = state.sessions.find(item => item.id === entry.sessionId);
      if (session) await openRuns(session.id, roundsOf(session.id).at(-1)?.id ?? null);
    } else {
      showWelcome();
    }
  } finally {
    navApplying = false;
  }
}

function renderProjects(): void {
  // 每次重画都先对齐自由对话容器：它藏在 projects 数据里，但不作为项目显示。
  pickInbox();
  const list = $('#project-list');
  list.replaceChildren();
  const query = state.railQuery.trim().toLowerCase();
  const visible = state.projects.filter(
    project => project.kind !== 'inbox' && (state.projectsArchivedVisible || !project.archived),
  );
  let shown = 0;
  for (const project of visible) {
    const nest = project.id === state.project?.id ? state.sessions : (state.projectSessions[project.id] ?? null);
    const matchesProject = !query || project.name.toLowerCase().includes(query);
    const matchingSessions = query && nest ? nest.filter(session => sessionSearchText(session).includes(query) || nestTitle(session).toLowerCase().includes(query)) : [];
    if (query && !matchesProject && !matchingSessions.length) continue;
    shown += 1;
    const expanded = state.expandedProjects.has(project.id) || Boolean(query && matchingSessions.length);
    const item = el('li', 'proj-item');
    const row = el('div', 'proj-row');
    if (state.project?.id === project.id) row.classList.add('active');
    if (project.archived) row.classList.add('archived');
    const chevron = el('button', 'proj-chevron');
    chevron.type = 'button';
    chevron.title = expanded ? '收起' : '展开';
    chevron.setAttribute('aria-label', `${expanded ? '收起' : '展开'}项目：${project.name}`);
    chevron.setAttribute('aria-expanded', String(expanded));
    chevron.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
    chevron.onclick = event => {
      event.stopPropagation();
      toggleProjectExpand(project);
    };
    const folder = el('span', 'proj-folder');
    folder.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v7H2Z"/></svg>';
    const name = el('span', 'proj-name', project.name);
    const more = el('button', 'conv-more project-more', '⋯');
    more.type = 'button';
    more.title = '项目操作';
    more.setAttribute('aria-label', `项目操作：${project.name}`);
    more.onclick = event => {
      event.stopPropagation();
      openProjectMenu(project, undefined, more);
    };
    row.append(chevron, folder, name, more);
    row.title = `${project.name}\n${project.workspace}`;
    row.onclick = () => {
      state.expandedProjects.add(project.id);
      void ensureProjectSessions(project.id);
      void selectProject(project);
    };
    row.oncontextmenu = event => {
      event.preventDefault();
      openProjectMenu(project, { x: event.clientX, y: event.clientY });
    };
    row.ondragover = event => {
      if (!dragSessionId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = event => {
      event.preventDefault();
      row.classList.remove('drop-target');
      const sessionId = event.dataTransfer?.getData('application/x-swarm-session') || dragSessionId;
      dragSessionId = null;
      if (sessionId) void moveSessionTo(sessionId, project);
    };
    item.append(row);
    if (expanded) {
      const nestList = el('ul', 'proj-nest');
      const sessions = (nest ?? []).filter(session =>
        // 项目折叠里同样只列主会话，子成员归到主会话的成员区。
        !session.parent_session_id
        && (state.archivedVisible || !state.conversations[session.id]?.archived)
        && (!query || matchesProject || matchingSessions.includes(session)));
      for (const session of sessions) nestList.append(nestRow(session));
      if (!sessions.length) nestList.append(el('li', 'nest-empty', nest ? '还没有会话' : '加载中…'));
      item.append(nestList);
      if (!nest) void ensureProjectSessions(project.id);
    }
    list.append(item);
  }
  if (!shown) {
    const hasProjects = state.projects.some(project => project.kind !== 'inbox');
    list.append(el('li', 'side-empty', query ? '没有匹配的项目' : hasProjects ? '没有未归档项目' : '点 + 接入一个目录'));
  }
}

function nestRow(session: SessionView): HTMLElement {
  const item = el('li', 'nest-row');
  if (state.runSession?.id === session.id) item.classList.add('active');
  const latest = roundsOf(session.id).at(-1);
  if (latest?.status === 'running') item.append(el('span', 'task-dot running'));
  const title = el('span', 'nest-title', nestTitle(session));
  const age = el('span', 'nest-age', ageLabel(session.updated_at));
  item.append(title, age);
  item.title = `${nestTitle(session)}\n${session.member_label} · ${session.host}\n右键查看操作；拖动松手即拆为独立窗口，拖到项目行可移动`;
  item.onclick = () => void openConversation(session);
  item.oncontextmenu = event => {
    event.preventDefault();
    openConversationMenu(session, { x: event.clientX, y: event.clientY });
  };
  item.draggable = true;
  item.ondragstart = event => {
    dragSessionId = session.id;
    if (event.dataTransfer) {
      event.dataTransfer.setData('application/x-swarm-session', session.id);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setDragImage(showDragCard(nestTitle(session), `${session.member_label} · 松手拆为独立窗口`), 24, 20);
    }
    item.classList.add('dragging');
  };
  item.ondragend = event => {
    item.classList.remove('dragging');
    clearDragCard();
    const consumed = dragSessionId === null;
    dragSessionId = null;
    if (!consumed) maybeDetachOnDragEnd(event, session);
  };
  return item;
}

const REPORT_LABEL: Record<string, string> = {
  none: '待接',
  in_progress: '在跑',
  submitted: '已交',
  blocked: '阻塞',
  done: '完成',
};

function renderSidebar(): void {
  renderChannelBar();
  renderConversations();
  renderRoundNav();
  renderNavButtons();
  renderInspectorMembers();
  renderResultInboxButton();
}

function renderResultInboxButton(): void {
  const button = $('#result-inbox-open');
  const member = state.team?.members.find(item => item.id === state.runSession?.id);
  button.hidden = state.view !== 'task' || !state.runSession;
  button.textContent = member?.resultUnread ? `信箱 · ${member.resultUnread}` : '信箱';
}

let resultInboxScope: { projectId: string; sessionId: string } | null = null;
let resultInboxSelection: { id: string; offset: number | null } | null = null;

async function loadResultInbox(): Promise<void> {
  const scope = resultInboxScope;
  if (!scope) return;
  const items = await api.resultInbox(scope) as { id: string; text: string; processed: boolean }[];
  if (resultInboxScope !== scope) return;
  const list = $('#result-inbox-list');
  list.replaceChildren();
  if (!items.length) list.append(el('span', 'muted', '暂无子任务结果'));
  for (const item of items) {
    const button = el('button', 'ghost', item.processed ? item.text : `待处理 · ${item.text}`);
    button.type = 'button';
    button.onclick = () => {
      resultInboxSelection = { id: item.id, offset: 0 };
      void readResultInbox();
    };
    list.append(button);
  }
}

async function readResultInbox(): Promise<void> {
  const scope = resultInboxScope;
  const selected = resultInboxSelection;
  const more = $<HTMLButtonElement>('#result-inbox-more');
  if (!scope || !selected || selected.offset === null || more.disabled) return;
  more.disabled = true;
  try {
    const result: { text: string; next_offset: number | null } | null =
      await api.resultInbox({ ...scope, messageId: selected.id, offset: selected.offset });
    if (!result || resultInboxScope !== scope || resultInboxSelection !== selected) return;
    const body = $('#result-inbox-body');
    body.hidden = false;
    body.textContent = (selected.offset === 0 ? '' : body.textContent ?? '') + result.text;
    selected.offset = result.next_offset;
    more.hidden = selected.offset === null;
  } catch (error) {
    toast((error as Error).message);
  } finally {
    more.disabled = false;
  }
}

function openResultInbox(): void {
  const session = state.runSession;
  if (!session) return;
  resultInboxScope = { projectId: session.project_id, sessionId: session.id };
  resultInboxSelection = null;
  $('#result-inbox-title').textContent = `${session.member_label} · 子任务信箱`;
  $('#result-inbox-list').replaceChildren();
  $('#result-inbox-body').hidden = true;
  $('#result-inbox-more').hidden = true;
  $('#result-inbox-dialog').hidden = false;
  void loadResultInbox().catch(error => toast((error as Error).message));
}

let showArchivedChannels = false;
let channelDialog: { projectId: string; sessionId?: string; channel?: ChannelView } | null = null;
let composerChannelId: string | undefined;
const channelDrafts = new Map<string, string>();

function renderChannelBar(): void {
  const chips = $('#channel-chips');
  chips.replaceChildren();
  const topic = state.channel?.kind === 'channel' && !state.channel.main ? state.channel : undefined;
  $('#channel-new').hidden = !state.team?.channels.length;
  $('#channel-invite').hidden = !topic || Boolean(topic.archived);
  $('#channel-archive').hidden = !topic;
  $('#channel-archive').textContent = topic?.archived ? '恢复频道' : '归档频道';
  const add = $('#add-member');
  add.hidden = Boolean(topic?.archived);
  add.title = topic ? '新建宿主成员并加入当前频道' : '添加成员';
  add.setAttribute('aria-label', add.title);
  $('#channel-archived').hidden = !state.team?.channels.some(channel => channel.archived);
  $('#channel-archived').setAttribute('aria-pressed', String(showArchivedChannels));
  $('#channel-archived').textContent = showArchivedChannels ? '隐藏已归档' : '已归档';
  if (!state.team) return;
  for (const channel of state.team.channels) {
    if (channel.archived && !showArchivedChannels && channel.id !== state.channel?.id) continue;
    const chip = el('button', 'channel-chip');
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(state.channel?.id === channel.id));
    if (state.channel?.id === channel.id) chip.classList.add('active');
    const member = channel.memberId ? state.team.members.find(entry => entry.id === channel.memberId) : null;
    chip.append(el('span', 'channel-chip-name', channel.kind === 'dm' ? channel.name
      : `# ${channel.name}${channel.archived ? ' · 已归档' : ''}`));
    if (member) {
      const report = member.task?.report;
      chip.title = `${channel.name} · ${report ? REPORT_LABEL[report] ?? report : '待接'}${member.unread ? ` · ${member.unread} 条未读` : ''}`;
      if (member.unread) chip.append(el('span', 'chip-count', String(member.unread)));
    }
    chip.onclick = () => void selectChannel(channel);
    chips.append(chip);
  }
}

function openChannelDialog(channel?: ChannelView): void {
  if (!state.project || !state.team?.channels.length) return;
  channelDialog = { projectId: state.project.id, sessionId: boardSessionId(), channel };
  $('#channel-dialog-title').textContent = channel ? `加成员 · ${channel.name}` : '新建频道';
  $('#channel-name-field').hidden = Boolean(channel);
  const name = $<HTMLInputElement>('#channel-name');
  name.value = '';
  name.required = !channel;
  $('#channel-save').textContent = channel ? '加入频道' : '创建频道';
  $('#channel-dialog-error').textContent = '';
  const list = $('#channel-members');
  list.replaceChildren(el('legend', '', '选择成员'));
  const members = state.team.members.filter(member => member.id !== 'owner' && !channel?.memberIds?.includes(member.id));
  for (const member of members) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.value = member.id;
    label.append(input, document.createTextNode(member.label));
    list.append(label);
  }
  if (!members.length) list.append(el('span', 'muted', '暂无可加入的成员'));
  $('#channel-dialog').hidden = false;
  if (channel) list.querySelector('input')?.focus();
  else name.focus();
}

async function saveChannel(): Promise<void> {
  const dialog = channelDialog;
  if (!dialog) return;
  const button = $<HTMLButtonElement>('#channel-save');
  const memberIds = [...document.querySelectorAll<HTMLInputElement>('#channel-members input:checked')].map(input => input.value);
  if (button.disabled || (dialog.channel && !memberIds.length)) return;
  button.disabled = true;
  try {
    const created = await api.teamChannel({ projectId: dialog.projectId, sessionId: dialog.sessionId,
      operation: dialog.channel ? 'invite' : 'create', channelId: dialog.channel?.id, memberIds,
      name: $<HTMLInputElement>('#channel-name').value }) as { id: string };
    $('#channel-dialog').hidden = true;
    channelDialog = null;
    if (state.project?.id !== dialog.projectId || boardSessionId() !== dialog.sessionId) return;
    await loadTeam();
    const selected = state.team?.channels.find(item => item.id === created.id);
    if (selected) await selectChannel(selected, { skipState: true });
  } catch (error) {
    $('#channel-dialog-error').textContent = (error as Error).message;
  } finally {
    button.disabled = false;
  }
}

async function toggleChannelArchive(): Promise<void> {
  const channel = state.channel;
  const projectId = state.project?.id;
  const sessionId = boardSessionId();
  if (!projectId || !channel || channel.kind !== 'channel' || channel.main) return;
  try {
    await api.teamChannel({ projectId, sessionId, channelId: channel.id, operation: channel.archived ? 'restore' : 'archive' });
    if (state.project?.id !== projectId || boardSessionId() !== sessionId) return;
    await loadTeam();
    const selected = state.team?.channels.find(item => channel.archived ? item.id === channel.id : item.main);
    if (selected) await selectChannel(selected, { skipState: true });
  } catch (error) {
    toast((error as Error).message);
  }
}

const RUN_LABEL: Record<string, string> = { running: '执行中', done: '已完成', failed: '失败', cancelled: '已停止' };

/** 一条会话 = 一个成员会话里的全部回合；整理状态只写 conversation_meta，不动成员与宿主续接。 */
function roundsOf(sessionId: string): RunSummary[] {
  return state.runs.filter(run => run.session_id === sessionId).slice().reverse();
}

function firstLine(prompt: string): string {
  return displayPrompt(prompt).split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 90) ?? '';
}

function conversationTitle(session: SessionView): string {
  const meta = state.conversations[session.id];
  if (meta?.title.trim()) return meta.title.trim();
  // 留言板里属于这条会话的主任务首句，作为会话概要名称（仅限当前项目，避免串台）。
  if (session.project_id === state.project?.id) {
    const boardLine = boardLineFor(session);
    if (boardLine) return boardLine;
  }
  const latest = roundsOf(session.id).at(-1);
  // 没标题、没回合的会话就叫「新对话」，不拿成员名/宿主名顶上去。
  return (latest ? firstLine(latest.prompt) : '')
    || recentTitles.get(session.id)
    || (session.title ?? '').trim()
    || '新对话';
}

/** 会话首回合开跑前后 15 秒内发布的留言板主任务，即这条会话的概要；无回合的新成员挂当前主任务。 */
function boardLineFor(session: SessionView): string | null {
  if (!state.boardRoots.length) return null;
  if (state.project?.kind === 'inbox') {
    const anchor = state.sessions.find(item => item.id === boardSessionId());
    if (!anchor || (session.id !== anchor.id && (anchor.group_id === state.project.id
      || !anchor.group_id || session.group_id !== anchor.group_id))) return null;
  }
  const earliest = roundsOf(session.id)[0];
  if (!earliest) return state.boardRoots.at(-1)?.line ?? null;
  const deadline = Date.parse(earliest.started_at) + 15_000;
  for (let index = state.boardRoots.length - 1; index >= 0; index -= 1) {
    if (state.boardRoots[index].at <= deadline) return state.boardRoots[index].line;
  }
  return null;
}

function conversationStatus(rounds: RunSummary[]): string {
  const latest = rounds.at(-1);
  if (!latest) return '还没有回合';
  if (latest.status === 'running') return '执行中';
  return `${rounds.length} 回合 · ${RUN_LABEL[latest.status] ?? latest.status}`;
}

async function openConversation(session: SessionView): Promise<void> {
  if (state.detachedSessions.has(session.id)) {
    void api.detachSession({ projectId: session.project_id, sessionId: session.id });
    return;
  }
  pushNav(session.project_id, session.id);
  if (state.project?.id !== session.project_id) {
    const project = state.projects.find(item => item.id === session.project_id);
    if (!project) return;
    // 跨项目跳转只记一条会话级导航，避免 selectProject 再压入项目级重复条目。
    navApplying = true;
    try {
      await selectProject(project);
    } finally {
      navApplying = false;
    }
    if (state.project?.id !== session.project_id) return;
  }
  const rounds = roundsOf(session.id);
  if (state.runSession?.id !== session.id) closeSearch();
  void openRuns(session.id, rounds.at(-1)?.id ?? null);
}

/** 置顶/归档以最新一次整理结果为准，列表数据是快照。 */
const pinnedOf = (session: RecentSessionView): boolean =>
  Boolean(state.conversations[session.id]?.pinned ?? session.pinned);
const archivedOf = (session: RecentSessionView): boolean =>
  Boolean(state.conversations[session.id]?.archived ?? session.archived);

function renderConversations(): void {
  renderProjects();
  const list = $('#task-list');
  list.replaceChildren();
  const query = state.railQuery.trim().toLowerCase();
  const isRunning = (sessionId: string) => state.runs.some(run => run.session_id === sessionId && run.status === 'running');
  // 一条时间线：所有项目的会话混在一起，按「在跑 > 置顶 > 更新时间」排，不分组不带标签。
  const rank = (session: RecentSessionView) =>
    isRunning(session.id) ? 0 : pinnedOf(session) ? 1 : archivedOf(session) ? 3 : 2;
  const entries = state.recent.filter(session => {
    // 子成员会话挂在主会话下面，不在左侧当同级会话平铺。
    if (session.parent_session_id) return false;
    if (!state.archivedVisible && archivedOf(session)) return false;
    if (!query) return true;
    return conversationTitle(session).toLowerCase().includes(query)
      || sessionSearchText(session).includes(query)
      || session.project_name.toLowerCase().includes(query);
  });
  entries.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const active = state.view === 'task' ? state.runSession?.id : null;
  for (const session of entries) list.append(historyRow(session, session.id === active));
  if (!entries.length) list.append(el('li', 'side-empty', query ? '没有匹配的对话' : '还没有对话'));
}

function historyRow(session: RecentSessionView, active: boolean): HTMLElement {
  const item = el('li', active ? 'hist-row active' : 'hist-row');
  if (archivedOf(session)) item.classList.add('archived');
  const rounds = roundsOf(session.id);
  const latest = rounds.at(-1);
  item.append(el('span', `task-dot ${latest?.status ?? ''}`));
  item.append(el('span', 'hist-title', conversationTitle(session)));
  if (pinnedOf(session)) {
    const pin = el('span', 'hist-pin');
    pin.title = '已置顶';
    pin.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5l4 4-2 .5-2.5 2.5.5 3-1.5 1.5-2.5-2.5L3 14l-.5-.5 2.5-2.5L2.5 8.5 4 7l3 .5L9.5 5Z"/></svg>';
    item.append(pin);
  }
  if (state.detachedSessions.has(session.id)) {
    const out = el('span', 'hist-pin');
    out.title = '已拆出独立窗口';
    out.innerHTML = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2.5h4.5V7M13 3L7.5 8.5"/></svg>';
    item.append(out);
  }
  item.append(el('span', 'hist-age', ageLabel(session.updated_at)));
  const more = el('button', 'conv-more', '⋯');
  more.type = 'button';
  more.title = '会话操作';
  more.setAttribute('aria-label', `会话操作：${conversationTitle(session)}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.onclick = event => {
    event.stopPropagation();
    openConversationMenu(session, undefined, more);
  };
  item.append(more);
  item.title = `${conversationTitle(session)}\n${session.project_name}${rounds.length ? ` · ${conversationStatus(rounds)}` : ''}\n右键或 ⋯ 查看操作；拖动松手即拆为独立窗口，拖到项目行可移动`;
  item.onclick = () => void openConversation(session);
  item.oncontextmenu = event => {
    event.preventDefault();
    openConversationMenu(session, { x: event.clientX, y: event.clientY });
  };
  item.draggable = true;
  item.ondragstart = event => {
    dragSessionId = session.id;
    if (event.dataTransfer) {
      event.dataTransfer.setData('application/x-swarm-session', session.id);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setDragImage(showDragCard(conversationTitle(session), `${session.member_label} · 松手拆为独立窗口`), 24, 20);
    }
    item.classList.add('dragging');
  };
  item.ondragend = event => {
    item.classList.remove('dragging');
    clearDragCard();
    const consumed = dragSessionId === null;
    dragSessionId = null;
    if (!consumed) maybeDetachOnDragEnd(event, session);
  };
  return item;
}

let dragCard: HTMLElement | null = null;

/** 跟手的拖拽小卡：系统默认截图太糙，卡片直接说明松手会发生什么。 */
function showDragCard(title: string, sub: string): HTMLElement {
  dragCard?.remove();
  const card = el('div', 'drag-card');
  card.append(el('div', 'drag-card-title', title), el('div', 'drag-card-sub', sub));
  document.body.append(card);
  dragCard = card;
  return card;
}

function clearDragCard(): void {
  dragCard?.remove();
  dragCard = null;
}

/** 松手即拆：落回左侧栏/成员弹层视为取消；落在项目行上已被 drop 消费为移动。 */
function maybeDetachOnDragEnd(event: DragEvent, session: SessionView): void {
  if (!state.project || SESSION_WINDOW) return;
  // Esc 取消拖拽时 Chromium 以 (0,0) 坐标派发 dragend，不当成松手。
  if (event.dataTransfer?.dropEffect === 'none' && event.screenX === 0 && event.screenY === 0) return;
  void (async () => {
    // 真实系统拖拽的松手坐标可能被外部放置目标改写，以主进程读到的 OS 光标为准。
    const point = await api.cursorClientPoint().catch(() => null);
    const target = document.elementFromPoint(point?.x ?? event.clientX, point?.y ?? event.clientY);
    if (target?.closest('.sidebar, .session-pop, #restore-sidebar')) return;
    await detachSession(session);
  })();
}

async function detachSession(session: SessionView): Promise<void> {
  if (!state.project) return;
  try {
    await api.detachSession({ projectId: session.project_id, sessionId: session.id });
    state.detachedSessions.add(session.id);
    if (state.runSession?.id === session.id) showHome();
    renderConversations();
    renderSessionPopIfOpen();
    renderInspectorMembers();
    toast(`已拆出独立窗口：${conversationTitle(session)}`);
  } catch (error) {
    toast((error as Error).message);
  }
}

async function moveSessionTo(sessionId: string, project: ProjectView): Promise<void> {
  const session = state.sessions.find(item => item.id === sessionId)
    ?? Object.values(state.projectSessions).flat().find(item => item.id === sessionId);
  if (!session || session.project_id === project.id) return;
  try {
    await api.moveSession({ sessionId, projectId: project.id });
    toast(`已移动到「${project.name}」：${conversationTitle(session)}`);
    const sourceId = session.project_id;
    delete state.projectSessions[sourceId];
    delete state.projectSessions[project.id];
    if (state.expandedProjects.has(project.id)) void ensureProjectSessions(project.id);
    if (sourceId !== state.project?.id && state.expandedProjects.has(sourceId)) void ensureProjectSessions(sourceId);
    const wasCurrent = state.runSession?.id === sessionId;
    const wasInsp = state.inspectorSession?.id === sessionId;
    await loadTeam();
    if (wasCurrent) {
      state.runSession = null;
      if (state.sessions.length) await openRuns(state.sessions[0].id, null);
      else showWelcome();
    }
    if (wasInsp) {
      state.inspectorSession = null;
      if (state.inspMode === 'session') setInspMode('files');
    }
    renderProjects();
    renderSidebar();
    // 从自由对话拖进项目、或从项目拖回自由对话，两边列表都要按最新归属刷新。
    void refreshRecent().then(() => renderConversations()).catch(() => {});
  } catch (error) {
    toast((error as Error).message);
  }
}

async function deleteSessionFlow(session: SessionView): Promise<void> {
  const ok = await askConfirm('删除会话', `将删除「${conversationTitle(session)}」的全部回合、成果与整理记录，不可恢复。`, '删除');
  if (!ok) return;
  try {
    await api.deleteSession(session.id);
    state.detachedSessions.delete(session.id);
    delete state.projectSessions[session.project_id];
    if (session.project_id !== state.project?.id && state.expandedProjects.has(session.project_id)) void ensureProjectSessions(session.project_id);
    const wasCurrent = state.runSession?.id === session.id;
    await loadTeam();
    if (wasCurrent) {
      state.runSession = null;
      if (state.sessions.length) await openRuns(state.sessions[0].id, null);
      else showWelcome();
    }
    if (state.inspectorSession?.id === session.id) {
      state.inspectorSession = null;
      if (state.inspMode === 'session') setInspMode('files');
    }
    renderSidebar();
    void refreshRecent().then(() => renderConversations()).catch(() => {});
    toast('会话已删除');
  } catch (error) {
    toast((error as Error).message);
  }
}

function closeConversationMenu(): void {
  if (!convMenu) return;
  convMenu.remove();
  convMenu = null;
  for (const node of document.querySelectorAll<HTMLElement>('.conv-more[aria-expanded="true"]')) node.setAttribute('aria-expanded', 'false');
}

function positionMenu(menu: HTMLElement, at?: { x: number; y: number }, anchor?: HTMLElement): void {
  document.body.append(menu);
  if (at) {
    menu.style.left = `${Math.max(8, Math.min(at.x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(at.y, innerHeight - menu.offsetHeight - 8))}px`;
  } else if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
    anchor.setAttribute('aria-expanded', 'true');
  }
}

function armMenuDismiss(menu: HTMLElement): void {
  convMenu = menu;
  window.setTimeout(() => {
    const dismiss = (event: PointerEvent) => {
      if (menu.contains(event.target as Node)) return;
      closeConversationMenu();
      document.removeEventListener('pointerdown', dismiss, true);
    };
    document.addEventListener('pointerdown', dismiss, true);
  }, 0);
}

function openConversationMenu(session: SessionView, at?: { x: number; y: number }, anchor?: HTMLElement): void {
  closeConversationMenu();
  const meta = state.conversations[session.id];
  const menu = el('div', 'conv-menu');
  menu.setAttribute('role', 'menu');
  const add = (label: string, run: () => void, danger = false) => {
    const button = el('button', danger ? 'danger' : undefined, label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.onclick = () => {
      closeConversationMenu();
      run();
    };
    menu.append(button);
  };
  add(meta?.pinned ? '取消置顶' : '置顶', () => void patchConversation(session, { pinned: !meta?.pinned }));
  add('重命名…', () => openConversationDialog('rename', session));
  add('分组…', () => openConversationDialog('group', session));
  const targets = state.projects.filter(project => project.id !== session.project_id && !project.archived);
  if (targets.length) {
    menu.append(el('div', 'menu-sep', '移动到项目'));
    for (const project of targets) add(project.name, () => void moveSessionTo(session.id, project));
  }
  if (state.detachedSessions.has(session.id)) {
    add('聚焦独立窗口', () => void detachSession(session));
    add('收回主窗口', () => void api.reattachSession(session.id));
  } else {
    add('拆出为独立窗口', () => void detachSession(session));
  }
  add(meta?.archived ? '恢复会话' : '归档会话', () => void patchConversation(session, { archived: !meta?.archived }));
  add('打开目录', () => void api.openConversationFolder(session.project_id).then(result => {
    if (!result.ok) toast(result.message);
  }));
  menu.append(el('div', 'menu-sep', ''));
  add('删除会话…', () => void deleteSessionFlow(session), true);
  positionMenu(menu, at, anchor);
  armMenuDismiss(menu);
}

function openProjectMenu(project: ProjectView, at?: { x: number; y: number }, anchor?: HTMLElement): void {
  closeConversationMenu();
  const menu = el('div', 'conv-menu');
  menu.setAttribute('role', 'menu');
  const add = (label: string, run: () => void, danger = false) => {
    const button = el('button', danger ? 'danger' : undefined, label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.onclick = () => {
      closeConversationMenu();
      run();
    };
    menu.append(button);
  };
  add('打开目录', () => void api.openConversationFolder(project.id).then(result => {
    if (!result.ok) toast(result.message);
  }));
  add('项目设置…', () => openProjectDialog(project));
  add(project.archived ? '恢复项目' : '归档项目', () => void patchProject(project, { archived: !project.archived }));
  menu.append(el('div', 'menu-sep', ''));
  add('删除项目…', () => void deleteProjectFlow(project), true);
  positionMenu(menu, at, anchor);
  armMenuDismiss(menu);
}

// ---------------------------------------------------------------- 确认框 / 项目设置

let confirmResolver: ((ok: boolean) => void) | null = null;

function askConfirm(title: string, detail: string, okLabel = '确认'): Promise<boolean> {
  $('#confirm-title').textContent = title;
  $('#confirm-detail').textContent = detail;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-dialog').hidden = false;
  $('#confirm-cancel').focus();
  return new Promise(resolve => {
    confirmResolver = resolve;
  });
}

function settleConfirm(ok: boolean): void {
  $('#confirm-dialog').hidden = true;
  confirmResolver?.(ok);
  confirmResolver = null;
}

let projectDialogId: string | null = null;

function openProjectDialog(project: ProjectView): void {
  projectDialogId = project.id;
  $<HTMLInputElement>('#project-name-input').value = project.name;
  $<HTMLInputElement>('#project-workspace-input').value = project.workspace;
  $('#project-archive').textContent = project.archived ? '恢复项目' : '归档项目';
  $('#project-dialog').hidden = false;
  const input = $<HTMLInputElement>('#project-name-input');
  input.focus();
  input.select();
}

function closeProjectDialog(): void {
  $('#project-dialog').hidden = true;
  projectDialogId = null;
}

async function patchProject(project: ProjectView, patch: { name?: string; archived?: boolean }): Promise<void> {
  try {
    const updated = await api.updateProject({ id: project.id, ...patch }) as ProjectView;
    state.projects = state.projects.map(item => (item.id === updated.id ? updated : item));
    if (state.project?.id === updated.id) {
      state.project = updated;
      renderHeader();
    }
    renderProjects();
    toast(patch.archived !== undefined ? (patch.archived ? '项目已归档' : '项目已恢复') : '项目已更新');
  } catch (error) {
    toast((error as Error).message);
  }
}

async function saveProjectDialog(): Promise<void> {
  const project = state.projects.find(item => item.id === projectDialogId);
  if (!project) return closeProjectDialog();
  const name = $<HTMLInputElement>('#project-name-input').value.trim();
  closeProjectDialog();
  if (name && name !== project.name) await patchProject(project, { name });
}

async function deleteProjectFlow(project: ProjectView): Promise<void> {
  const ok = await askConfirm(
    '删除项目',
    `将删除「${project.name}」及其全部会话、回合、成果和留言板记录，不可恢复。工作目录里的文件不会被删除。`,
    '删除',
  );
  if (!ok) return;
  try {
    await api.deleteProject(project.id);
    state.projects = await api.listProjects();
    pickInbox();
    delete state.projectSessions[project.id];
    state.expandedProjects.delete(project.id);
    if (state.project?.id === project.id) {
      state.project = null;
      state.sessions = [];
      state.runs = [];
      state.team = null;
      state.runSession = null;
      state.channel = null;
      state.roots = [];
      state.replies = {};
      state.conversations = {};
      state.inspectorSession = null;
      closeThread();
      closeSearch();
      showHome();
    }
    renderProjects();
    renderSidebar();
    void refreshRecent().then(() => renderConversations()).catch(() => {});
    toast('项目已删除');
  } catch (error) {
    toast((error as Error).message);
  }
}

async function patchConversation(session: SessionView, patch: { pinned?: boolean; archived?: boolean }): Promise<void> {
  try {
    const meta = await api.updateConversation({ projectId: session.project_id, sessionId: session.id, ...patch }) as ConversationMetaView;
    state.conversations[session.id] = meta;
    renderConversations();
    const label = patch.archived !== undefined ? (patch.archived ? '已归档' : '已恢复') : (patch.pinned ? '已置顶' : '已取消置顶');
    toast(`${conversationTitle(session)}：${label}`);
  } catch (error) {
    toast((error as Error).message);
  }
}

const conversationDialog: { kind: 'rename' | 'group'; session: SessionView | null } = { kind: 'rename', session: null };

function openConversationDialog(kind: 'rename' | 'group', session: SessionView): void {
  conversationDialog.kind = kind;
  conversationDialog.session = session;
  const meta = state.conversations[session.id];
  $('#conv-dialog-title').textContent = kind === 'rename' ? '重命名会话' : '移动到分组';
  $('#conv-field-label').textContent = kind === 'rename' ? '会话名称' : '分组名称';
  $('#conv-hint').hidden = false;
  $('#conv-hint').textContent = kind === 'rename'
    ? '只改侧栏显示名称，不影响成员身份、宿主会话和续接。留空可恢复自动标题。'
    : '输入一个分组名；留空表示回到「未分组」。';
  const input = $<HTMLInputElement>('#conv-input');
  input.value = kind === 'rename' ? (meta?.title ?? '') : (meta?.group_name ?? '');
  input.placeholder = kind === 'rename' ? conversationTitle(session) : (meta?.group_name || '例如：发行、调研');
  $('#conv-dialog').hidden = false;
  input.focus();
  input.select();
}

function closeConversationDialog(): void {
  $('#conv-dialog').hidden = true;
  conversationDialog.session = null;
}

async function confirmConversationDialog(): Promise<void> {
  const session = conversationDialog.session;
  if (!session) return;
  const value = $<HTMLInputElement>('#conv-input').value.trim();
  const patch = conversationDialog.kind === 'rename' ? { title: value } : { groupName: value };
  try {
    const meta = await api.updateConversation({
      projectId: session.project_id,
      sessionId: session.id,
      ...patch,
      // 改名同时保留另一项，避免把没提交的字段写回空值。
      ...(conversationDialog.kind === 'rename' ? { groupName: state.conversations[session.id]?.group_name ?? '' } : { title: state.conversations[session.id]?.title ?? '' }),
    }) as ConversationMetaView;
    state.conversations[session.id] = meta;
    closeConversationDialog();
    renderConversations();
    toast(conversationDialog.kind === 'group' ? `已归入「${value || '未分组'}」` : '会话名称已更新');
  } catch (error) {
    $('#conv-hint').hidden = false;
    $('#conv-hint').textContent = (error as Error).message;
  }
}

function renderResults(): void {
  const list = $('#result-list');
  const sources = (INSPECTOR_WINDOW && detachedArtifactSessionId) || (state.runSession && state.view === 'task')
    ? state.artifacts
      .map(artifact => ({ id: artifact.id, path: artifact.path, name: artifact.name, detail: bytes(artifact.size) }))
    : (state.team?.artifacts ?? []).map(artifact => ({ id: artifact.id, path: artifact.absolutePath, name: artifact.name, detail: artifact.memberLabel }));
  const visible = [...new Map(sources.map(result => [result.path ?? result.id, result])).values()];
  list.replaceChildren();
  const count = $('#result-count');
  count.hidden = visible.length === 0;
  count.textContent = String(visible.length);
  if (!visible.length) {
    list.append(el('div', 'result-empty', '交付的文件会显示在这里，点开可在侧栏预览。'));
    return;
  }
  for (const result of visible) {
    const button = el('button', 'result-row');
    const label = el('span', 'result-label');
    label.append(el('strong', '', result.name), el('small', '', result.detail));
    button.append(el('span', 'file-mark', result.name.split('.').pop()?.slice(0, 4) ?? '文件'), label, el('span', 'out-arrow', '›'));
    button.title = `${result.path ?? result.name}\n点击在侧栏预览`;
    button.onclick = () => {
      if (!result.path) return toast('这个产出没有落盘文件');
      void previewArtifact(result.path, result.name);
    };
    button.oncontextmenu = event => {
      event.preventDefault();
      if (result.path) void api.revealArtifact(result.path);
    };
    list.append(button);
  }
}

// ---------------------------------------------------------------- 通用侧栏（产出 / 预览 / 成员会话 / 讨论）

const HASH_PARAMS = new URLSearchParams(location.hash.slice(1));
const INSPECTOR_WINDOW_ID = HASH_PARAMS.get('inspector') || (location.hash === '#inspector' ? 'default' : null);
const INSPECTOR_WINDOW = Boolean(INSPECTOR_WINDOW_ID);
/** 拖出来的独立会话窗口：#session=<projectId>&id=<sessionId>，整份界面锁定这一条会话。 */
const SESSION_WINDOW = HASH_PARAMS.get('session') && HASH_PARAMS.get('id')
  ? { projectId: HASH_PARAMS.get('session')!, sessionId: HASH_PARAMS.get('id')! }
  : null;

function selfInspectorSource(): string {
  return INSPECTOR_WINDOW_ID ?? 'main';
}

function otherOccupiedItems(): OccupiedInspectorItem[] {
  const self = selfInspectorSource();
  return INSPECTOR_WINDOW
    ? state.occupiedInspectors.filter(item => item.source !== 'main' && item.source !== self)
    : state.occupiedInspectors.filter(item => item.source !== 'main');
}

function isFilesOccupiedElsewhere(): boolean {
  const key = inspectorKey({
    mode: 'files',
    projectId: state.project?.id,
    artifactSessionId: INSPECTOR_WINDOW
      ? detachedArtifactSessionId
      : (state.view === 'task' ? state.runSession?.id : undefined),
  });
  return Boolean(findOccupiedByKey(state.occupiedInspectors, key, [selfInspectorSource()]));
}

function updateInspectorWindowTitle(): void {
  if (!INSPECTOR_WINDOW) return;
  if (state.inspMode === 'session' && state.inspectorSession) {
    document.title = `蜂群 · 侧栏 · ${state.inspectorSession.member_label}`;
  } else if (state.inspMode === 'preview' && state.preview?.name) {
    document.title = `蜂群 · 侧栏 · ${state.preview.name}`;
  } else if (state.inspMode === 'thread') {
    document.title = '蜂群 · 侧栏 · 讨论';
  } else {
    document.title = '蜂群 · 侧栏 · 产出';
  }
}

function reportInspectorState(): void {
  if (SESSION_WINDOW) return;
  const home = $('.app').classList.contains('home-mode');
  const snapshot: InspectorSnapshot = {
    projectId: state.project?.id,
    artifactSessionId: INSPECTOR_WINDOW
      ? detachedArtifactSessionId
      : (state.view === 'task' ? state.runSession?.id : undefined),
    mode: state.inspMode,
    sessionId: state.inspectorSession?.id ?? null,
    preview: state.preview,
    rootId: state.threadRootId,
    open: INSPECTOR_WINDOW ? true : (state.inspectorOpen && !home),
  };
  api.inspectorState(snapshot);
}

/** 派工先后以真实派工时间为准；没有派工时间的（主控、历史席位）用创建时间兜底。 */
const byDispatchOrder = (a: SessionView, b: SessionView): number => {
  const at = (session: SessionView) => Date.parse(session.dispatched_at || session.created_at);
  return at(a) - at(b);
};

/**
 * 本任务的**完整**成员名单：主控 + 它派出的全部子成员。
 * 主控也是成员，必须在名单里；这里不做任何「只看子成员」的过滤。
 */
function taskMembers(): SessionView[] {
  const anchor = INSPECTOR_WINDOW
    ? state.sessions.find(item => item.id === detachedMainSessionId) ?? state.inspectorSession
    : state.runSession ?? state.inspectorSession;
  if (!anchor) return [...state.sessions].sort(byDispatchOrder);
  const parent = anchor.parent_session_id
    ? state.sessions.find(item => item.id === anchor.parent_session_id)
    : undefined;
  const root = parent ?? anchor;
  const children = state.sessions.filter(session => session.parent_session_id === root.id);
  if (children.length) return [root, ...children].sort(byDispatchOrder);
  // 历史数据没有父子字段时按成员组兜底，组里包含主控自己。
  return state.sessions.filter(session => session.group_id === root.group_id).sort(byDispatchOrder);
}

/**
 * 右栏候选：排除所有会造成重复的成员 —— 中央正在展示的成员、独立会话窗口、以及其它侧栏窗口已占用的成员。
 * 一个成员同时只能占一个位置。
 */
function inspectorCandidates(): SessionView[] {
  const central = INSPECTOR_WINDOW ? detachedMainSessionId : state.runSession?.id;
  const occupied = occupiedSessionIds(state.occupiedInspectors, selfInspectorSource());
  return taskMembers().filter(
    session => session.id !== central && !state.detachedSessions.has(session.id) && !occupied.has(session.id),
  );
}

function renderInspectorVisibility(): void {
  const home = $('.app').classList.contains('home-mode');
  const inline = INSPECTOR_WINDOW || (state.inspectorOpen && !home);
  $('#inspector').hidden = !inline;
  $('#toggle-results').setAttribute('aria-expanded', String(state.inspectorOpen));
  $('#insp-detach').hidden = INSPECTOR_WINDOW || Boolean(SESSION_WINDOW);
  if (INSPECTOR_WINDOW) {
    $('#insp-close').title = '关闭窗口';
    $('#insp-close').setAttribute('aria-label', '关闭窗口');
  }
}

function setInspectorOpen(open: boolean): void {
  const wasOpen = state.inspectorOpen;
  state.inspectorOpen = open;
  renderInspectorVisibility();
  if (open && !wasOpen && !INSPECTOR_WINDOW && !SESSION_WINDOW) reconcileMainInspector();
  reportInspectorState();
}

/** 右栏自己的成员切换：候选排除中央当前成员与已拆窗成员，点一下就换，中央不动。 */
function renderInspectorMembers(): void {
  const bar = $('#insp-members');
  if (!bar) return;
  bar.replaceChildren();
  const candidates = inspectorCandidates();
  const visible = candidates.length > 1 || (candidates.length === 1 && candidates[0].id !== state.inspectorSession?.id);
  bar.hidden = !visible;
  if (!visible) return;
  for (const session of candidates) {
    const chip = el('button', 'insp-member', session.member_label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(session.id === state.inspectorSession?.id));
    if (session.id === state.inspectorSession?.id) chip.classList.add('active');
    const status = sessionStatus(session);
    chip.title = `${session.member_label} · ${session.host} · ${status.label}`;
    chip.onclick = () => void openInspectorSession(session.id);
    bar.append(chip);
  }
}

function toggleInspector(): void {
  setInspectorOpen(!state.inspectorOpen);
}

function setInspMode(mode: typeof state.inspMode): void {
  state.inspMode = mode;
  const tabs: [string, typeof state.inspMode][] = [
    ['#insp-tab-files', 'files'], ['#insp-tab-preview', 'preview'],
    ['#insp-tab-session', 'session'], ['#insp-tab-thread', 'thread'],
  ];
  for (const [selector, key] of tabs) $(selector).setAttribute('aria-pressed', String(key === mode));
  $('#insp-tab-preview').hidden = !state.preview;
  $('#insp-tab-thread').hidden = !state.threadRootId;
  $('#insp-body-files').hidden = mode !== 'files';
  $('#insp-body-preview').hidden = mode !== 'preview';
  $('#insp-body-session').hidden = mode !== 'session';
  $('#insp-body-thread').hidden = mode !== 'thread';
  renderSwapVisibility();
  updateInspectorWindowTitle();
  reportInspectorState();
}

function renderSwapVisibility(): void {
  const central = INSPECTOR_WINDOW ? detachedMainSessionId : state.runSession?.id;
  $('#insp-swap').hidden = !(state.inspMode === 'session' && state.inspectorSession && central
    && state.inspectorSession.id !== central);
}

function sessionStatus(session: SessionView): { label: string; cls: string } {
  const latest = state.runs.find(run => run.session_id === session.id);
  if (latest?.status === 'running') return { label: '活跃中', cls: 'running' };
  const task = state.team?.members.find(member => member.id === session.id)?.task;
  if (task?.report === 'submitted') return task.acceptance === 'rejected' ? { label: '被驳回', cls: 'failed' } : { label: '完成 · 待接收', cls: 'submitted' };
  if (task?.report === 'done') return task.acceptance === 'accepted' ? { label: '已完成', cls: 'done' } : { label: '等待确认', cls: 'confirm' };
  if (task?.report === 'blocked') return { label: '阻塞', cls: 'failed' };
  if (latest?.status === 'failed') return { label: '失败', cls: 'failed' };
  if (latest?.status === 'cancelled') return { label: '已停止', cls: 'failed' };
  if (latest?.status === 'done') return { label: '已完成', cls: 'done' };
  return { label: '待接', cls: 'idle' };
}

async function openInspectorSession(sessionId: string, activate = true): Promise<void> {
  const session = inspectorCandidates().find(item => item.id === sessionId);
  if (!session) return toast('这个成员没有会话');
  state.inspectorSession = session;
  const [artifacts, entries]: [ArtifactView[], TranscriptEntry[]] = await Promise.all([
    api.listArtifacts(session.id), api.conversationTurns(session.id),
  ]);
  if (state.inspectorSession?.id !== session.id) return;
  state.inspArtifacts = artifacts;
  state.inspRunning = state.runs.find(run => run.session_id === session.id && run.status === 'running')?.id ?? null;
  renderInspectorTranscript(entries, session, artifacts);
  renderInspectorSessionHead();
  if (activate) {
    setInspMode('session');
    setInspectorOpen(true);
  }
  renderInspectorMembers();
  renderSidebar();
}

function showInspectorSession(): void {
  const pool = inspectorCandidates();
  const target = pool.find(item => item.id === state.inspectorSession?.id)
    ?? pool.find(item => item.parent_session_id) ?? pool[0];
  if (target) {
    if (target.id === state.inspectorSession?.id) setInspMode('session');
    else void openInspectorSession(target.id);
    return;
  }
  state.inspectorSession = null;
  state.inspRunning = null;
  const central = INSPECTOR_WINDOW ? detachedMainSessionId : state.runSession?.id;
  const name = state.sessions.find(item => item.id === central)?.member_label;
  const message = name
    ? `「${name}」正在主窗口显示。其他成员如已拆窗，可在各自窗口查看。`
    : '当前没有可在侧栏展示的会话。';
  $('#insp-transcript').replaceChildren(el('div', 'result-empty', message));
  renderInspectorSessionHead();
  setInspMode('session');
}

function renderInspectorTranscript(entries: TranscriptEntry[], session: SessionView, artifacts: ArtifactView[]): void {
  const container = $('#insp-transcript');
  clearTranscript(container);
  for (const entry of entries) renderStaticTurn(entry, container, session, artifacts);
  if (!entries.length) container.append(el('div', 'result-empty', '这位成员还没有回合。'));
  container.scrollTop = container.scrollHeight;
}

function renderInspectorSessionHead(): void {
  const session = state.inspectorSession;
  $('#insp-session-name').textContent = session ? `${session.member_label} · ${session.host}` : '';
  const status = session ? sessionStatus(session) : null;
  const node = $('#insp-session-status');
  node.className = `status ${status?.cls ?? ''}`;
  node.textContent = status?.label ?? '';
  const send = $('#insp-send') as HTMLButtonElement;
  const prompt = $('#insp-prompt') as HTMLTextAreaElement;
  send.disabled = !session || !hostEnabled(session.host) || Boolean(state.inspRunning);
  prompt.disabled = !session || Boolean(state.inspRunning);
  $('#insp-hint').textContent = !session ? '' : state.inspRunning ? '执行中…'
    : hostEnabled(session.host) ? `${session.host}${session.host_session_id ? ' · 续接原会话' : ' · 新会话'}` : '宿主已停用';
  renderSwapVisibility();
}

async function sendInspectorRun(): Promise<void> {
  const session = state.inspectorSession;
  if (!session || !state.project) return;
  if (!hostEnabled(session.host)) return toast('此宿主已停用，可从设置开启');
  const promptBox = $('#insp-prompt') as HTMLTextAreaElement;
  const prompt = promptBox.value.trim();
  if (!prompt || state.inspRunning) return;
  try {
    await api.startRun({ projectId: state.project.id, sessionId: session.id, prompt, model: session.model, effort: session.effort ?? '' });
    promptBox.value = '';
  } catch (error) {
    toast(`发起失败：${(error as Error).message}`);
  }
}

async function previewArtifact(filePath: string, name: string): Promise<void> {
  const previewKey = inspectorKey({ mode: 'preview', projectId: state.project?.id, preview: { path: filePath, name } });
  const conflict = findOccupiedByKey(otherOccupiedItems(), previewKey);
  if (conflict) {
    void api.inspectorFocus(previewKey);
    toast(`「${name}」已在独立窗口打开`);
    return;
  }
  state.preview = { path: filePath, name };
  $('#preview-name').textContent = name;
  $('#preview-name').title = filePath;
  const body = $('#preview-body');
  body.replaceChildren(el('div', 'muted', '读取中…'));
  setInspMode('preview');
  setInspectorOpen(true);
  const reply = await api.readArtifact(filePath) as { ok: boolean; text?: string; message?: string } | null;
  if (state.preview?.path !== filePath) return;
  body.replaceChildren();
  if (!reply?.ok) {
    body.append(el('div', 'notice-warn', reply?.message ?? '这个文件暂时无法预览，可用系统程序打开。'));
    return;
  }
  if (/\.(md|markdown)$/i.test(name)) {
    const box = el('div', 'body-text markdown');
    box.innerHTML = markdown.render(reply.text ?? '');
    body.append(box);
  } else {
    body.append(el('pre', 'preview-pre', reply.text ?? ''));
  }
}

function requestInspectorSession(sessionId: string): void {
  const occupied = findOccupiedByKey(otherOccupiedItems(), `session:${sessionId}`);
  if (occupied) {
    void api.inspectorFocus(occupied.key);
    return;
  }
  void openInspectorSession(sessionId);
}

async function handleSwap(targetId: string, fromWindowId?: string): Promise<void> {
  const oldMain = state.runSession?.id;
  if (!oldMain || oldMain === targetId) return toast('没有可交换的主会话');
  await openRuns(targetId);
  if (fromWindowId) {
    api.inspectorAssign({ windowId: fromWindowId, sessionId: oldMain, mainSessionId: targetId });
  } else {
    await openInspectorSession(oldMain);
  }
  toast('已交换主会话与侧栏会话');
}

let detachInFlight = false;

function fallbackAfterInspectorVacated(): void {
  const candidate = state.inspectorSession && inspectorCandidates().some(item => item.id === state.inspectorSession!.id)
    ? state.inspectorSession
    : null;
  if (candidate) setInspMode('session');
  else if (!isFilesOccupiedElsewhere()) setInspMode('files');
  else if (inspectorCandidates().length) showInspectorSession();
  else setInspMode('files');
}

function reconcileMainInspector(): void {
  if (INSPECTOR_WINDOW || SESSION_WINDOW || !state.inspectorOpen || $('.app').classList.contains('home-mode')) return;
  const detachedItems = otherOccupiedItems();
  if (state.inspMode === 'session') {
    if (state.inspectorSession && !inspectorCandidates().some(item => item.id === state.inspectorSession!.id)) {
      state.inspectorSession = null;
      state.inspArtifacts = [];
      state.inspRunning = null;
      const next = inspectorCandidates()[0];
      if (next) void openInspectorSession(next.id, true);
      else if (!isFilesOccupiedElsewhere()) setInspMode('files');
      else showInspectorSession();
    } else if (!state.inspectorSession && inspectorCandidates().length) {
      showInspectorSession();
    }
    return;
  }
  if (state.inspMode === 'preview' && state.preview?.path) {
    const key = inspectorKey({ mode: 'preview', projectId: state.project?.id, preview: state.preview });
    if (findOccupiedByKey(detachedItems, key)) {
      state.preview = null;
      fallbackAfterInspectorVacated();
    }
    return;
  }
  if (state.inspMode === 'thread' && state.threadRootId) {
    const key = inspectorKey({ mode: 'thread', projectId: state.project?.id, rootId: state.threadRootId });
    if (findOccupiedByKey(detachedItems, key)) {
      closeThread();
    }
  }
}

async function detachCurrentInspector(): Promise<void> {
  if (INSPECTOR_WINDOW || SESSION_WINDOW) return;
  const snapshot: InspectorSnapshot = {
    projectId: state.project?.id,
    mainSessionId: state.runSession?.id,
    artifactSessionId: state.view === 'task' ? state.runSession?.id : undefined,
    boardSessionId: boardSessionId(),
    channelId: state.channel?.id,
    detachedSessions: [...state.detachedSessions],
    mode: state.inspMode,
    sessionId: state.inspMode === 'session' ? (state.inspectorSession?.id ?? null) : null,
    preview: state.inspMode === 'preview' ? state.preview : null,
    rootId: state.inspMode === 'thread' ? state.threadRootId : null,
  };
  const check = canDetachInspector(snapshot);
  if (!check.ok) {
    toast(check.message);
    return;
  }
  const btn = $<HTMLButtonElement>('#insp-detach');
  if (btn.disabled || detachInFlight) return;
  btn.disabled = true;
  detachInFlight = true;
  try {
    const result = await api.inspectorDetach(snapshot) as { ok: boolean; windowId?: string; reason?: string; message?: string };
    if (!result?.ok) {
      if (result?.message) toast(result.message);
      return;
    }
    // 拆分出去之后，主面板侧栏照常打开，并自动切换/清空当前拆出的项以保持侧栏不重复。
    if (snapshot.mode === 'session' && snapshot.sessionId) {
      if (result.windowId && !state.occupiedInspectors.some(item => item.source === result.windowId)) {
        state.occupiedInspectors = [
          ...state.occupiedInspectors,
          {
            source: result.windowId,
            key: inspectorKey(snapshot),
            mode: 'session',
            projectId: snapshot.projectId,
            sessionId: snapshot.sessionId,
            previewPath: null,
            rootId: null,
          },
        ];
      }
      state.inspectorSession = null;
      state.inspArtifacts = [];
      state.inspRunning = null;
      const next = inspectorCandidates()[0];
      if (next) await openInspectorSession(next.id, true);
      else if (!isFilesOccupiedElsewhere()) setInspMode('files');
      else showInspectorSession();
    } else if (snapshot.mode === 'preview') {
      state.preview = null;
      fallbackAfterInspectorVacated();
    } else if (snapshot.mode === 'thread') {
      state.thread = null;
      state.threadRootId = null;
      fallbackAfterInspectorVacated();
    } else if (snapshot.mode === 'files') {
      if (inspectorCandidates().length) showInspectorSession();
    }
    renderInspectorVisibility();
    renderInspectorMembers();
  } finally {
    detachInFlight = false;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 会话切换弹层

let popPreviewSession: SessionView | null = null;
let popHoverTimer: number | null = null;

function openSessionPop(): void {
  renderSessionPop();
  const pop = $('#session-pop');
  pop.hidden = false;
  const anchor = $('#open-runs').getBoundingClientRect();
  pop.style.top = `${anchor.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(anchor.left - 60, innerWidth - pop.offsetWidth - 8))}px`;
}

function closeSessionPop(): void {
  $('#session-pop').hidden = true;
  popPreviewSession = null;
}

function renderSessionPopIfOpen(): void {
  if (!$('#session-pop').hidden) renderSessionPop();
}

function renderSessionPop(): void {
  const list = $('#session-pop-list');
  list.replaceChildren();
  const scoped = taskMembers();
  if (!scoped.length) {
    list.append(el('div', 'result-empty', '本任务还没有成员'));
    return;
  }
  // 顺序固定为派工先后：在跑或先完成都不许插队。
  for (const session of scoped) {
    const status = sessionStatus(session);
    const row = el('button', 'session-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    if (state.runSession?.id === session.id) row.classList.add('current');
    else if (state.inspectorSession?.id === session.id || occupiedSessionIds(state.occupiedInspectors, 'main').has(session.id)) row.classList.add('inspecting');
    const head = el('span', 'session-row-head');
    head.append(el('span', 'session-row-name', session.member_label), el('span', `status-pill ${status.cls}`, status.label));
    row.append(head, el('span', 'session-row-sub', `${session.host} · ${conversationStatus(roundsOf(session.id))}${state.detachedSessions.has(session.id) ? ' · 已拆出' : ''}`));
    row.onmouseenter = () => schedulePopPreview(session);
    row.onfocus = () => schedulePopPreview(session);
    row.onclick = () => {
      closeSessionPop();
      // 中央换人：右侧若正停在同一个成员，由 openConversation 统一错开，避免两处重复。
      void openConversation(session);
    };
    row.oncontextmenu = event => {
      event.preventDefault();
      openConversationMenu(session, { x: event.clientX, y: event.clientY });
    };
    row.draggable = true;
    row.ondragstart = event => {
      dragSessionId = session.id;
      if (event.dataTransfer) {
        event.dataTransfer.setData('application/x-swarm-session', session.id);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setDragImage(showDragCard(session.member_label, `${session.host} · 松手拆为独立窗口`), 24, 20);
      }
      row.classList.add('dragging');
    };
    row.ondragend = event => {
      row.classList.remove('dragging');
      clearDragCard();
      const consumed = dragSessionId === null;
      dragSessionId = null;
      if (!consumed) maybeDetachOnDragEnd(event, session);
    };
    list.append(row);
  }
}

function schedulePopPreview(session: SessionView): void {
  if (popHoverTimer) window.clearTimeout(popHoverTimer);
  popHoverTimer = window.setTimeout(() => {
    popHoverTimer = null;
    void loadPopPreview(session);
  }, 120);
}

async function loadPopPreview(session: SessionView): Promise<void> {
  if ($('#session-pop').hidden) return;
  popPreviewSession = session;
  const hint = $('#session-pop-hint');
  const container = $('#session-pop-transcript');
  const latest = roundsOf(session.id).at(-1);
  if (!latest) {
    container.replaceChildren();
    hint.hidden = false;
    hint.textContent = `${session.member_label} 还没有回合`;
    return;
  }
  const entry = await api.getRun(latest.id);
  if ($('#session-pop').hidden || popPreviewSession?.id !== session.id) return;
  hint.hidden = true;
  container.replaceChildren();
  if (entry) renderStaticTurn(entry, container, session, []);
  container.scrollTop = container.scrollHeight;
}

function showView(view: typeof state.view): void {
  $('.app').classList.remove('home-mode');
  $('#home').hidden = true;
  state.view = view;
  $('#runs-panel').hidden = view !== 'task';
  $('#collaboration').hidden = view !== 'team';
  $('#open-board').hidden = view !== 'team';
  $('#open-public-board').hidden = !state.project;
  $('#open-runs').setAttribute('aria-pressed', String(view === 'task'));
  $('#open-team').setAttribute('aria-pressed', String(view === 'team'));
  $('#share-conversation').hidden = view !== 'task' || !state.runSession;
  $('#topbar-search').hidden = view !== 'task' || !state.runSession;
  $('#search-bar').hidden = view !== 'task' || !state.search;
  if (view === 'task') closeThread();
  else closeSearch();
  closeSessionPop();
  renderRoundNav();
  renderHeader();
  renderSidebar();
  renderResults();
  renderInspectorVisibility();
  reportInspectorState();
}

function renderRoundNav(): void {
  const nav = $('#round-nav');
  const home = $('.app').classList.contains('home-mode');
  const rounds = state.runSession ? roundsOf(state.runSession.id) : [];
  const show = !home && state.view === 'task' && Boolean(state.runSession) && rounds.length > 1;
  nav.hidden = !show;
  if (!show) return;
  const select = $<HTMLSelectElement>('#round-select');
  select.replaceChildren();
  rounds.forEach((round, index) => {
    const status = round.status === 'running' ? ` · ${RUN_LABEL.running}` : '';
    select.add(new Option(`回合 ${index + 1}/${rounds.length} · ${firstLine(round.prompt) || round.id}${status}`, round.id));
  });
  if (state.selectedRun && rounds.some(round => round.id === state.selectedRun)) select.value = state.selectedRun;
  const index = rounds.findIndex(round => round.id === state.selectedRun);
  $<HTMLButtonElement>('#round-prev').disabled = index <= 0;
  $<HTMLButtonElement>('#round-next').disabled = index < 0 || index >= rounds.length - 1;
}

// ---------------------------------------------------------------- 会话内搜索

function clearSearchMarks(): void {
  for (const mark of [...document.querySelectorAll<HTMLElement>('#transcript mark.hit')]) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

function highlightText(root: HTMLElement, needle: string, marks: HTMLElement[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const value = node.nodeValue ?? '';
    if (!value.toLowerCase().includes(needle) || node.parentElement?.closest('mark')) continue;
    nodes.push(node);
  }
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const lower = value.toLowerCase();
    const fragment = document.createDocumentFragment();
    let from = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      if (at > from) fragment.append(value.slice(from, at));
      const mark = el('mark', 'hit', value.slice(at, at + needle.length));
      fragment.append(mark);
      marks.push(mark);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < value.length) fragment.append(value.slice(from));
    node.parentNode?.replaceChild(fragment, node);
  }
}

/** 只标记当前打开的回合；顺序与检索一致：提问 → 回复 → 思考 → 过程。 */
function applySearchHighlight(): void {
  clearSearchMarks();
  const search = state.search;
  if (!search?.query) return;
  const marks: HTMLElement[] = [];
  const transcript = $('#transcript');
  const run = state.selectedRun ? CSS.escape(state.selectedRun) : '';
  const prompt = transcript.querySelector(`.turn.user[data-run-id="${run}"]`);
  const answer = transcript.querySelector(`.turn.agent[data-run-id="${run}"]`);
  const containers = [prompt?.querySelector('.bubble'), answer?.querySelector('.body-text'),
    answer?.querySelector('.thinking-body'), answer?.querySelector('.progress')];
  for (const container of containers) if (container) highlightText(container as HTMLElement, search.query.toLowerCase(), marks);
  if (!marks.length) return;
  const runHits = search.hits.filter(hit => hit.runId === state.selectedRun);
  let ordinal = 0;
  if (search.index >= 0 && search.hits[search.index]?.runId === state.selectedRun) {
    ordinal = search.hits.slice(0, search.index + 1).filter(hit => hit.runId === state.selectedRun).length - 1;
  }
  const target = marks[Math.min(Math.max(ordinal, 0), marks.length - 1)];
  target.classList.add('current');
  target.scrollIntoView({ block: 'center' });
}

function renderSearchCount(): void {
  const count = $('#search-count');
  const search = state.search;
  if (!search?.query) {
    count.textContent = '';
    return;
  }
  if (!search.hits.length) {
    count.textContent = '没有匹配';
    return;
  }
  count.textContent = search.index < 0 ? `${search.hits.length} 处` : `${search.index + 1}/${search.hits.length}`;
}

async function goToHit(step: number): Promise<void> {
  const search = state.search;
  if (!search?.hits.length) return;
  const total = search.hits.length;
  search.index = search.index < 0 ? (step > 0 ? 0 : total - 1) : ((search.index + step) % total + total) % total;
  renderSearchCount();
  const hit = search.hits[search.index];
  const session = state.runSession;
  if (!session) return;
  jumpToRun(hit.runId);
  applySearchHighlight();
}

async function runSearch(): Promise<void> {
  if (!state.runSession) return;
  const query = $<HTMLInputElement>('#search-input').value.trim();
  if (!query) {
    state.search = null;
    renderSearchCount();
    clearSearchMarks();
    return;
  }
  const sessionId = state.runSession.id;
  try {
    const hits = await api.searchConversation(sessionId, query) as ConversationSearchHitView[];
    if (state.runSession?.id !== sessionId || $<HTMLInputElement>('#search-input').value.trim() !== query) return;
    state.search = { query, hits, index: -1 };
    renderSearchCount();
    applySearchHighlight();
  } catch (error) {
    toast(`搜索失败：${(error as Error).message}`);
  }
}

function openSearch(): void {
  if (state.view !== 'task' || !state.runSession) {
    toast('先打开一条会话');
    return;
  }
  $('#search-bar').hidden = false;
  const input = $<HTMLInputElement>('#search-input');
  input.focus();
  input.select();
}

function closeSearch(): void {
  const bar = $('#search-bar');
  if (bar.hidden && !state.search) return;
  bar.hidden = true;
  $<HTMLInputElement>('#search-input').value = '';
  state.search = null;
  renderSearchCount();
  clearSearchMarks();
}

// ---------------------------------------------------------------- 会话分享

function scrubLocalPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, '[本机路径]')
    .replace(/\\\\[^\s"'<>|]+/g, '[本机路径]');
}

function shareText(): string {
  const shared = state.share;
  if (!shared) return '';
  const includePaths = $<HTMLInputElement>('#share-paths').checked;
  const clean = (text: string) => (includePaths ? text : scrubLocalPaths(text));
  const lines = [
    `# ${conversationTitle(shared.session)}`,
    '',
    `成员：${shared.session.member_label} · 宿主：${shared.session.host}`,
    `回合数：${shared.runs.length} · 导出：${new Date().toLocaleString('zh-CN')}`,
    '',
  ];
  shared.runs.forEach((run, index) => {
    const status = RUN_LABEL[run.status] ?? run.status;
    lines.push(`## 第 ${index + 1} 回合 · ${run.started_at.slice(0, 16).replace('T', ' ')} · ${status}`, '');
    // 正文给人看；派工提示还带一段蜂群附加指令，导出必须留着并说明，不能静默丢。
    const parsed = parseDispatchPrompt(run.prompt);
    lines.push(`**我：** ${clean(parsed ? parsed.body : run.prompt)}`, '');
    if (parsed) {
      lines.push('> 这条是派工消息，上面是正文；宿主实际收到的还包含下面这段蜂群附加指令：', '');
      lines.push('```', clean(run.prompt), '```', '');
    }
    lines.push(`**${shared.session.member_label}：** ${clean(run.reply_text || '（没有回复）')}`, '');
  });
  return lines.join('\n');
}

function renderSharePreview(): void {
  const shared = state.share;
  const preview = $('#share-preview');
  preview.replaceChildren();
  if (!shared) return;
  $('#share-subtitle').textContent = `${conversationTitle(shared.session)} · ${shared.runs.length} 回合 · ${shared.session.member_label}`;
  if (!shared.runs.length) {
    preview.append(el('div', 'muted', '这条会话还没有回合。'));
    return;
  }
  const includePaths = $<HTMLInputElement>('#share-paths').checked;
  const clean = (text: string) => (includePaths ? text : scrubLocalPaths(text));
  shared.runs.forEach((run, index) => {
    const block = el('div', 'share-round');
    block.append(el('h4', '', `第 ${index + 1} 回合 · ${run.started_at.slice(0, 16).replace('T', ' ')} · ${RUN_LABEL[run.status] ?? run.status}`));
    const question = el('div', 'share-q');
    const parsed = parseDispatchPrompt(run.prompt);
    question.append(el('span', 'share-who', '我：'), document.createTextNode(clean(parsed ? parsed.body : run.prompt)));
    if (parsed) {
      const note = el('div', 'muted', '派工消息：导出会连同蜂群附加指令一起带上，预览只显示正文。');
      question.append(note);
    }
    const answer = el('div', 'share-a');
    answer.append(el('span', 'share-who', `${shared.session.member_label}：`), document.createTextNode(clean(run.reply_text || '（没有回复）')));
    block.append(question, answer);
    preview.append(block);
  });
}

async function openShare(): Promise<void> {
  if (!state.runSession) return toast('先打开一条会话');
  const session = state.runSession;
  try {
    const runs = await api.conversationTranscript(session.id) as TranscriptEntry['run'][];
    if (state.runSession?.id !== session.id) return;
    state.share = { session, runs };
    $<HTMLInputElement>('#share-paths').checked = false;
    renderSharePreview();
    $('#share-dialog').hidden = false;
    $('#share-close').focus();
  } catch (error) {
    toast(`读取会话失败：${(error as Error).message}`);
  }
}

function closeShare(): void {
  $('#share-dialog').hidden = true;
  state.share = null;
}

async function copyShare(): Promise<void> {
  const content = shareText();
  if (!content) return;
  await api.copyText(content);
  toast('已复制会话（只读文本）');
}

async function exportShare(): Promise<void> {
  const content = shareText();
  const shared = state.share;
  if (!content || !shared) return;
  const name = `${state.project?.name ?? '蜂群'}-${conversationTitle(shared.session)}-${new Date().toISOString().slice(0, 10)}.md`
    .replace(/[\\/:*?"<>|]/g, '-');
  const filePath = await api.exportMarkdown({ defaultName: name, content });
  if (filePath) toast(`已导出：${filePath}`);
}

// ---------------------------------------------------------------- 侧栏开关

function setSidebarCollapsed(collapsed: boolean): void {
  $('.app').classList.toggle('sidebar-collapsed', collapsed);
  try {
    localStorage.setItem('swarm.sidebarCollapsed', collapsed ? '1' : '0');
  } catch {
    // 隐私模式写不进去不影响收起本身
  }
  $('#toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
}

function toggleResultsPanel(): void {
  toggleInspector();
}

/** 拖拽调宽：pointer capture 保证移出窗口也不丢事件。 */
function bindResizer(handle: HTMLElement, options: {
  read: () => number; apply: (width: number) => void; min: number; max: number; invert?: boolean;
}): void {
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = options.read();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (options.invert ? -1 : 1);
      const width = Math.round(Math.min(options.max, Math.max(options.min, startWidth + delta)));
      options.apply(width);
    };
    const up = (upEvent: PointerEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ---------------------------------------------------------------- 主区

function renderHeader(): void {
  $('#project-title').textContent = state.project?.name ?? '工作台';
  const subtitle = $('#channel-title');
  subtitle.hidden = !state.project;
  if (state.view === 'task') {
    subtitle.textContent = state.runSession ? `${state.runSession.member_label} · ${state.runSession.host}` : state.project?.workspace ?? '';
    return;
  }
  if (!state.team || !state.channel) {
    subtitle.textContent = state.project?.workspace ?? '';
    return;
  }
  const channel = state.channel;
  const prompt = $<HTMLTextAreaElement>('#prompt');
  if (composerChannelId !== channel.id) {
    if (composerChannelId) channelDrafts.set(composerChannelId, prompt.value);
    composerChannelId = channel.id;
    prompt.value = channelDrafts.get(channel.id) ?? '';
  }
  prompt.disabled = Boolean(channel.archived);
  $<HTMLButtonElement>('#send').disabled = Boolean(channel.archived);
  $('#channel-title').textContent = channel.kind === 'dm' ? `私信 · ${channel.name}` : `# ${channel.name}`;
  $('#composer-hint').textContent = channel.archived ? '已归档 · 恢复后可发言'
    : channel.kind === 'dm' ? `私信 · ${channel.name}`
    : channel.main ? '主线 · 当前项目或任务成员可见' : `${channel.memberIds?.filter(id => id !== 'owner').length ?? 0} 位成员`;
}

function messageBlock(message: DecodedMessage, options: { compact?: boolean; hideThreadLink?: boolean } = {}): HTMLElement {
  if (message.kind === 'system') {
    const block = el('div', 'msg system');
    const head = el('div', 'msg-head');
    head.append(el('span', 'msg-who', message.senderLabel), el('span', 'msg-time', message.time.slice(11, 19)));
    const body = el('div', 'msg-text', message.text);
    block.append(head, body);
    return block;
  }

  const mine = message.sender === 'owner';
  const row = el('div', 'msg-chat');
  if (mine) row.classList.add('mine');
  if (options.compact) row.classList.add('compact');

  const senderSession = !mine ? state.sessions.find(item => item.id === message.sender) : undefined;
  const avatar = avatarButton({
    targetKey: mine ? 'owner' : message.sender,
    sender: message.sender,
    host: senderSession?.host,
    model: senderSession?.model,
    label: message.senderLabel,
  });

  const col = el('div', 'chat-col');
  const head = el('div', 'msg-head');
  head.append(el('span', 'msg-who', message.senderLabel), el('span', 'msg-time', message.time.slice(11, 19)));

  if (message.to !== 'all' && !options.compact) {
    const badge = el('span', 'msg-badge', `私信 → ${message.toLabel}`);
    head.append(badge);
  }
  if (message.requiresAction) head.append(el('span', 'msg-badge action', '需行动'));
  if (message.dispatch) {
    const labels: Record<string, string> = {
      queued: '排队中',
      running: '执行中',
      claimed: '执行中',
      done: '已完成',
      failed: '失败',
      paused: '已挂起',
      unknown: '状态未知',
    };
    const badge = el('span', `msg-badge dispatch-${message.dispatch.status}`, `派工：${labels[message.dispatch.status] ?? message.dispatch.status}`);
    if (message.dispatch.error) badge.title = message.dispatch.error;
    if (message.dispatch.status === 'failed') badge.append(el('span', 'dispatch-error', `（${message.dispatch.error ?? '未知错误'}）`));
    head.append(badge);
  }
  if (message.threadId) head.append(el('span', 'msg-badge', '讨论串回复'));

  const bubble = el('div', 'msg');
  if (mine) bubble.classList.add('mine');
  const body = el('div', 'msg-text', message.text);
  bubble.append(body);

  if (message.evidence.length) {
    const evRow = el('div', 'msg-row');
    for (const item of message.evidence.slice(0, 6)) evRow.append(el('span', 'chip', item));
    bubble.append(evRow);
  }

  const artifacts = artifactChips(message.artifactIds);
  if (artifacts.childElementCount) bubble.append(artifacts);

  const replies = state.replies[message.id] ?? [];
  if (!options.compact && !options.hideThreadLink && replies.length) {
    const link = el('button', 'thread-link', `${replies.length} 条回复`);
    link.onclick = event => {
      event.stopPropagation();
      void openThread(message.id);
    };
    bubble.append(link);
  }

  col.append(head, bubble);
  if (mine) row.append(col, avatar);
  else row.append(avatar, col);
  return row;
}

function artifactChips(ids: string[]): HTMLElement {
  const row = el('div', 'msg-row');
  for (const id of ids) {
    const artifact = state.team?.artifacts.find(item => item.id === id);
    if (!artifact) continue;
    const chip = el('div', 'artifact');
    chip.append(el('span', 'check', '✓'), el('span', '', artifact.name));
    chip.title = artifact.absolutePath ?? artifact.path ?? '';
    chip.onclick = async () => {
      if (!artifact.absolutePath) return toast('这个成果只有内容，没有落盘路径');
      const result = await api.openArtifact(artifact.absolutePath);
      if (!result.ok) toast(result.message);
    };
    chip.oncontextmenu = event => {
      event.preventDefault();
      if (artifact.absolutePath) void api.revealArtifact(artifact.absolutePath);
    };
    row.append(chip);
  }
  return row;
}

function dayLabel(day: string): string {
  const today = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const key = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (day === key(today)) return '今天';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day === key(yesterday)) return '昨天';
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return year === today.getFullYear() ? `${month} 月 ${date} 日` : `${year} 年 ${month} 月 ${date} 日`;
}

let streamFirstRender = true;

function renderStream(): void {
  const stream = $('#stream');
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140;
  const focusedRoot = (document.activeElement as HTMLElement | null)?.dataset?.root ?? null;
  stream.innerHTML = '';
  if (!state.project) {
    stream.append(emptyBox('先选择一个已有工作区', '点左侧「选择工作区」接入一个目录。'));
    return;
  }
  if (!state.roots.length) {
    stream.append(
      emptyBox(
        state.channel?.kind === 'dm' ? '这个私信还没有消息' : '留言板还没有留言',
        state.sessions.length ? '人类主任务的第一句话会自动成为第一条留言；在下面补充进展，或 @成员 派一件需要行动的事。' : '先点左侧项目里的「添加」选一个宿主成员。',
      ),
    );
    return;
  }
  let lastDay = '';
  for (const root of state.roots) {
    const day = root.time.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      const sep = el('div', 'day-sep');
      sep.append(el('span', '', dayLabel(day)));
      stream.append(sep);
    }
    const thread = el('div', 'msg-thread');
    if (root.sender === 'owner') thread.classList.add('mine');
    else if (root.kind === 'system') thread.classList.add('system');
    thread.append(messageBlock(root, { hideThreadLink: true }));

    const replies = state.replies[root.id] ?? [];
    if (replies.length) {
      const expanded = state.expandedThreads.has(root.id);
      const box = el('div', 'thread-replies');
      if (replies.length > 3 && !expanded) {
        const more = el('button', 'thread-expand', `展开全部 ${replies.length} 条回复`);
        more.type = 'button';
        more.onclick = () => {
          state.expandedThreads.add(root.id);
          renderStream();
        };
        box.append(more);
      }
      for (const reply of (expanded ? replies : replies.slice(-3))) {
        box.append(messageBlock(reply, { compact: true }));
      }
      if (expanded && replies.length > 3) {
        const less = el('button', 'thread-expand', '收起回复');
        less.type = 'button';
        less.onclick = () => {
          state.expandedThreads.delete(root.id);
          renderStream();
        };
        box.append(less);
      }
      thread.append(box);
    }

    const actions = el('div', 'msg-actions');
    const replyButton = el('button', '', state.openReplyRoot === root.id ? '取消回复' : '回复');
    replyButton.type = 'button';
    replyButton.disabled = Boolean(state.channel?.archived);
    replyButton.onclick = () => {
      state.openReplyRoot = state.openReplyRoot === root.id ? null : root.id;
      renderStream();
      if (state.openReplyRoot === root.id) {
        const input = stream.querySelector<HTMLTextAreaElement>(`textarea[data-root="${root.id}"]`);
        input?.focus();
      }
    };
    actions.append(replyButton);
    const dispatchLink = el('button', '', replies.length ? `讨论串 / 派工 · ${replies.length}` : '讨论串 / 派工');
    dispatchLink.type = 'button';
    dispatchLink.onclick = () => void openThread(root.id);
    actions.append(dispatchLink);
    thread.append(actions);

    if (!state.channel?.archived && state.openReplyRoot === root.id) thread.append(inlineReplyComposer(root.id));
    stream.append(thread);
  }
  if (focusedRoot) {
    const input = stream.querySelector<HTMLTextAreaElement>(`textarea[data-root="${focusedRoot}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (nearBottom || streamFirstRender) stream.scrollTop = stream.scrollHeight;
  streamFirstRender = false;
}

function inlineReplyComposer(rootId: string): HTMLElement {
  const wrap = el('div', 'inline-reply');
  const input = el('textarea', 'inline-reply-input') as HTMLTextAreaElement;
  input.rows = 2;
  input.dataset.root = rootId;
  input.placeholder = '回复这条留言…（Enter 发送，Shift+Enter 换行，Esc 收起）';
  input.value = state.threadDrafts[rootId] ?? '';
  input.oninput = () => {
    state.threadDrafts[rootId] = input.value;
  };
  const sendButton = el('button', 'primary', '回复');
  sendButton.type = 'button';
  let sending = false;
  const send = async () => {
    const text = input.value.trim();
    if (!text || !state.project || sending) return;
    sending = true;
    input.disabled = true;
    sendButton.disabled = true;
    try {
      await api.teamPost({
        projectId: state.project.id,
        sessionId: boardSessionId(),
        text,
        thread: rootId,
        to: state.channel?.kind === 'dm' ? state.channel.memberId : undefined,
      });
      delete state.threadDrafts[rootId];
      state.openReplyRoot = null;
      await loadTeam();
      await loadView();
    } catch (error) {
      toast((error as Error).message);
      sending = false;
      sendButton.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      state.openReplyRoot = null;
      renderStream();
    }
  };
  const actions = el('div', 'inline-reply-actions');
  sendButton.onclick = () => void send();
  const cancel = el('button', 'ghost', '收起');
  cancel.type = 'button';
  cancel.onclick = () => {
    state.openReplyRoot = null;
    renderStream();
  };
  actions.append(el('span', 'inline-reply-hint', 'Enter 发送 · 留言与回复按时间从上到下排列'), sendButton, cancel);
  wrap.append(input, actions);
  return wrap;
}

function emptyBox(title: string, hint?: string): HTMLElement {
  const box = el('div', 'empty');
  box.append(el('h2', '', title));
  if (hint) box.append(el('p', '', hint));
  return box;
}

// ---------------------------------------------------------------- 数据加载

let detachedBoardSessionId: string | undefined;
let detachedMainSessionId: string | undefined;
let detachedArtifactSessionId: string | undefined;
let inspectorRequest = 0;

function broadcastMainContext(): void {
  if (INSPECTOR_WINDOW || SESSION_WINDOW) return;
  api.inspectorContext({
    projectId: state.project?.id,
    mainSessionId: state.runSession?.id,
    artifactSessionId: state.view === 'task' ? state.runSession?.id : undefined,
    boardSessionId: boardSessionId(),
    channelId: state.channel?.id,
    detachedSessions: [...state.detachedSessions],
  });
}

function boardSessionId(): string | undefined {
  if (state.project?.kind !== 'inbox') return undefined;
  return INSPECTOR_WINDOW ? detachedBoardSessionId : state.runSession?.id ?? SESSION_WINDOW?.sessionId;
}

async function loadTeam(): Promise<void> {
  if (!state.project) return;
  const id = state.project.id;
  const sessionId = boardSessionId();
  const isCurrent = () => state.project?.id === id && boardSessionId() === sessionId;
  const [team, sessions, runs, meta, recent] = await Promise.all([
    api.teamState(id, sessionId),
    api.listSessions(id),
    api.listRuns(id),
    api.conversationMeta(id).catch(() => [] as ConversationMetaView[]),
    api.recentSessions().catch(() => [] as RecentSessionView[]),
  ]);
  if (!isCurrent()) return;
  Object.assign(state, {
    team,
    sessions,
    runs,
    conversations: { ...state.conversations, ...Object.fromEntries((meta as ConversationMetaView[]).map(item => [item.session_id, item])) },
  });
  // 同一趟把「最近」也带回：发完消息、新建会话后侧栏立刻跟上，不用二次请求。
  adoptRecent(recent as RecentSessionView[]);
  state.projectSessions[id] = sessions;
  state.channel = (team as TeamState).channels.find(channel => channel.id === state.channel?.id)
    ?? (team as TeamState).channels.find(channel => channel.kind === 'channel') ?? null;
  const boardChannel = (team as TeamState).channels.find(item => item.kind === 'channel');
  if (boardChannel) {
    const view = await api.teamView({ projectId: id, sessionId, channel: boardChannel.id }).catch(() => null);
    if (!isCurrent()) return;
    const firstOwner = (view?.roots as DecodedMessage[] | undefined)?.find(message => message.sender === 'owner');
    state.boardFirst = firstOwner ? firstLine(firstOwner.text) : null;
    state.boardRoots = ((view?.roots as DecodedMessage[] | undefined) ?? [])
      .filter(message => message.sender === 'owner')
      .map(message => ({ at: Date.parse(message.time), line: firstLine(message.text) }))
      .filter(root => root.line && Number.isFinite(root.at))
      .sort((a, b) => a.at - b.at);
  } else {
    state.boardFirst = null;
    state.boardRoots = [];
  }
  renderResults();
}

async function loadView(): Promise<void> {
  if (!state.project || !state.channel) return;
  const { id: projectId } = state.project;
  const channel = state.channel.id;
  const sessionId = boardSessionId();
  const view = await api.teamView({ projectId, sessionId, channel });
  if (state.project?.id !== projectId || state.channel?.id !== channel || boardSessionId() !== sessionId) return;
  state.roots = view.roots as DecodedMessage[];
  state.replies = view.replies as Record<string, DecodedMessage[]>;
  renderSidebar();
  renderHeader();
  renderStream();
}

/** 独立会话窗口按 hash 里的项目绑定；跨项目移动后由 session:moved 就地重绑。 */
async function bindSessionWindow(): Promise<void> {
  const project = state.projects.find(item => item.id === SESSION_WINDOW!.projectId);
  if (!project) {
    showWelcome();
    return;
  }
  state.project = project;
  await loadTeam();
  state.channel = state.team?.channels.find(item => item.kind === 'channel') ?? null;
  renderProjects();
  const session = state.sessions.find(item => item.id === SESSION_WINDOW!.sessionId);
  if (session) {
    document.title = `蜂群 · ${session.member_label}`;
    await openRuns(session.id, roundsOf(session.id).at(-1)?.id ?? null);
  } else {
    showWelcome();
  }
}

/** 独立窗口里拖动标题栏身份区，拖到主窗口上方松手即塞回；主进程按 OS 光标是否在主窗内判定。 */
function bindSessionDragBack(): void {
  const handle = $('.topbar .identity');
  handle.draggable = true;
  handle.classList.add('dragback-handle');
  handle.title = '拖回主窗口松手，把这条会话塞回去';
  handle.ondragstart = event => {
    if (!event.dataTransfer || !SESSION_WINDOW) return;
    event.dataTransfer.setData('application/x-swarm-reattach', SESSION_WINDOW.sessionId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setDragImage(showDragCard(document.title.replace('蜂群 · ', ''), '拖到主窗口上方松手塞回'), 24, 20);
    api.sessionDragback('start', SESSION_WINDOW.sessionId);
  };
  handle.ondragend = () => {
    clearDragCard();
    if (SESSION_WINDOW) api.sessionDragback('end', SESSION_WINDOW.sessionId);
  };
}

async function boot(): Promise<void> {
  state.catalog = await api.catalog();
  if (state.catalog?.error) toast(`宿主目录读取失败：${state.catalog.error}`);
  state.projects = await api.listProjects();
  renderProjects();
  bindControls();
  bindEvents();
  try {
    const railW = Number(localStorage.getItem('swarm.railW'));
    if (railW >= 180 && railW <= 420) $('.app').style.setProperty('--rail-w', `${railW}px`);
    const inspW = Number(localStorage.getItem('swarm.inspW'));
    if (inspW >= 240 && inspW <= 640) $('#inspector').style.width = `${inspW}px`;
  } catch {
    // 读不到就用默认宽度
  }
  try {
    if (!INSPECTOR_WINDOW && !SESSION_WINDOW && localStorage.getItem('swarm.sidebarCollapsed') === '1') setSidebarCollapsed(true);
  } catch {
    // 读不到就保持展开
  }
  try {
    const homeDraft = draftStorage.getItem(HOME_DRAFT_KEY);
    if (homeDraft) $<HTMLTextAreaElement>('#home-prompt').value = homeDraft;
  } catch {
    // 首页草稿读不到就从空开始
  }
  window.addEventListener('beforeunload', () => {
    saveDraft();
    saveHomeDraft();
  });
  if (SESSION_WINDOW) {
    document.title = '蜂群 · 会话';
    $('.app').classList.add('session-window');
    await bindSessionWindow();
    $('#session-reattach').hidden = false;
    bindSessionDragBack();
    void refreshNativeModels();
    return;
  }
  if (INSPECTOR_WINDOW) {
    document.title = '蜂群 · 侧栏';
    $('.app').classList.add('inspector-window');
    state.inspectorOpen = true;
    renderInspectorVisibility();
    api.inspectorReady(INSPECTOR_WINDOW_ID);
    return;
  }
  quotaPanel.start();
  // 自由对话容器常驻：没有就让主进程建一个空盒子，侧栏永远有地方放未归属会话。
  if (!state.projects.some(project => project.kind === 'inbox')) {
    await api.defaultProject();
    state.projects = await api.listProjects();
  }
  await refreshRecent();
  // 启动落在最近用过的真实项目上；没接过目录就直接进自由对话。
  const firstProject = state.projects.find(project => project.kind !== 'inbox') ?? state.inbox;
  if (firstProject) {
    state.project = firstProject;
    state.expandedProjects.add(firstProject.id);
    await loadTeam();
    state.channel = state.team?.channels.find(item => item.kind === 'channel') ?? null;
    renderProjects();
  }
  showHome();
  void refreshNativeModels();
}

function showHome(): void {
  closeThread();
  closeSearch();
  closeConversationMenu();
  closeShare();
  $('#search-bar').hidden = true;
  $('#round-nav').hidden = true;
  $('#share-conversation').hidden = true;
  $('#topbar-search').hidden = true;
  $('#runs-panel').hidden = true;
  $('#collaboration').hidden = true;
  closeSessionPop();
  $('#home').hidden = false;
  $('.app').classList.add('home-mode');
  renderHomeControls();
  renderSidebar();
  renderInspectorVisibility();
  broadcastMainContext();
  reportInspectorState();
  $('#home-prompt').focus();
}

function setRailSearch(open: boolean): void {
  if (open && $('.app').classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
  $('#rail-search-bar').hidden = !open;
  $('#rail-search').setAttribute('aria-pressed', String(open));
  const input = $<HTMLInputElement>('#rail-search-input');
  if (open) {
    input.focus();
    input.select();
  } else {
    input.value = '';
    if (state.railQuery) {
      state.railQuery = '';
      renderConversations();
    }
  }
}

function renderHomeControls(): void {
  const hostSelect = $<HTMLSelectElement>('#home-host');
  const ready = state.catalog?.hosts.filter(host => host.adapter && host.ready) ?? [];
  const previous = hostSelect.value;
  hostSelect.replaceChildren();
  for (const host of ready) hostSelect.add(new Option(host.name, host.name));
  if (!ready.length) hostSelect.add(new Option('未连接宿主', ''));
  const preferred = [previous, ...state.sessions.map(session => session.host)]
    .find(name => ready.some(host => host.name === name));
  if (preferred) hostSelect.value = preferred;
  hostSelect.disabled = !ready.length;
  syncHomeModels();
}

function syncHomeModels(): void {
  const host = $<HTMLSelectElement>('#home-host').value;
  const modelSelect = $<HTMLSelectElement>('#home-model');
  const previous = modelSelect.value;
  const session = state.sessions.find(item => item.host === host);
  fillModelSelect(modelSelect, host, previous || session?.model || '');
  syncHomeEffort(previous && previous === modelSelect.value
    ? $<HTMLSelectElement>('#home-effort').value : preferredEffort(host, session));
}

function syncHomeEffort(effort = ''): void {
  const host = $<HTMLSelectElement>('#home-host').value;
  const model = $<HTMLSelectElement>('#home-model').value;
  fillEffortSelect($<HTMLSelectElement>('#home-effort'), host, model, effort);
  modelPicker.refresh('home-model-picker');
}

async function startHomeTask(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const field = $<HTMLTextAreaElement>('#home-prompt');
  const goal = field.value.trim();
  if (!goal) return;
  const button = $<HTMLButtonElement>('#home-send');
  if (button.disabled) return;
  const host = $<HTMLSelectElement>('#home-host').value;
  const model = $<HTMLSelectElement>('#home-model').value;
  const effort = $<HTMLSelectElement>('#home-effort').value;
  if (!host) {
    openMemberDialog();
    return;
  }
  button.disabled = true;
  try {
    const project: ProjectView = await api.defaultProject();
    state.projects = await api.listProjects();
    await selectProject(project);
    // 每个新任务都开一条新会话（新任务组），成员会话下拉只列同组会话。
    const member = await api.createSession({ projectId: project.id, memberLabel: host, host, model, effort }) as SessionView;
    await loadTeam();
    await openRuns(member.id, null);
    const modelSelect = $<HTMLSelectElement>('#model-select');
    if (!modelSelect.disabled) modelSelect.value = model;
    syncEffort(host, modelSelect.value, effort);
    const composer = $<HTMLTextAreaElement>('#run-prompt');
    composer.value = goal;
    if (project.kind !== 'inbox') await postBoardFirst(project.id, member.id, goal);
    await sendRun();
    if (!composer.value) {
      field.value = '';
      saveHomeDraft();
    }
    renderConversations();
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button.disabled = false;
  }
}

async function selectProject(project: ProjectView): Promise<void> {
  saveDraft();
  transcriptRequest += 1;
  pushNav(project.id, null);
  state.expandedProjects.add(project.id);
  delete state.projectSessions[project.id];
  state.project = project;
  state.sessions = [];
  state.runs = [];
  state.team = null;
  state.runSession = null;
  state.selectedRun = null;
  state.artifacts = [];
  state.running = null;
  state.live.clear();
  state.channel = null;
  state.roots = [];
  state.replies = {};
  state.inspectorSession = null;
  state.inspArtifacts = [];
  state.inspRunning = null;
  state.boardFirst = null;
  state.boardRoots = [];
  closeThread();
  closeSearch();
  closeShare();
  closeConversationMenu();
  showWelcome();
  renderProjects();
  broadcastMainContext();
  reportInspectorState();
  await loadTeam();
  if (state.project.id !== project.id) return;
  const channel = state.team?.channels.find(item => item.kind === 'channel') ?? null;
  state.channel = channel;
  if (state.runs.length) await openRuns(state.runs[0].session_id, state.runs[0].id);
  else if (state.sessions.length) await openRuns(state.sessions[0].id, null);
  else {
    showWelcome();
  }
}

async function selectChannel(channel: ChannelView, options: { skipState?: boolean } = {}): Promise<void> {
  showView('team');
  state.channel = channel;
  state.openReplyRoot = null;
  if (!options.skipState) await loadTeam();
  closeThread();
  await loadView();
}

// ---------------------------------------------------------------- 讨论串

async function openThread(rootId: string): Promise<void> {
  if (!state.project) return;
  const threadKey = inspectorKey({ mode: 'thread', projectId: state.project.id, rootId });
  const conflict = findOccupiedByKey(otherOccupiedItems(), threadKey);
  if (conflict) {
    void api.inspectorFocus(threadKey);
    toast('该讨论串已在独立窗口打开');
    return;
  }
  const projectId = state.project.id;
  const sessionId = boardSessionId();
  const thread = await api.teamThread({ projectId, sessionId, rootId });
  if (state.project?.id !== projectId || boardSessionId() !== sessionId) return;
  if (!thread) {
    toast('这条消息不在当前频道里');
    return;
  }
  const select = $('#dispatch-target') as HTMLSelectElement;
  const previousTarget = state.threadRootId === rootId ? select.value : '';
  state.thread = thread as { root: DecodedMessage; replies: DecodedMessage[] };
  state.threadRootId = rootId;
  const topic = state.channel?.kind === 'channel' && !state.channel.main ? state.channel : undefined;
  $<HTMLTextAreaElement>('#thread-input').disabled = Boolean(topic?.archived);
  $<HTMLButtonElement>('#thread-send').disabled = Boolean(topic?.archived);
  $<HTMLButtonElement>('#dispatch-send').disabled = Boolean(topic?.archived);
  setInspMode('thread');
  setInspectorOpen(true);
  $('#thread-sub').textContent = `回复串 · 根留言来自 ${state.thread.root.senderLabel} · ${state.thread.root.time.slice(0, 16).replace('T', ' ')}`;
  // 回复入口说清对象：回到这条根留言所在的串，不新开一条。
  $<HTMLTextAreaElement>('#thread-input').placeholder =
    `回复 ${state.thread.root.senderLabel} 这条留言（Ctrl+Enter，发出后回到同一串）`;
  const body = $('#thread-body');
  body.innerHTML = '';
  body.append(messageBlock(state.thread.root, { compact: true }));
  for (const reply of state.thread.replies) body.append(messageBlock(reply, { compact: true }));
  if (!state.thread.replies.length) body.append(el('div', 'muted', '还没有回复。可以在这里回复，或派给某个成员执行。'));

  select.innerHTML = '';
  const dmMember = state.channel?.memberId;
  const selfId = state.runSession?.id ?? '';
  // 派工目标：本任务的完整成员名单里，排除当前这条会话自己。
  const candidates = topic ? state.sessions.filter(item => topic.memberIds?.includes(item.id)) : taskMembers();
  for (const session of candidates.filter(item =>
    item.id !== selfId && (!dmMember || item.id === dmMember) && hostEnabled(item.host))) {
    const option = el('option', '', session.member_label);
    option.value = session.id;
    select.append(option);
  }
  if (previousTarget && [...select.options].some(option => option.value === previousTarget)) select.value = previousTarget;
  body.scrollTop = body.scrollHeight;
}

function closeThread(): void {
  state.thread = null;
  state.threadRootId = null;
  if (state.inspMode === 'thread') setInspMode(state.inspectorSession ? 'session' : 'files');
  else reportInspectorState();
}

async function replyThread(): Promise<void> {
  if (!state.project || !state.threadRootId) return;
  const input = $('#thread-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  const rootId = state.threadRootId;
  const button = $<HTMLButtonElement>('#thread-send');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api.teamPost({ projectId: state.project.id, sessionId: boardSessionId(), text, thread: rootId });
    if (state.threadRootId !== rootId) return;
    input.value = '';
    await loadTeam();
    if (state.threadRootId === rootId) await openThread(rootId);
    await loadView();
  } catch (error) {
    toast(`回复失败：${(error as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

async function dispatch(): Promise<void> {
  if (!state.project || !state.threadRootId || !state.thread) return;
  const target = ($('#dispatch-target') as HTMLSelectElement).value;
  if (!target) {
    toast('先添加一个宿主成员');
    return;
  }
  const input = $('#thread-input') as HTMLTextAreaElement;
  const text = input.value.trim() || '请阅读关联留言，并在原帖下回复。';
  try {
    await api.teamDispatch({ projectId: state.project.id, sessionId: boardSessionId(), memberId: target, text, thread: state.threadRootId });
    input.value = '';
    await loadTeam();
    await openThread(state.threadRootId);
    await loadView();
    toast('已派工，正在按真实宿主启动');
  } catch (error) {
    toast(`派工失败：${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------- 共享板

function renderBoard(): void {
  const body = $('#board-body');
  body.innerHTML = '';
  const board = state.team?.board ?? {};
  const entries = Object.entries(board);
  if (!entries.length) {
    body.append(el('div', 'muted', '共享板为空。成员可以用 swarm_board_write 按版本号写入。'));
    return;
  }
  for (const [key, value] of entries) {
    const row = el('div', 'board-row');
    row.append(el('div', 'board-key', `${key} · v${value.version}`), el('div', 'board-value', value.value), el('div', 'muted', value.updated.slice(0, 16).replace('T', ' ')));
    body.append(row);
  }
}

let publicBoardLoading = false;

async function renderPublicBoard(): Promise<void> {
  if (!state.project || publicBoardLoading) return;
  publicBoardLoading = true;
  const feedBox = $('#public-board-feed');
  const toggle = $<HTMLInputElement>('#public-board-monitor-toggle');
  try {
    const data = (await api.teamPublicBoard({ projectId: state.project.id, sessionId: state.runSession?.id })) as {
      stallMonitorEnabled: boolean;
      messages: Array<{
        id: string;
        channelName: string;
        sender: string;
        senderLabel: string;
        host: string;
        model: string;
        toLabel: string;
        text: string;
        time: string;
        replyToLabel?: string;
        replyPreview?: string;
        hint?: string;
      }>;
    };
    toggle.checked = Boolean(data.stallMonitorEnabled);
    feedBox.replaceChildren();
    if (!data.messages.length) {
      feedBox.append(el('div', 'muted', '暂无过程动态。成员发言或派工后会像群聊一样按时间顺序出现在这里。'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) {
      const isOwner = msg.sender === 'owner';
      const row = el('div', `qq-row${isOwner ? ' is-owner' : ''}`);
      const avatar = el('img', 'qq-avatar');
      avatar.alt = msg.senderLabel;
      avatar.src = resolveMemberAvatar({
        targetKey: msg.sender,
        sender: msg.sender,
        host: msg.host,
        model: msg.model,
        label: msg.senderLabel,
      }).url;
      const col = el('div', 'qq-col');
      const meta = el('div', 'qq-meta');
      meta.append(
        el('span', 'qq-name', msg.senderLabel),
        el('span', '', msg.time.slice(11, 19)),
      );
      col.append(meta);
      if (msg.replyToLabel || msg.hint) {
        const hintText = msg.replyToLabel
          ? `回复 ${msg.replyToLabel}：${msg.replyPreview ?? ''}`
          : msg.hint ?? '';
        if (hintText) col.append(el('div', 'qq-hint', hintText));
      }
      col.append(el('div', 'qq-bubble', msg.text));
      row.append(avatar, col);
      frag.append(row);
    }
    feedBox.append(frag);
    feedBox.scrollTop = feedBox.scrollHeight;
  } catch (error) {
    feedBox.replaceChildren(el('div', 'muted', `加载失败：${(error as Error).message}`));
  } finally {
    publicBoardLoading = false;
  }
}

// ---------------------------------------------------------------- 执行记录

function saveDraft(): void {
  if (state.runSession) drafts.set(state.runSession.id, $<HTMLTextAreaElement>('#run-prompt').value);
}

let runDraftTimer: number | null = null;

function scheduleRunDraft(): void {
  if (runDraftTimer) window.clearTimeout(runDraftTimer);
  runDraftTimer = window.setTimeout(() => {
    runDraftTimer = null;
    saveDraft();
  }, 300);
}

function showWelcome(): void {
  showView('task');
  $('#runs-panel').classList.add('task-start');
  $('#task-composer').hidden = true;
  const welcome = el('div', 'welcome');
  welcome.append(el('h1', '', state.project ? '添加工作成员' : '打开工作区'));
  welcome.append(el('p', '', state.project ? '选择一个宿主，开始在当前目录工作。' : '选择项目所在的本地目录。'));
  const button = el('button', 'primary', state.project ? '添加成员' : '选择工作区');
  button.onclick = () => $(state.project ? '#add-member' : '#pick-workspace').click();
  welcome.append(button);
  $('#transcript').replaceChildren(welcome);
}

async function openRuns(memberId: string, runId?: string | null): Promise<void> {
  const session = state.sessions.find(item => item.id === memberId);
  if (!session) {
    toast('这个成员没有会话');
    return;
  }
  const request = ++transcriptRequest;
  saveDraft();
  const [artifacts, entries]: [ArtifactView[], TranscriptEntry[]] = await Promise.all([
    api.listArtifacts(session.id), api.conversationTurns(session.id),
  ]);
  const selectedRun = runId ?? entries.at(-1)?.run.id ?? null;
  if (request !== transcriptRequest) return;
  const previousBoardSession = boardSessionId();
  const previousGroup = state.runSession?.group_id;
  state.runSession = session;
  const boardChanged = previousBoardSession !== boardSessionId();
  if (boardChanged && (!previousGroup || previousGroup === session.project_id || previousGroup !== session.group_id)) {
    state.channel = null;
    state.roots = [];
    state.replies = {};
    state.boardFirst = null;
    state.boardRoots = [];
    state.openReplyRoot = null;
    closeThread();
    renderStream();
  }
  // 一个成员只占一个栏位：中央换成谁，右侧若正停着同一个就腾出位置。
  if (state.inspectorSession?.id === session.id) {
    state.inspectorSession = null;
    state.inspArtifacts = [];
    state.inspRunning = null;
    if (state.inspMode === 'session') setInspMode('files');
  }
  state.artifacts = artifacts;
  const active = state.runs.find(run => run.session_id === session.id && run.status === 'running');
  state.selectedRun = selectedRun;
  state.running = active?.id ?? null;
  $<HTMLTextAreaElement>('#run-prompt').value = drafts.get(session.id) ?? '';
  $('#task-composer').hidden = false;
  syncModelControls(session);
  const container = $('#transcript');
  $('#runs-panel').classList.toggle('task-start', !entries.length);
  clearTranscript(container);
  for (const entry of entries) renderStaticTurn(entry, container, session, artifacts);
  if (!entries.length) {
    const welcome = el('div', 'welcome');
    welcome.append(el('h1', '', '新建任务'));
    const members = el('div', 'member-pills');
    for (const item of taskMembers()) {
      const member = el('button', 'ghost', item.member_label);
      member.setAttribute('aria-pressed', String(item.id === memberId));
      member.onclick = () => void openRuns(item.id, null);
      members.append(member);
    }
    welcome.append(members);
    container.append(welcome);
  }
  showView('task');
  container.scrollTop = container.scrollHeight;
  if (runId && runId !== entries.at(-1)?.run.id) jumpToRun(runId);
  if (state.search?.query) applySearchHighlight();
  updateComposer();
  renderInspectorSessionHead();
  broadcastMainContext();
  reportInspectorState();
  if (boardChanged) await loadTeam();
}

function syncModelControls(session: SessionView): void {
  const modelSelect = $<HTMLSelectElement>('#model-select');
  fillModelSelect(modelSelect, session.host, session.model, session.model);
  syncEffort(session.host, modelSelect.value, preferredEffort(session.host, session));
}

const AGY_FLASH = 'gemini-3.8-flash';

function selectableModel(host: string, model: string): string {
  return host === 'Antigravity' && model.startsWith(AGY_FLASH + '-') ? AGY_FLASH : model;
}

function preferredEffort(host: string, session?: SessionView): string {
  if (session && selectableModel(host, session.model) !== session.model) return session.model.slice(AGY_FLASH.length + 1);
  return session?.effort ?? '';
}

function detailsFor(host: string, model: string): ModelDetails | undefined {
  return nativeModelCatalogs[host]?.modelDetails[model] ?? state.catalog?.modelDetails?.[host]?.[model];
}

function multiplier(detail?: ModelDetails): string {
  const rate = detail?.creditMultiplier;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? `${rate}×` : '';
}

const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const modelPicker = createModelPicker((host, model) => {
  const info = detailsFor(host, model);
  const windows = info?.contextWindows ?? [];
  const capacity: [string, string][] = [];
  if (info?.contextWindow) capacity.push(['默认上下文', `${info.contextWindow.toLocaleString()} tokens`]);
  if (windows.length > 1) capacity.push(['上下文规格', windows.map(value => compactTokens.format(value)).join(' / ')]);
  else if (info?.maxInputTokens && info.maxInputTokens !== info.contextWindow) {
    capacity.push(['输入上限', `${info.maxInputTokens.toLocaleString()} tokens`]);
  }
  return { rate: multiplier(info), capacity, efforts: effortOptions(host, model),
    initialEffort: initialEffort(host, model) };
});

function fillModelSelect(select: HTMLSelectElement, host: string, current: string, fallback = ''): void {
  const models = nativeModelCatalogs[host]?.models ?? state.catalog?.models?.[host] ?? [];
  current = selectableModel(host, current);
  select.replaceChildren();
  select.disabled = !models.length;
  if (!models.length) select.add(new Option('宿主默认模型', fallback));
  for (const [label, value] of models) select.add(new Option(label, value));
  if (models.some(([, value]) => value === current)) select.value = current;
}

function thoughtLevels(host: string, model: string): string[] {
  return nativeModelCatalogs[host]?.thoughtLevels[model] ?? state.catalog?.thoughtLevels?.[host]?.[model] ?? [];
}

const EFFORT_LABELS: Record<string, string> = {
  off: '关闭', none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高',
  xhigh: '很高', max: '最高', ultra: 'Ultra', enabled: '开启',
};

function effortOptions(host: string, model: string): [string, string][] {
  return thoughtLevels(host, model).filter(Boolean).map(level => [level, EFFORT_LABELS[level] ?? level]);
}

function initialEffort(host: string, model: string): string {
  const levels = thoughtLevels(host, model).filter(Boolean);
  const preferred = detailsFor(host, model)?.defaultEffort;
  if (preferred && levels.includes(preferred)) return preferred;
  return levels.find(level => level === 'medium' || level === 'enabled') ??
    levels.find(level => level === 'low') ?? levels[0] ?? '';
}

function fillEffortSelect(select: HTMLSelectElement, host: string, model: string, current: string): void {
  const options = effortOptions(host, model);
  select.replaceChildren(...options.map(([key, label]) => new Option(label, key)));
  select.disabled = options.length === 0;
  select.value = options.some(([key]) => key === current) ? current : initialEffort(host, model);
}

function syncEffort(host: string, model: string, current: string): void {
  fillEffortSelect($<HTMLSelectElement>('#effort-select'), host, model, current);
  modelPicker.refresh('run-model-picker');
}

function updateComposer(): void {
  const send = $('#run-send') as HTMLButtonElement;
  const stop = $('#run-stop') as HTMLButtonElement;
  const prompt = $('#run-prompt') as HTMLTextAreaElement;
  const disabled = state.runSession && !hostEnabled(state.runSession.host);
  const canSend = Boolean(state.runSession && state.project) && !state.running && !disabled;
  send.disabled = !canSend;
  stop.hidden = !state.running;
  prompt.disabled = !state.runSession || Boolean(state.running);
  $('#run-hint').textContent = disabled ? '宿主已停用 · 可在设置中开启' : state.runSession
    ? `${state.runSession.host}${state.runSession.host_session_id ? ' · 续接原会话' : ' · 新会话'}`
    : '先选一个成员';
}

async function sendRun(): Promise<void> {
  if (!state.runSession || !state.project) return;
  if (!hostEnabled(state.runSession.host)) return toast('此宿主已停用，可从设置开启');
  const promptBox = $('#run-prompt') as HTMLTextAreaElement;
  const prompt = promptBox.value.trim();
  if (!prompt) return;
  const modelSelect = $('#model-select') as HTMLSelectElement;
  const effortSelect = $('#effort-select') as HTMLSelectElement;
  const request = {
    projectId: state.project.id,
    sessionId: state.runSession.id,
    prompt,
    model: modelSelect.value,
    effort: effortSelect.value,
  };
  state.running = 'pending';
  updateComposer();
  try {
    const run = await api.startRun(request);
    drafts.delete(request.sessionId);
    if (state.runSession?.id === request.sessionId) {
      promptBox.value = '';
      if (state.running === 'pending') state.running = run.id;
    }
  } catch (error) {
    if (state.runSession?.id === request.sessionId && state.running === 'pending') state.running = null;
    toast(`发起失败：${(error as Error).message}`);
  } finally {
    updateComposer();
  }
}

// ---------------------------------------------------------------- 回合渲染（执行记录）

function buildTurnShell(run: Any, session: SessionView): LiveTurn {
  const root = el('div', 'turn agent chat-turn');
  root.dataset.runId = run.id;
  const avatar = avatarButton({
    targetKey: session.id,
    host: session.host,
    model: run.model || session.model,
    label: session.member_label,
  });
  const col = el('div', 'chat-col');
  const head = el('div', 'chat-meta agent-head');
  head.append(
    el('span', 'name', session.member_label),
    el('span', 'chat-sub', `${session.host} · ${run.model || session.model}`),
    el('span', 'status running', '执行中'),
  );
  const card = el('div', 'agent-card');

  const thinking = el('details', 'thinking') as HTMLDetailsElement;
  const thinkingLabel = el('summary', '', '思考过程');
  const thinkingBody = el('div', 'thinking-body');
  thinking.append(thinkingLabel, thinkingBody);
  thinking.hidden = true;

  const activity = el('details', 'thinking');
  const progress = el('div', 'progress');
  activity.append(el('summary', '', '执行过程'), progress);
  activity.hidden = true;
  const body = el('div', 'body-text');
  const usage = el('div', 'muted');
  usage.hidden = true;
  const artifacts = el('div', 'artifacts');
  artifacts.hidden = true;

  card.append(thinking, activity, body, artifacts, usage);
  col.append(head, card);
  root.append(avatar, col);
  return { root, thinking, thinkingLabel, thinkingBody, thinkingText: '', usageData: {}, progress, activity, body, status: head.querySelector('.status') as HTMLElement, usage, artifacts };
}

function renderUsage(live: LiveTurn, usage: Any): void {
  for (const key of ['context_used', 'context_size', 'input_tokens', 'output_tokens', 'reasoning_tokens']) {
    if (typeof usage?.[key] === 'number') live.usageData[key] = usage[key];
  }
  const { context_used: used, context_size: size, input_tokens: input, output_tokens: output, reasoning_tokens: thought } = live.usageData;
  const hasTokenCounts = input > 0 || output > 0;
  const fields = [
    typeof used === 'number' ? `宿主上下文 ${used.toLocaleString()}${size > 0 ? ` / ${size.toLocaleString()}` : ''}`
      : size > 0 ? `宿主上下文容量 ${size.toLocaleString()} tokens` : '',
    hasTokenCounts && typeof input === 'number' ? `输入 ${input.toLocaleString()} tokens` : '',
    hasTokenCounts && typeof output === 'number' ? `输出 ${output.toLocaleString()} tokens` : '',
    thought > 0 ? `思考 ${thought.toLocaleString()} tokens` : '',
  ].filter(Boolean);
  if (!fields.length) return;
  live.usage.textContent = fields.join(' · ');
  live.usage.hidden = false;
}

function shortPath(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function summariseTool(payload: Any): string {
  if (!payload || typeof payload !== 'object') return '工具事件';
  const type = String(payload.event_type ?? 'tool');
  const tool = String(payload.tool_name ?? '');
  const params = (payload.parameters_summary ?? {}) as Any;
  const raw = params.raw_input ?? {};
  const rawOutput = params.raw_output;
  const command = params.command ?? raw?.command;
  const args = params.args ?? raw?.args;
  const filePath = raw?.file_path ?? raw?.path;
  let target = '';
  if (command) target = [command, ...(Array.isArray(args) ? args : [])].join(' ');
  else if (filePath) target = shortPath(String(filePath));
  else if (raw?.pattern) target = String(raw.pattern);
  else if (rawOutput && typeof rawOutput === 'object' && rawOutput.text) target = String(rawOutput.text).split('\n')[0].slice(0, 100);

  const written = raw?.content !== undefined || /edit|write|create|patch/i.test(tool);
  const action = written ? '写入' : /read/i.test(tool) ? '读取' : /terminal|execute|bash|shell/i.test(tool) || command ? '运行' : /grep|search|glob/i.test(tool) ? '检索' : '调用';
  const phase = type === 'tool_started' ? '进行中' : type === 'tool_completed' ? '完成' : type === 'tool_failed' ? '失败' : '状态未知';
  return `${action}${target ? ` ${target}` : ''} · ${phase}`;
}

function addProgress(live: LiveTurn, text: string, failed = false): void {
  const last = live.progress.lastElementChild?.textContent;
  if (last === `•${text}` || last === text) return;
  live.activity.hidden = false;
  const item = el('div', 'progress-item');
  item.append(el('span', 'dot', '•'));
  const content = el('span', '', text);
  if (failed) content.classList.add('fail');
  item.append(content);
  live.progress.append(item);
  live.progress.scrollTop = live.progress.scrollHeight;
}

function addArtifacts(live: LiveTurn, artifacts: ArtifactView[]): void {
  if (!artifacts.length) return;
  live.artifacts.hidden = false;
  for (const artifact of artifacts) {
    const chip = el('div', 'artifact');
    chip.append(el('span', 'check', artifact.verified ? '✓' : '?'), el('span', '', artifact.name), el('span', 'size', bytes(artifact.size)));
    chip.title = artifact.path;
    chip.onclick = async () => {
      const result = await api.openArtifact(artifact.path);
      if (!result.ok) toast(result.message);
    };
    chip.oncontextmenu = event => {
      event.preventDefault();
      void api.revealArtifact(artifact.path);
    };
    live.artifacts.append(chip);
  }
}

function clearTranscript(container: HTMLElement): void {
  for (const [id, live] of state.live) {
    if (container.contains(live.root) || !live.root.isConnected) state.live.delete(id);
  }
  container.replaceChildren();
}

function appendRunPrompt(container: HTMLElement, run: { id: string; prompt: string }): void {
  const prompt = promptNode(run.prompt);
  prompt.dataset.runId = run.id;
  container.append(prompt);
}

function jumpToRun(runId: string): void {
  const turn = $('#transcript').querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
  if (!turn) return;
  state.selectedRun = runId;
  turn.scrollIntoView({ block: 'start' });
  renderRoundNav();
}

function renderStaticTurn(entry: TranscriptEntry, container: HTMLElement, session: SessionView, artifacts: ArtifactView[]): void {
  const run = entry.run as Any;
  if (!session) return;
  appendRunPrompt(container, run);

  const live = buildTurnShell(run, session);
  const thinkingParts: string[] = [];
  const progressParts: { text: string; failed: boolean }[] = [];
  const bodyParts: string[] = [];
  let hostSession = '';
  for (const event of entry.events) {
    let payload: Any = null;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = event.payload;
    }
    switch (event.kind) {
      case 'reasoning':
        if (typeof payload === 'string') thinkingParts.push(payload);
        break;
      case 'chunk':
        if (typeof payload === 'string') bodyParts.push(payload);
        break;
      case 'notice':
        if (typeof payload === 'string') progressParts.push({ text: payload, failed: false });
        break;
      case 'execution_event':
        progressParts.push({ text: summariseTool(payload), failed: String(payload?.event_type ?? '').includes('failed') });
        break;
      case 'session':
        if (typeof payload === 'string') hostSession = payload;
        break;
      case 'usage':
        renderUsage(live, payload);
        break;
      case 'error':
        progressParts.push({ text: String(payload?.message ?? '执行失败'), failed: true });
        break;
      default:
        break;
    }
  }
  if (thinkingParts.join('').trim()) {
    live.thinking.hidden = false;
    live.thinkingText = thinkingParts.join('');
    live.thinkingBody.textContent = live.thinkingText;
    live.thinkingLabel.textContent = `思考过程 · ${live.thinkingText.length} 字`;
  }
  for (const part of progressParts) addProgress(live, part.text, part.failed);
  const text = run.reply_text || bodyParts.join('');
  if (run.status === 'running') live.body.textContent = text;
  else renderReply(live.body, text);
  live.status.className = `status ${run.status}`;
  live.status.textContent =
    run.status === 'done' ? `完成 · ${run.seconds}s` : RUN_LABEL[run.status] ?? '中断';
  if (run.status === 'running') state.live.set(run.id, live);
  if (run.error) live.root.querySelector('.agent-card')?.append(el('div', 'notice-error', run.error));
  if (hostSession) live.status.title = `宿主会话 ${hostSession}`;
  addArtifacts(live, artifacts.filter(artifact => artifact.run_id === run.id));
  container.append(live.root);
}

// ---------------------------------------------------------------- 事件

function scheduleRefresh(): void {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void loadTeam()
      .then(() => loadView())
      .then(() => (state.threadRootId && state.inspMode === 'thread' ? openThread(state.threadRootId) : undefined));
  }, 400);
}

function bindControls(): void {
  $('#result-inbox-open').addEventListener('click', openResultInbox);
  $('#result-inbox-close').addEventListener('click', () => {
    resultInboxScope = null;
    $('#result-inbox-dialog').hidden = true;
  });
  $('#result-inbox-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') $('#result-inbox-close').click();
  });
  $('#result-inbox-more').addEventListener('click', () => void readResultInbox());
  $('#channel-new').addEventListener('click', () => openChannelDialog());
  $('#channel-invite').addEventListener('click', () => {
    if (state.channel?.kind === 'channel' && !state.channel.main) openChannelDialog(state.channel);
  });
  $('#channel-archive').addEventListener('click', () => void toggleChannelArchive());
  $('#channel-archived').addEventListener('click', () => {
    showArchivedChannels = !showArchivedChannels;
    renderChannelBar();
  });
  $('#channel-cancel').addEventListener('click', () => {
    channelDialog = null;
    $('#channel-dialog').hidden = true;
  });
  $('#channel-form').addEventListener('submit', event => {
    event.preventDefault();
    void saveChannel();
  });
  $('#channel-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      channelDialog = null;
      $('#channel-dialog').hidden = true;
    }
  });
  modelPicker.bind('home-model-picker', {
    model: $<HTMLSelectElement>('#home-model'), effort: $<HTMLSelectElement>('#home-effort'),
    host: () => $<HTMLSelectElement>('#home-host').value,
    edge: 'below', composer: $('.home-composer'),
  });
  modelPicker.bind('run-model-picker', {
    model: $<HTMLSelectElement>('#model-select'), effort: $<HTMLSelectElement>('#effort-select'),
    host: () => state.runSession?.host ?? '',
    edge: 'above', composer: $('#task-composer'),
  });
  modelPicker.bind('member-model-picker', {
    model: $<HTMLSelectElement>('#member-model'), effort: $<HTMLSelectElement>('#member-effort'),
    host: () => $<HTMLSelectElement>('#member-host').value,
  });
  $<HTMLFormElement>('#home-form').addEventListener('submit', event => void startHomeTask(event));
  $('#home-host').addEventListener('change', () => {
    $<HTMLSelectElement>('#home-model').value = '';
    $<HTMLSelectElement>('#home-effort').value = '';
    syncHomeModels();
  });
  $('#home-model').addEventListener('change', () => syncHomeEffort());
  $<HTMLTextAreaElement>('#home-prompt').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      $<HTMLFormElement>('#home-form').requestSubmit();
    }
  });
  $<HTMLTextAreaElement>('#home-prompt').addEventListener('input', scheduleHomeDraft);
  $<HTMLTextAreaElement>('#run-prompt').addEventListener('input', scheduleRunDraft);
  $('#open-settings').addEventListener('click', () => {
    renderHostSettings();
    void api.getStallMonitor().then(({ enabled }: { enabled: boolean }) => {
      $<HTMLInputElement>('#setting-stall-monitor').checked = Boolean(enabled);
    });
    $('#settings-dialog').hidden = false;
    $('#settings-close').focus();
  });
  $<HTMLInputElement>('#setting-stall-monitor').addEventListener('change', event => {
    const checked = (event.target as HTMLInputElement).checked;
    void api.setStallMonitor(checked).then(({ enabled }: { enabled: boolean }) => {
      $<HTMLInputElement>('#public-board-monitor-toggle').checked = Boolean(enabled);
      toast(`防卡死巡检已${enabled ? '开启' : '关闭'}`);
    });
  });
  $('#settings-close').addEventListener('click', () => {
    $('#settings-dialog').hidden = true;
    $('#open-settings').focus();
  });
  $('#settings-add-agent').addEventListener('click', () => {
    $('#settings-dialog').hidden = true;
    openMemberDialog();
  });
  $('#settings-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') $('#settings-close').click();
  });
  $('#pick-workspace').addEventListener('click', async () => {
    const workspace = await api.pickWorkspace();
    if (!workspace) return;
    const project = await api.createProject({ workspace, name: '' });
    state.projects = await api.listProjects();
    pickInbox();
    await selectProject(project);
    toast(`已接入工作区：${project.workspace}`);
  });

  $('#open-team-builder').addEventListener('click', openTeamDialog);
  $('#team-leader-host').addEventListener('change', syncTeamLeaderModels);
  $('#team-add-member').addEventListener('click', () => addTeamMemberRow());
  $('#team-template-dev').addEventListener('click', templateDevTeam);
  $('#team-cancel').addEventListener('click', () => (($('#team-dialog') as HTMLElement).hidden = true));
  $('#team-launch').addEventListener('click', () => void launchTeam());
  $('#team-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') ($('#team-dialog') as HTMLElement).hidden = true;
  });
  $('#add-member').addEventListener('click', () => openMemberDialog());
  $('#member-cancel').addEventListener('click', () => (($('#member-dialog') as HTMLElement).hidden = true));
  $('#member-create').addEventListener('click', () => void createMember());
  $('#member-path-pick').addEventListener('click', async () => {
    const value = await api.pickHostPath($<HTMLSelectElement>('#member-host').value);
    if (value) $<HTMLInputElement>('#member-path').value = value;
    $('#member-probe-status').textContent = '';
  });
  $('#member-path').addEventListener('input', () => ($('#member-probe-status').textContent = ''));
  $('#member-probe').addEventListener('click', () => void probeMember());

  $('#send').addEventListener('click', () => void sendChannelMessage());
  ($('#prompt') as HTMLTextAreaElement).addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendChannelMessage();
    }
  });

  $('#thread-send').addEventListener('click', () => void replyThread());
  ($('#thread-input') as HTMLTextAreaElement).addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void replyThread();
    }
  });
  $('#dispatch-send').addEventListener('click', () => void dispatch());

  $('#open-board').addEventListener('click', () => {
    renderBoard();
    $('#board-dialog').hidden = false;
  });
  $('#board-close').addEventListener('click', () => ($('#board-dialog').hidden = true));
  $('#open-public-board').addEventListener('click', () => {
    $('#public-board-dialog').hidden = false;
    void renderPublicBoard();
  });
  $('#public-board-refresh').addEventListener('click', () => void renderPublicBoard());
  $('#public-board-close').addEventListener('click', () => ($('#public-board-dialog').hidden = true));
  $('#public-board-dialog').addEventListener('click', event => {
    if (event.target === $('#public-board-dialog')) $('#public-board-dialog').hidden = true;
  });
  $('#public-board-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') $('#public-board-dialog').hidden = true;
  });
  $<HTMLInputElement>('#public-board-monitor-toggle').addEventListener('change', event => {
    const checked = (event.target as HTMLInputElement).checked;
    void api.setStallMonitor(checked).then(({ enabled }: { enabled: boolean }) => {
      $<HTMLInputElement>('#setting-stall-monitor').checked = Boolean(enabled);
      toast(`防卡死巡检已${enabled ? '开启' : '关闭'}`);
    });
  });
  $('#open-runs').addEventListener('click', () => {
    showView('task');
    if ($('#session-pop').hidden) openSessionPop();
    else closeSessionPop();
  });
  $('#open-team').addEventListener('click', () => {
    showView('team');
    void loadView();
  });
  $('#toggle-results').addEventListener('click', toggleResultsPanel);
  $('#topbar-search').addEventListener('click', openSearch);
  $('#new-task').addEventListener('click', showHome);

  // ---- 通用侧栏
  $('#insp-tab-files').addEventListener('click', () => setInspMode('files'));
  $('#insp-tab-preview').addEventListener('click', () => state.preview && setInspMode('preview'));
  $('#insp-tab-session').addEventListener('click', showInspectorSession);
  $('#insp-tab-thread').addEventListener('click', () => state.threadRootId && setInspMode('thread'));
  $('#insp-close').addEventListener('click', () => {
    if (INSPECTOR_WINDOW) api.winClose();
    else setInspectorOpen(false);
  });
  $('#insp-detach').addEventListener('click', () => void detachCurrentInspector());
  $('#insp-swap').addEventListener('click', () => {
    if (!state.inspectorSession) return;
    if (INSPECTOR_WINDOW) api.inspectorSwap(state.inspectorSession.id);
    else void handleSwap(state.inspectorSession.id);
  });
  $('#preview-open').addEventListener('click', async () => {
    if (!state.preview) return;
    const reply = await api.openArtifact(state.preview.path);
    if (!reply.ok) toast(reply.message);
  });
  $('#preview-reveal').addEventListener('click', () => {
    if (state.preview) void api.revealArtifact(state.preview.path);
  });
  $('#insp-send').addEventListener('click', () => void sendInspectorRun());
  ($('#insp-prompt') as HTMLTextAreaElement).addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void sendInspectorRun();
    }
  });
  $('#session-pop-preview').addEventListener('click', () => {
    if (!popPreviewSession) return;
    const session = popPreviewSession;
    closeSessionPop();
    void openRuns(session.id);
  });
  $('#avatar-picker-close').addEventListener('click', closeAvatarPicker);
  $('#avatar-picker-add').addEventListener('click', () => {
    const input = $<HTMLInputElement>('#avatar-file-input');
    input.value = '';
    input.click();
  });
  $<HTMLInputElement>('#avatar-file-input').addEventListener('change', event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !avatarPickerTarget) return;
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = $<HTMLCanvasElement>('#avatar-crop-canvas');
      const size = canvas.width || 200;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      // 竖版立绘默认优先取偏上部（方便直接对准头部），方形/横版居中。
      const baseScale = Math.max(size / iw, size / ih);
      const isTall = ih > iw * 1.25;
      const initialScale = isTall ? 1.8 : 1;
      const drawH = ih * baseScale * initialScale;
      const maxShiftY = Math.max(0, (drawH - size) / 2);
      avatarCrop = {
        img,
        name: file.name.replace(/\.[^.]+$/, '') || '自定义头像',
        scale: initialScale,
        offsetX: 0,
        offsetY: isTall ? maxShiftY * 0.72 : 0,
      };
      $<HTMLInputElement>('#avatar-crop-scale').value = String(initialScale);
      $('#avatar-picker-grid').hidden = true;
      $('#avatar-picker-add').hidden = true;
      $('#avatar-crop-box').hidden = false;
      drawAvatarCrop(canvas, avatarCrop);
      if (avatarPickerAnchor) positionAvatarPicker(avatarPickerAnchor);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      toast('无法读取这张图片，请换一张 PNG / JPG / WebP');
    };
    img.src = objectUrl;
  });
  const cropCanvas = $<HTMLCanvasElement>('#avatar-crop-canvas');
  const cropScale = $<HTMLInputElement>('#avatar-crop-scale');
  cropScale.addEventListener('input', () => {
    if (!avatarCrop) return;
    avatarCrop.scale = Number(cropScale.value) || 1;
    drawAvatarCrop(cropCanvas, avatarCrop);
  });
  cropCanvas.addEventListener('wheel', event => {
    if (!avatarCrop) return;
    event.preventDefault();
    const next = Math.max(1, Math.min(4, avatarCrop.scale + (event.deltaY < 0 ? 0.15 : -0.15)));
    avatarCrop.scale = Number(next.toFixed(2));
    cropScale.value = String(avatarCrop.scale);
    drawAvatarCrop(cropCanvas, avatarCrop);
  }, { passive: false });
  cropCanvas.addEventListener('pointerdown', event => {
    if (!avatarCrop) return;
    event.preventDefault();
    cropCanvas.setPointerCapture(event.pointerId);
    let lastX = event.clientX;
    let lastY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      if (!avatarCrop) return;
      avatarCrop.offsetX += moveEvent.clientX - lastX;
      avatarCrop.offsetY += moveEvent.clientY - lastY;
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      drawAvatarCrop(cropCanvas, avatarCrop);
    };
    const onUp = (upEvent: PointerEvent) => {
      cropCanvas.releasePointerCapture(upEvent.pointerId);
      cropCanvas.removeEventListener('pointermove', onMove);
      cropCanvas.removeEventListener('pointerup', onUp);
      cropCanvas.removeEventListener('pointercancel', onUp);
    };
    cropCanvas.addEventListener('pointermove', onMove);
    cropCanvas.addEventListener('pointerup', onUp);
    cropCanvas.addEventListener('pointercancel', onUp);
  });
  $('#avatar-crop-cancel').addEventListener('click', () => {
    exitAvatarCrop();
    if (avatarPickerAnchor) positionAvatarPicker(avatarPickerAnchor);
  });
  $('#avatar-crop-confirm').addEventListener('click', () => {
    if (!avatarCrop || !avatarPickerTarget) return;
    try {
      const dataUrl = exportAvatarCropDataUrl(avatarCrop);
      const { series } = resolveMemberAvatar(avatarPickerTarget);
      const created = addCustomSeriesAvatar(series.id, avatarCrop.name, dataUrl);
      refreshRenderedAvatars();
      exitAvatarCrop();
      renderAvatarPickerGrid(avatarPickerTarget);
      if (avatarPickerAnchor) positionAvatarPicker(avatarPickerAnchor);
      toast(`已添加到「${series.label}」头像库：${created.name}`);
    } catch (error) {
      toast((error as Error).message);
    }
  });
  document.addEventListener('pointerdown', event => {
    const picker = $('#avatar-picker');
    if (picker.hidden) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('#avatar-picker') || target?.closest?.('button.chat-avatar') || target?.closest?.('.conv-menu')) return;
    closeAvatarPicker();
  }, true);

  document.addEventListener('pointerdown', event => {
    if ($('#session-pop').hidden) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('#session-pop') || target?.closest?.('#open-runs')) return;
    closeSessionPop();
  }, true);

  // ---- 侧栏拖宽（左导航 / 右检查器）
  bindResizer($('#rail-resizer'), {
    read: () => $('.sidebar').getBoundingClientRect().width,
    apply: width => {
      $('.app').style.setProperty('--rail-w', `${width}px`);
      try { localStorage.setItem('swarm.railW', String(width)); } catch { /* 忽略 */ }
    },
    min: 180, max: 420,
  });
  bindResizer($('#inspector-resizer'), {
    invert: true,
    read: () => $('#inspector').getBoundingClientRect().width,
    apply: width => {
      $('#inspector').style.width = `${width}px`;
      try { localStorage.setItem('swarm.inspW', String(width)); } catch { /* 忽略 */ }
    },
    min: 240, max: 640,
  });

  $('#toggle-sidebar').addEventListener('click', () => setSidebarCollapsed(true));
  $('#restore-sidebar').addEventListener('click', () => setSidebarCollapsed(false));
  $('#toggle-archived').addEventListener('click', () => {
    state.archivedVisible = !state.archivedVisible;
    $('#toggle-archived').setAttribute('aria-pressed', String(state.archivedVisible));
    renderConversations();
  });
  $('#toggle-projects-archived').addEventListener('click', () => {
    state.projectsArchivedVisible = !state.projectsArchivedVisible;
    $('#toggle-projects-archived').setAttribute('aria-pressed', String(state.projectsArchivedVisible));
    renderProjects();
  });
  $('#rail-home').addEventListener('click', showHome);
  $('#nav-back').addEventListener('click', () => void applyNav(state.navIndex - 1));
  $('#nav-forward').addEventListener('click', () => void applyNav(state.navIndex + 1));
  $('#rail-search').addEventListener('click', () => setRailSearch($('#rail-search-bar').hidden));
  $('#rail-add-member').addEventListener('click', () => {
    if (state.project) openMemberDialog();
    else $('#pick-workspace').click();
  });
  const railSearchInput = $<HTMLInputElement>('#rail-search-input');
  railSearchInput.addEventListener('input', () => {
    state.railQuery = railSearchInput.value;
    // 搜索要覆盖没展开过的项目：先把它们的会话补载进缓存，否则整项目会被过滤掉。
    if (state.railQuery.trim()) {
      for (const project of state.projects) {
        if (project.id !== state.project?.id && !state.projectSessions[project.id]) void ensureProjectSessions(project.id);
      }
    }
    renderProjects();
    renderConversations();
  });
  railSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setRailSearch(false);
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k' && !SESSION_WINDOW && !INSPECTOR_WINDOW) {
      event.preventDefault();
      setRailSearch(true);
    }
  });
  $('#session-reattach').addEventListener('click', () => {
    if (SESSION_WINDOW) void api.reattachSession(SESSION_WINDOW.sessionId);
  });

  // ---- 项目设置对话框
  $('#project-save').addEventListener('click', () => void saveProjectDialog());
  $('#project-cancel').addEventListener('click', closeProjectDialog);
  $('#project-open-folder').addEventListener('click', () => {
    if (projectDialogId) void api.openConversationFolder(projectDialogId).then(result => {
      if (!result.ok) toast(result.message);
    });
  });
  $('#project-archive').addEventListener('click', () => {
    const project = state.projects.find(item => item.id === projectDialogId);
    closeProjectDialog();
    if (project) void patchProject(project, { archived: !project.archived });
  });
  $('#project-delete').addEventListener('click', () => {
    const project = state.projects.find(item => item.id === projectDialogId);
    closeProjectDialog();
    if (project) void deleteProjectFlow(project);
  });
  $<HTMLInputElement>('#project-name-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void saveProjectDialog();
    }
  });

  // ---- 确认框
  $('#confirm-ok').addEventListener('click', () => settleConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => settleConfirm(false));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('#confirm-dialog').hidden) settleConfirm(false);
    else if (!$('#project-dialog').hidden) closeProjectDialog();
  });

  $('#round-select').addEventListener('change', () => {
    if (!state.runSession) return;
    jumpToRun($<HTMLSelectElement>('#round-select').value);
  });
  $('#round-prev').addEventListener('click', () => {
    const rounds = state.runSession ? roundsOf(state.runSession.id) : [];
    const index = rounds.findIndex(round => round.id === state.selectedRun);
    if (index > 0) jumpToRun(rounds[index - 1].id);
  });
  $('#round-next').addEventListener('click', () => {
    const rounds = state.runSession ? roundsOf(state.runSession.id) : [];
    const index = rounds.findIndex(round => round.id === state.selectedRun);
    if (index >= 0 && index < rounds.length - 1) jumpToRun(rounds[index + 1].id);
  });

  const searchInput = $<HTMLInputElement>('#search-input');
  searchInput.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 220);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void goToHit(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });
  $('#search-prev').addEventListener('click', () => void goToHit(-1));
  $('#search-next').addEventListener('click', () => void goToHit(1));
  $('#search-close').addEventListener('click', closeSearch);

  $('#share-conversation').addEventListener('click', () => void openShare());
  $('#share-close').addEventListener('click', closeShare);
  $('#share-copy').addEventListener('click', () => void copyShare());
  $('#share-export').addEventListener('click', () => void exportShare());
  $('#share-paths').addEventListener('change', renderSharePreview);
  $('#share-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeShare();
  });

  $('#conv-cancel').addEventListener('click', closeConversationDialog);
  $('#conv-confirm').addEventListener('click', () => void confirmConversationDialog());
  $<HTMLInputElement>('#conv-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void confirmConversationDialog();
    }
    if (event.key === 'Escape') closeConversationDialog();
  });
  $('#conv-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeConversationDialog();
  });

  $('#run-send').addEventListener('click', () => void sendRun());
  $('#run-stop').addEventListener('click', async () => {
    if (state.running) await api.cancelRun(state.running);
  });
  ($('#run-prompt') as HTMLTextAreaElement).addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendRun();
    }
  });

  const modelSelect = $('#model-select') as HTMLSelectElement;
  modelSelect.addEventListener('change', () => syncEffort(state.runSession?.host ?? '', modelSelect.value, ''));

  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    const dialogOpen = [...document.querySelectorAll<HTMLElement>('.dialog-backdrop')].some(dialog => !dialog.hidden);
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'b') {
      event.preventDefault();
      toggleResultsPanel();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'f' && !dialogOpen && state.view === 'task' && state.runSession) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'Escape') {
      if (!$('#avatar-picker').hidden) closeAvatarPicker();
      else if (convMenu) closeConversationMenu();
      else if (!$('#session-pop').hidden) closeSessionPop();
      else if (!$('#search-bar').hidden) closeSearch();
    }
  });
}

async function sendChannelMessage(): Promise<void> {
  if (!state.project || !state.channel || state.channel.archived) return;
  const promptBox = $('#prompt') as HTMLTextAreaElement;
  const text = promptBox.value.trim();
  if (!text) return;
  const channel = state.channel;
  const input = { projectId: state.project.id, sessionId: boardSessionId(), text, to: channel.memberId,
    channel: channel.kind === 'channel' ? channel.id : undefined };
  try {
    await api.teamPost(input);
    channelDrafts.delete(channel.id);
    if (state.channel?.id === channel.id && promptBox.value.trim() === text) promptBox.value = '';
    await loadTeam();
    await loadView();
  } catch (error) {
    toast(`发送失败：${(error as Error).message}`);
  }
}

/** 公共留言板：人类主任务的第一句话自动成为第一条留言（已有 owner 留言则不重复）。 */
async function postBoardFirst(projectId: string, memberId: string, goal: string): Promise<void> {
  const sessionId = state.project?.kind === 'inbox' ? memberId : undefined;
  const line = firstLine(goal);
  if (!line) return;
  try {
    const view = await api.teamView({ projectId, sessionId });
    // 同一主任务重复触发不重发；新主任务的首句追加为留言板新的一条（新板时即第一条）。
    if ((view.roots as DecodedMessage[]).some(message => message.sender === 'owner' && firstLine(message.text) === line)) return;
    await api.teamPost({ projectId, sessionId, text: line });
    if (state.project?.id !== projectId || boardSessionId() !== sessionId) return;
    state.boardRoots.push({ at: Date.now(), line });
    state.boardRoots.sort((a, b) => a.at - b.at);
    state.boardFirst = state.boardRoots[0]?.line ?? line;
    if (state.view === 'team') await loadView();
  } catch {
    // 留言板首条失败不阻塞任务本身
  }
}

function hostEnabled(host: string): boolean {
  return state.catalog?.hosts.find(item => item.name === host)?.enabled !== false;
}

function renderHostSettings(): void {
  const list = $('#host-settings');
  list.replaceChildren();
  for (const host of state.catalog?.hosts.filter(item => item.adapter) ?? []) {
    const row = el('label', 'host-setting');
    const description = el('span', 'host-setting-label');
    description.append(el('strong', '', host.name), el('small', 'muted', host.enabled ? host.state : '已停用'));
    const toggle = el('input', 'host-toggle');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', host.name);
    toggle.checked = host.enabled;
    toggle.onchange = async () => {
      toggle.disabled = true;
      try {
        state.catalog = await api.setHostEnabled(host.name, toggle.checked);
        renderHostSettings();
        renderHomeControls();
        if (host.nativeModelCatalog && toggle.checked) void refreshNativeModels();
        updateComposer();
        quotaPanel.render();
        if (state.threadRootId) void openThread(state.threadRootId);
        void quotaPanel.refresh();
      } catch (error) {
        toggle.checked = host.enabled;
        toast((error as Error).message);
      } finally {
        toggle.disabled = false;
      }
    };
    row.append(description, toggle);
    list.append(row);
  }
}

function teamHostOptions(): { name: string }[] {
  return (state.catalog?.hosts ?? []).filter(host => host.adapter && host.ready);
}

function fillTeamHostSelect(select: HTMLSelectElement, preferred = ''): void {
  select.replaceChildren();
  for (const host of teamHostOptions()) select.add(new Option(host.name, host.name));
  if (!teamHostOptions().length) select.add(new Option('未连接宿主', ''));
  if (preferred && teamHostOptions().some(host => host.name === preferred)) select.value = preferred;
}

function syncTeamLeaderModels(): void {
  const hostSelect = $<HTMLSelectElement>('#team-leader-host');
  const modelSelect = $<HTMLSelectElement>('#team-leader-model');
  fillModelSelect(modelSelect, hostSelect.value, modelSelect.value);
}

let teamRowSeq = 0;

function addTeamMemberRow(label = '成员', duty = ''): void {
  const row = el('div', 'team-row team-member-row');
  row.dataset.rowId = String(++teamRowSeq);
  const name = el('input', 'team-member-name') as HTMLInputElement;
  name.value = label;
  name.maxLength = 24;
  name.placeholder = '角色';
  const host = el('select', 'team-member-host') as HTMLSelectElement;
  fillTeamHostSelect(host, $<HTMLSelectElement>('#team-leader-host').value);
  const model = el('select', 'team-member-model') as HTMLSelectElement;
  fillModelSelect(model, host.value, '');
  host.addEventListener('change', () => fillModelSelect(model, host.value, ''));
  const dutyInput = el('input', 'team-member-duty') as HTMLInputElement;
  dutyInput.value = duty;
  dutyInput.maxLength = 80;
  dutyInput.placeholder = '负责什么，例如：实现入口并自测';
  const remove = el('button', 'ghost team-remove', '移除') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
    syncTeamMemberCount();
  });
  const nameField = el('label', 'team-name');
  nameField.append(el('span', '', '角色'), name);
  const hostField = el('label', 'team-pick');
  const hostWrap = el('span', 'select-wrap');
  hostWrap.append(host);
  hostField.append(el('span', '', '宿主'), hostWrap);
  const modelField = el('label', 'team-pick');
  const modelWrap = el('span', 'select-wrap');
  modelWrap.append(model);
  modelField.append(el('span', '', '模型'), modelWrap);
  const dutyField = el('label', 'team-duty');
  dutyField.append(el('span', '', '职责'), dutyInput);
  row.append(nameField, hostField, modelField, dutyField, remove);
  $('#team-member-rows').append(row);
  syncTeamMemberCount();
}

function syncTeamMemberCount(): void {
  const count = $('#team-member-rows').querySelectorAll('.team-member-row').length;
  $('#team-member-count').textContent = count ? `${count} 人` : '';
  ($('#team-member-empty') as HTMLElement).hidden = count > 0;
}

function openTeamDialog(): void {
  const ready = teamHostOptions();
  if (!ready.length) return void toast('还没有就绪的宿主，先去设置里接入一个');
  const leaderHost = $<HTMLSelectElement>('#home-host').value || ready[0].name;
  fillTeamHostSelect($<HTMLSelectElement>('#team-leader-host'), leaderHost);
  $<HTMLSelectElement>('#team-leader-model').value = '';
  syncTeamLeaderModels();
  ($('#team-leader-name') as HTMLInputElement).value = '主导者';
  ($('#team-goal') as HTMLTextAreaElement).value = $<HTMLTextAreaElement>('#home-prompt').value.trim();
  $('#team-member-rows').replaceChildren();
  teamRowSeq = 0;
  addTeamMemberRow('开发', '实现功能并补测试');
  addTeamMemberRow('验收', '按目标独立验收，记录证据');
  $('#team-dialog').hidden = false;
  $('#team-goal').focus();
}

function templateDevTeam(): void {
  $('#team-member-rows').replaceChildren();
  teamRowSeq = 0;
  addTeamMemberRow('开发', '实现功能并补测试');
  addTeamMemberRow('验收', '按目标独立验收，记录证据');
}

async function openLeaderRun(projectId: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await api.listRuns(projectId) as { id: string; session_id: string }[];
    const run = runs.find(item => item.session_id === sessionId);
    if (run) {
      await openRuns(sessionId, run.id);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await openRuns(sessionId, null);
}

async function launchTeam(): Promise<void> {
  const goal = $<HTMLTextAreaElement>('#team-goal').value.trim();
  if (!goal) return void toast('先写团队目标');
  const leader = {
    label: $<HTMLInputElement>('#team-leader-name').value.trim() || '主导者',
    host: $<HTMLSelectElement>('#team-leader-host').value,
    model: $<HTMLSelectElement>('#team-leader-model').value,
    effort: '',
  };
  if (!leader.host) return void toast('主导者要选一个宿主');
  const members = [...$('#team-member-rows').querySelectorAll<HTMLElement>('.team-member-row')].map(row => ({
    label: (row.querySelector('.team-member-name') as HTMLInputElement).value.trim() || '成员',
    host: (row.querySelector('.team-member-host') as HTMLSelectElement).value,
    model: (row.querySelector('.team-member-model') as HTMLSelectElement).value,
    effort: '',
    duty: (row.querySelector('.team-member-duty') as HTMLInputElement).value.trim(),
  }));
  if (!members.length) return void toast('至少添加一个成员');
  if (members.some(member => !member.host)) return void toast('每个成员都要选宿主');
  const button = $<HTMLButtonElement>('#team-launch');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '组建中…';
  try {
    const project = state.project ?? (await api.defaultProject() as ProjectView);
    if (!project) throw new Error('无法打开任务目录');
    const result = await api.teamLaunch({ projectId: project.id, goal, leader, members });
    const launched = result as {
      project: ProjectView;
      leader: SessionView;
      members: SessionView[];
    };
    $('#team-dialog').hidden = true;
    state.projects = await api.listProjects();
    await selectProject(launched.project);
    await openLeaderRun(launched.project.id, launched.leader.id);
    await postBoardFirst(launched.project.id, launched.leader.id, goal);
    renderConversations();
    toast(`团队已开跑：${leader.label} + ${members.length} 位成员`);
    $<HTMLTextAreaElement>('#home-prompt').value = '';
    saveHomeDraft();
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = '组建并开跑';
  }
}

function openMemberDialog(): void {
  const hostSelect = $('#member-host') as HTMLSelectElement;
  hostSelect.innerHTML = '';
  const hosts = (state.catalog?.hosts ?? []).filter(host => host.adapter && host.enabled);
  for (const host of hosts) {
    const option = el('option', '', host.name);
    option.value = host.name;
    hostSelect.append(option);
  }
  hostSelect.onchange = () => {
    $<HTMLInputElement>('#member-path').value = hosts.find(host => host.name === hostSelect.value)?.customPath ?? '';
    $<HTMLSelectElement>('#member-effort').value = '';
    $('#member-probe-status').textContent = '';
    syncMemberModels();
  };
  hostSelect.onchange(new Event('change'));
  ($('#member-name') as HTMLInputElement).value = '';
  ($('#member-dialog') as HTMLElement).hidden = false;
}

async function probeMember(): Promise<void> {
  const host = $<HTMLSelectElement>('#member-host').value;
  if (!host) return;
  const field = $<HTMLInputElement>('#member-path');
  const candidate = field.value.trim();
  const button = $<HTMLButtonElement>('#member-probe');
  const status = $('#member-probe-status');
  button.disabled = true;
  status.textContent = '正在检测…';
  try {
    const result = await api.probeHost(host, candidate);
    if (field.value.trim() === candidate && $<HTMLSelectElement>('#member-host').value === host) status.textContent = result;
  } catch (error) {
    if (field.value.trim() === candidate && $<HTMLSelectElement>('#member-host').value === host) status.textContent = (error as Error).message;
  } finally {
    button.disabled = false;
  }
}

function syncMemberModels(): void {
  const hostSelect = $('#member-host') as HTMLSelectElement;
  const modelSelect = $('#member-model') as HTMLSelectElement;
  const effortSelect = $('#member-effort') as HTMLSelectElement;
  fillModelSelect(modelSelect, hostSelect.value, modelSelect.value);
  const sync = (effort = '') => {
    fillEffortSelect(effortSelect, hostSelect.value, modelSelect.value, effort);
    modelPicker.refresh('member-model-picker');
  };
  modelSelect.onchange = () => sync();
  sync(effortSelect.value);
}

async function createMember(): Promise<void> {
  const memberLabel = ($('#member-name') as HTMLInputElement).value.trim() || '成员';
  const host = ($('#member-host') as HTMLSelectElement).value;
  const model = ($('#member-model') as HTMLSelectElement).value;
  const effort = ($('#member-effort') as HTMLSelectElement).value;
  const topic = state.view === 'team' && state.channel?.kind === 'channel' && !state.channel.main ? state.channel : undefined;
  const scopeSessionId = topic ? boardSessionId() : undefined;
  if (!host) return toast('请选择已启用的宿主');
  const candidate = $<HTMLInputElement>('#member-path').value.trim();
  const create = $<HTMLButtonElement>('#member-create');
  create.disabled = true;
  try {
    const previous = state.catalog?.hosts.find(item => item.name === host)?.customPath ?? '';
    if (candidate !== previous) state.catalog = await api.setHostPath(host, candidate);
    if (!state.catalog?.hosts.find(item => item.name === host)?.ready) throw new Error('宿主还未就绪，请检查路径并检测连通性');
    const project = $('.app').classList.contains('home-mode') ? await api.defaultProject() as ProjectView : state.project;
    if (!project) throw new Error('无法打开默认任务目录');
    const session = await api.createSession({ projectId: project.id, memberLabel, host, model, effort,
      channelId: topic?.id, scopeSessionId });
    $('#member-dialog').hidden = true;
    state.projects = await api.listProjects();
    if (state.project?.id !== project.id) await selectProject(project);
    else await loadTeam();
    if (topic) await loadView();
    else await openRuns(session.id, null);
    if (candidate !== previous) {
      if (state.catalog?.hosts.some(item => item.name === host && item.nativeModelCatalog)) void refreshNativeModels();
      else void quotaPanel.refresh();
    }
    toast(`已添加成员：${memberLabel}`);
  } catch (error) {
    $('#member-probe-status').textContent = (error as Error).message;
  } finally {
    create.disabled = false;
  }
}

function bindEvents(): void {
  api.on('team:changed', (payload: Any) => {
    const projectId = (payload as { projectId?: string } | null)?.projectId;
    if (projectId && projectId !== state.project?.id && state.projectSessions[projectId]) {
      delete state.projectSessions[projectId];
      if (state.expandedProjects.has(projectId)) void ensureProjectSessions(projectId);
    }
    if (!($('#public-board-dialog') as HTMLElement).hidden && (!projectId || projectId === state.project?.id)) {
      void renderPublicBoard();
    }
    scheduleRefresh();
  });

  api.on('projects:changed', () => {
    void (async () => {
      state.projects = await api.listProjects();
      const ids = new Set(state.projects.map(item => item.id));
      for (const key of Object.keys(state.projectSessions)) {
        if (!ids.has(key)) delete state.projectSessions[key];
      }
      if (state.project && !state.projects.some(item => item.id === state.project!.id)) {
        if (SESSION_WINDOW) {
          showWelcome();
        } else {
          state.project = null;
          state.sessions = [];
          state.runs = [];
          state.team = null;
          state.runSession = null;
          state.channel = null;
          state.roots = [];
          state.replies = {};
          state.conversations = {};
          state.inspectorSession = null;
          closeThread();
          closeSearch();
          showHome();
        }
      }
      renderProjects();
      if (!SESSION_WINDOW) void refreshRecent().then(() => renderConversations()).catch(() => {});
    })();
  });

  // ---- 拆出的成员会话窗口协同
  api.on('session:moved', (payload: Any) => {
    if (!SESSION_WINDOW || payload?.sessionId !== SESSION_WINDOW.sessionId) return;
    void (async () => {
      state.projects = await api.listProjects();
      const project = state.projects.find(item => item.id === payload.projectId);
      if (!project) return;
      SESSION_WINDOW.projectId = project.id;
      history.replaceState(null, '', `#session=${project.id}&id=${SESSION_WINDOW.sessionId}`);
      state.runSession = null;
      state.selectedRun = null;
      state.running = null;
      state.live.clear();
      state.inspectorSession = null;
      closeThread();
      await bindSessionWindow();
    })();
  });
  api.on('session-window:opened', (payload: Any) => {
    if (SESSION_WINDOW || !payload?.sessionId) return;
    const sessionId = String(payload.sessionId);
    state.detachedSessions.add(sessionId);
    if (state.inspectorSession?.id === sessionId) {
      state.inspectorSession = null;
      state.inspArtifacts = [];
      state.inspRunning = null;
      if (INSPECTOR_WINDOW) showInspectorSession();
      else if (state.inspMode === 'session') setInspMode('files');
      else reportInspectorState();
    }
    renderConversations();
    renderSessionPopIfOpen();
    renderInspectorMembers();
    if (!INSPECTOR_WINDOW) broadcastMainContext();
  });
  api.on('session-window:closed', (payload: Any) => {
    if (SESSION_WINDOW || !payload?.sessionId) return;
    const sessionId = String(payload.sessionId);
    state.detachedSessions.delete(sessionId);
    renderConversations();
    renderSessionPopIfOpen();
    renderInspectorMembers();
    if (!INSPECTOR_WINDOW) {
      broadcastMainContext();
      // 收回主窗口：把这条会话重新打开在主界面。
      if (payload.projectId === state.project?.id && state.sessions.some(item => item.id === sessionId)) {
        void openRuns(sessionId, roundsOf(sessionId).at(-1)?.id ?? null);
      }
    }
  });
  api.on('session:dragback', (payload: Any) => {
    if (SESSION_WINDOW || INSPECTOR_WINDOW) return;
    $('#dragback-overlay').hidden = payload?.phase !== 'start';
  });
  // 独立窗口拖回来的会话：跨窗口 OLE 放置能送达时直接收，送不达时由拖拽端的光标判定兜底。
  document.addEventListener('dragover', event => {
    if (SESSION_WINDOW || !event.dataTransfer?.types.includes('application/x-swarm-reattach')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  document.addEventListener('drop', event => {
    if (SESSION_WINDOW || !event.dataTransfer?.types.includes('application/x-swarm-reattach')) return;
    event.preventDefault();
    const sessionId = event.dataTransfer.getData('application/x-swarm-reattach');
    if (sessionId) void api.reattachSession(sessionId);
  });

  // ---- 拆出的侧栏窗口协同
  api.on('inspector:occupancy', (payload: Any) => {
    if (SESSION_WINDOW) return;
    state.occupiedInspectors = Array.isArray(payload?.items) ? payload.items : [];
    if (!INSPECTOR_WINDOW && !detachInFlight) {
      reconcileMainInspector();
    }
    renderInspectorMembers();
    renderSessionPopIfOpen();
  });
  api.on('inspector:context', (payload: Any) => {
    if (!INSPECTOR_WINDOW) return;
    if (Array.isArray(payload?.detachedSessions)) {
      state.detachedSessions = new Set<string>(payload.detachedSessions);
    }
    if (payload?.projectId === state.project?.id) {
      const sameTask = !payload.mainSessionId || taskMembers().some(item => item.id === payload.mainSessionId);
      detachedMainSessionId = sameTask ? payload.mainSessionId : undefined;
      if (sameTask && payload.artifactSessionId) detachedArtifactSessionId = payload.artifactSessionId;
    } else {
      detachedMainSessionId = undefined;
    }
    if (state.inspectorSession && !inspectorCandidates().some(item => item.id === state.inspectorSession?.id)) {
      state.inspectorSession = null;
      state.inspArtifacts = [];
      state.inspRunning = null;
      if (state.inspMode === 'session') showInspectorSession();
      else reportInspectorState();
    }
    renderInspectorMembers();
    renderInspectorSessionHead();
  });
  api.on('inspector:assign', (payload: Any) => {
    if (!INSPECTOR_WINDOW || !payload?.sessionId) return;
    if ('mainSessionId' in payload) detachedMainSessionId = payload.mainSessionId;
    void openInspectorSession(String(payload.sessionId), true);
  });
  api.on('inspector:show', (payload: Any) => {
    if (!INSPECTOR_WINDOW || !payload?.projectId) return;
    const request = ++inspectorRequest;
    void (async () => {
      const project = state.projects.find(item => item.id === payload.projectId)
        ?? (await api.listProjects() as ProjectView[]).find(item => item.id === payload.projectId);
      if (!project || request !== inspectorRequest) return;
      const scopeChanged = state.project?.id !== project.id || detachedBoardSessionId !== payload.boardSessionId;
      const firstLoad = !state.project;
      state.project = project;
      detachedBoardSessionId = payload.boardSessionId;
      detachedMainSessionId = payload.mainSessionId;
      detachedArtifactSessionId = payload.artifactSessionId;
      state.detachedSessions = new Set<string>(payload.detachedSessions);
      if (scopeChanged) {
        state.sessions = [];
        state.channel = null;
        state.roots = [];
        state.replies = {};
        if (!firstLoad && payload.mode === 'files') {
          state.preview = null;
          closeThread();
        }
      }
      const [artifacts] = await Promise.all([
        detachedArtifactSessionId ? api.listArtifacts(detachedArtifactSessionId) : Promise.resolve([]),
        scopeChanged || !state.sessions.length ? loadTeam() : Promise.resolve(),
      ]);
      if (request !== inspectorRequest) return;
      state.artifacts = artifacts;
      renderResults();
      if (payload.channelId) state.channel = state.team?.channels.find(item => item.id === payload.channelId) ?? state.channel;
      if (!inspectorCandidates().some(item => item.id === state.inspectorSession?.id)) state.inspectorSession = null;
      const mode = payload.mode ?? state.inspMode;
      const session = inspectorCandidates().find(item => item.id === payload.sessionId);
      if (session) await openInspectorSession(session.id, false);
      if (request !== inspectorRequest) return;
      renderInspectorMembers();
      if (mode === 'preview' && payload.preview?.path) {
        await previewArtifact(payload.preview.path, payload.preview.name);
      } else if (mode === 'thread' && payload.rootId) {
        await openThread(String(payload.rootId));
      } else if (mode === 'session') {
        showInspectorSession();
      } else {
        setInspMode(mode);
      }
      updateInspectorWindowTitle();
    })().catch(error => toast(`侧栏载入失败：${(error as Error).message}`));
  });
  api.on('inspector:swap', (payload: Any) => {
    if (INSPECTOR_WINDOW) return;
    void handleSwap(String(payload?.sessionId ?? ''), payload?.windowId ? String(payload.windowId) : undefined);
  });

  api.on('run:start', (payload: Any) => {
    const run = payload.run as Any;
    const session = payload.session as SessionView;
    if (session.project_id !== state.project?.id) return;
    state.runs = [run, ...state.runs.filter(item => item.id !== run.id)];
    if (session.id === state.inspectorSession?.id && session.id !== state.runSession?.id) {
      // 侧栏会话开跑：在侧栏小窗里铺_live 回合，主会话不受影响。
      state.inspRunning = run.id;
      const side = $('#insp-transcript');
      side.querySelector('.result-empty')?.remove();
      appendRunPrompt(side, run);
      const sideLive = buildTurnShell(run, session);
      side.append(sideLive.root);
      state.live.set(run.id, sideLive);
      renderInspectorSessionHead();
      side.scrollTop = side.scrollHeight;
      renderSidebar();
      renderSessionPopIfOpen();
      return;
    }
    if (session.id !== state.runSession?.id) {
      renderSidebar();
      renderSessionPopIfOpen();
      return;
    }
    state.selectedRun = run.id;
    $('#runs-panel').classList.remove('task-start');
    const container = $('#transcript');
    container.querySelector('.welcome')?.remove();
    appendRunPrompt(container, run);
    const live = buildTurnShell(run, session);
    container.append(live.root);
    state.live.set(run.id, live);
    state.running = run.id;
    updateComposer();
    renderSidebar();
    renderResults();
    container.scrollTop = container.scrollHeight;
  });

  api.on('run:event', (payload: Any) => {
    const live = state.live.get(payload.runId);
    if (!live) return;
    const kind = String(payload.kind);
    if (kind === 'reasoning' && typeof payload.payload === 'string') {
      live.thinking.hidden = false;
      live.thinkingText += payload.payload;
      live.thinkingBody.textContent = live.thinkingText;
      live.thinkingLabel.textContent = `思考过程 · ${live.thinkingText.length} 字`;
    } else if (kind === 'chunk' && typeof payload.payload === 'string') {
      live.body.textContent += payload.payload;
    } else if (kind === 'notice' && typeof payload.payload === 'string') {
      addProgress(live, payload.payload);
    } else if (kind === 'execution_event') {
      addProgress(live, summariseTool(payload.payload), String(payload.payload?.event_type ?? '').includes('failed'));
    } else if (kind === 'usage') {
      renderUsage(live, payload.payload);
    } else if (kind === 'error') {
      addProgress(live, String(payload.payload?.error ?? payload.payload?.message ?? '失败'), true);
    }
  });

  api.on('run:handoff', (payload: Any) => {
    if (state.runSession?.id !== payload.sessionId) return;
    if (!payload.ok) toast(`会话接手失败：${payload.error ?? '未取得确认'}`);
    else toast(payload.decision?.level === 'stage' ? '阶段交接已保存' : '新会话已接手');
  });

  api.on('run:done', (payload: Any) => {
    const live = state.live.get(payload.runId);
    const artifactSessionId = INSPECTOR_WINDOW ? detachedArtifactSessionId : state.runSession?.id;
    state.artifacts.push(...((payload.artifacts ?? []) as ArtifactView[]).filter(item => item.session_id === artifactSessionId));
    if (live) {
      const reply = payload.reply as Any;
      renderReply(live.body, reply?.text || live.body.textContent || '');
      live.status.className = 'status done';
      live.status.textContent = `完成 · ${reply?.seconds ?? 0}s`;
      if (reply?.sessionId) live.status.title = `宿主会话 ${reply.sessionId}`;
      addArtifacts(live, (payload.artifacts ?? []) as ArtifactView[]);
      if (Array.isArray(payload.missing) && payload.missing.length) {
        live.root.querySelector('.agent-card')?.append(el('div', 'notice-warn', `回复声称的文件在磁盘上不存在：\n${payload.missing.join('\n')}`));
      }
    }
    state.live.delete(payload.runId);
    const run = state.runs.find(item => item.id === payload.runId);
    if (run) run.status = 'done';
    if (run?.session_id === state.inspectorSession?.id) {
      state.inspArtifacts.push(...((payload.artifacts ?? []) as ArtifactView[]).filter(item => item.session_id === state.inspectorSession?.id));
      if (state.inspRunning === payload.runId) state.inspRunning = null;
      renderInspectorSessionHead();
    }
    renderSidebar();
    renderSessionPopIfOpen();
    if (state.running === payload.runId) state.running = null;
    updateComposer();
    renderResults();
    scheduleRefresh();
  });

  api.on('run:error', (payload: Any) => {
    const live = state.live.get(payload.runId);
    if (live) {
      live.root.querySelector('.agent-card')?.append(el('div', 'notice-error', String(payload.error ?? '执行失败')));
      live.status.className = 'status failed';
      live.status.textContent = '失败';
    }
    state.live.delete(payload.runId);
    const run = state.runs.find(item => item.id === payload.runId);
    if (run) run.status = 'failed';
    if (run?.session_id === state.inspectorSession?.id && state.inspRunning === payload.runId) {
      state.inspRunning = null;
      renderInspectorSessionHead();
    }
    renderSidebar();
    renderSessionPopIfOpen();
    if (state.running === payload.runId) state.running = null;
    updateComposer();
    scheduleRefresh();
  });

  initMobileDialog();

  api.on('system:bridge-down', (payload: Any) => {
    toast(`宿主桥断开（code ${payload.code}），请重启蜂群`);
  });
}

function initMobileDialog(): void {
  const openBtn = $('#open-mobile');
  const dialog = $('#mobile-dialog');
  const closeBtn = $('#mobile-dialog-close');
  const statusText = $('#mobile-status-text');
  const toggleBtn = $('#mobile-toggle-btn');
  const serverIp = $('#mobile-server-ip');
  const pinCode = $('#mobile-pin-code');
  const regenPinBtn = $('#mobile-regen-pin-btn');
  const pairedCount = $('#mobile-paired-count');
  const devicesList = $('#mobile-devices-list');
  const qrContainer = $('#mobile-qr-container');

  if (!openBtn || !dialog) return;

  async function refresh(): Promise<void> {
    try {
      const status = await api.mobileStatus();
      if (!status) return;
      statusText.textContent = status.isRunning ? '运行中' : '已暂停';
      statusText.className = `status-pill ${status.isRunning ? 'status-ready' : 'status-stopped'}`;
      toggleBtn.textContent = status.isRunning ? '暂停服务' : '启动服务';
      serverIp.textContent = `${status.host}:${status.port}`;
      pinCode.textContent = status.pin;
      pairedCount.textContent = `${status.pairedCount} 台`;
      qrContainer.innerHTML = status.qrSvg || '<span style="color:#888">无二维码</span>';

      devicesList.innerHTML = '';
      if (status.pairedClients && status.pairedClients.length > 0) {
        for (const client of status.pairedClients) {
          const li = el('li', 'mobile-device-item');
          li.innerHTML = `
            <div>
              <strong>${client.deviceName}</strong> (${client.ip})
              <div style="font-size:11px;color:var(--muted)">配对: ${client.pairedAt.slice(11, 19)} · 活跃: ${client.lastSeenAt.slice(11, 19)}</div>
            </div>
          `;
          const revokeBtn = el('button', 'ghost mini-btn', '撤销');
          revokeBtn.addEventListener('click', async () => {
            await api.mobileRevoke(client.token);
            refresh();
          });
          li.appendChild(revokeBtn);
          devicesList.appendChild(li);
        }
      } else {
        devicesList.innerHTML = '<li style="font-size:12px;color:var(--muted);padding:8px;">暂无已配对设备</li>';
      }
    } catch {}
  }

  openBtn.addEventListener('click', () => {
    dialog.hidden = false;
    refresh();
  });

  closeBtn?.addEventListener('click', () => {
    dialog.hidden = true;
  });

  toggleBtn?.addEventListener('click', async () => {
    await api.mobileToggle();
    refresh();
  });

  regenPinBtn?.addEventListener('click', async () => {
    await api.mobileRegeneratePin();
    refresh();
  });
}

void boot().catch(error => {
  const text = `启动失败 ${(error as Error)?.stack ?? (error as Error)?.message ?? String(error)}`;
  console.error(text);
  api.log?.(text);
  toast(text);
});
