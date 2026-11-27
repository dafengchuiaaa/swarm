import MarkdownIt from 'markdown-it';
import './style.css';

interface WaitingItem {
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

interface InProgressItem {
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

interface DeliveredItem {
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

interface AvailableProjectItem {
  id: string;
  name: string;
  kind: string;
  isRunning: boolean;
  waitingCount: number;
  inProgressCount: number;
}

interface MobileStatePayload {
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

// 状态管理
let serverHost = localStorage.getItem('swarm_host') || '';
let serverPort = localStorage.getItem('swarm_port') || '3818';
let authToken = localStorage.getItem('swarm_token') || '';
let selectedProjectId = localStorage.getItem('swarm_selected_project_id') || '';
let currentState: MobileStatePayload | null = null;
let currentOpenedItem: WaitingItem | InProgressItem | DeliveredItem | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isSpeaking = false;
let lastUpdateTime = '';

const markdown = new MarkdownIt({ html: false, breaks: true });

// DOM 元素引用
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const pairView = $('#pair-view');
const dashboardView = $('#dashboard-view');
const pairForm = $('#pair-form') as HTMLFormElement;
const hostInput = $('#host-input') as HTMLInputElement;
const portInput = $('#port-input') as HTMLInputElement;
const pinInput = $('#pin-input') as HTMLInputElement;
const pairError = $('#pair-error');
const pairBtn = $('#pair-btn') as HTMLButtonElement;

const projSelectorBtn = $('#proj-selector-btn');
const projName = $('#proj-name');
const connPill = $('#conn-pill');
const connText = $('#conn-text');
const briefingBtn = $('#briefing-btn');
const briefingLabel = $('#briefing-label');
const settingsBtn = $('#settings-btn');

const countWaiting = $('#count-waiting');
const countProgress = $('#count-progress');
const countDelivered = $('#count-delivered');

const secWaiting = $('#sec-waiting');
const listWaiting = $('#list-waiting');
const listProgress = $('#list-progress');
const listDelivered = $('#list-delivered');

const taskModal = $('#task-modal');
const closeModalBtn = $('#close-modal-btn');
const detailBadge = $('#detail-badge');
const detailTitle = $('#detail-title');
const detailMember = $('#detail-member');
const detailTime = $('#detail-time');
const detailContent = $('#detail-content');
const detailErrorBlock = $('#detail-error-block');
const detailErrorContent = $('#detail-error-content');
const copyErrorBtn = $('#copy-error-btn');
const detailReplyBlock = $('#detail-reply-block');
const detailReplyInput = $('#detail-reply-input') as HTMLInputElement;
const detailSendReplyBtn = $('#detail-send-reply-btn') as HTMLButtonElement;
const detailArtifactsBlock = $('#detail-artifacts-block');
const detailArtifactsList = $('#detail-artifacts-list');
const readTaskBtn = $('#read-task-btn');

const artifactModal = $('#artifact-modal');
const closeArtBtn = $('#close-art-btn');
const artPreviewTitle = $('#art-preview-title');
const artPreviewBody = $('#art-preview-body');

const settingsModal = $('#settings-modal');
const closeSettingsBtn = $('#close-settings-btn');
const settingsServerUrl = $('#settings-server-url');
const unpairBtn = $('#unpair-btn');

const projectModal = $('#project-modal');
const closeProjectBtn = $('#close-project-btn');
const projectList = $('#project-list');
const toastMsg = $('#toast-msg');

let currentActiveTaskText = '';
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// 初始化执行
function init(): void {
  hostInput.value = serverHost;
  portInput.value = serverPort;

  // 绑定事件
  pairForm.addEventListener('submit', handlePair);
  briefingBtn.addEventListener('click', toggleBriefing);
  settingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', () => (settingsModal.hidden = true));
  unpairBtn.addEventListener('click', handleUnpair);

  projSelectorBtn.addEventListener('click', openProjectSelector);
  closeProjectBtn.addEventListener('click', () => (projectModal.hidden = true));

  closeModalBtn.addEventListener('click', () => (taskModal.hidden = true));
  closeArtBtn.addEventListener('click', () => (artifactModal.hidden = true));
  readTaskBtn.addEventListener('click', readActiveTask);

  copyErrorBtn.addEventListener('click', handleCopyError);
  detailSendReplyBtn.addEventListener('click', handleDetailSendReply);

  // 快捷回复预设标签
  document.querySelectorAll('.quick-tag-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const target = e.currentTarget as HTMLElement;
      const text = target.dataset.reply || '';
      if (text && currentOpenedItem && 'question' in currentOpenedItem) {
        sendQuickReply(currentOpenedItem, text);
      }
    });
  });

  if (authToken) {
    showDashboard();
    syncState();
    connectWebSocket();
  } else {
    showPairView();
  }
}

function showPairView(): void {
  pairView.hidden = false;
  dashboardView.hidden = true;
  if (ws) {
    ws.close();
    ws = null;
  }
}

function showDashboard(): void {
  pairView.hidden = true;
  dashboardView.hidden = false;
  settingsServerUrl.textContent = `http://${serverHost}:${serverPort}`;
}

function showToast(text: string): void {
  toastMsg.textContent = text;
  toastMsg.hidden = false;
  toastMsg.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg.classList.remove('show');
    toastMsg.hidden = true;
  }, 2200);
}

// ---------------------------------------------------------------- 配对与连接

async function handlePair(e: Event): Promise<void> {
  e.preventDefault();
  pairError.hidden = true;
  pairBtn.disabled = true;
  pairBtn.textContent = '正在连接...';

  const host = hostInput.value.trim();
  const port = portInput.value.trim();
  const pin = pinInput.value.trim();

  try {
    const res = await fetch(`http://${host}:${port}/api/mobile/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, deviceName: 'iQOO Neo9 Pro' }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.message || '配对失败，请检查 PIN 码');
    }

    serverHost = host;
    serverPort = port;
    authToken = data.token;
    localStorage.setItem('swarm_host', host);
    localStorage.setItem('swarm_port', port);
    localStorage.setItem('swarm_token', data.token);

    // 通知 Android 原生服务启动常驻保活
    notifyAndroidNativeService(true);

    showDashboard();
    syncState();
    connectWebSocket();
  } catch (err) {
    pairError.textContent = (err as Error).message || '连接失败，请确认手机与电脑在同一 Wi-Fi';
    pairError.hidden = false;
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = '连接蜂群';
  }
}

async function handleUnpair(): Promise<void> {
  if (!confirm('确定断开与当前蜂群电脑的连接吗？')) return;

  try {
    await fetch(`http://${serverHost}:${serverPort}/api/mobile/unpair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken }),
    });
  } catch {}

  notifyAndroidNativeService(false);

  authToken = '';
  selectedProjectId = '';
  localStorage.removeItem('swarm_token');
  localStorage.removeItem('swarm_selected_project_id');
  settingsModal.hidden = true;
  showPairView();
}

function notifyAndroidNativeService(start: boolean): void {
  const bridge = (window as unknown as { SwarmAndroidBridge?: any }).SwarmAndroidBridge;
  if (!bridge) return;
  if (start) {
    bridge.startKeepAlive?.(`ws://${serverHost}:${serverPort}/api/mobile/ws?token=${authToken}`);
  } else {
    bridge.stopKeepAlive?.();
  }
}

// ---------------------------------------------------------------- 数据同步与渲染

async function syncState(): Promise<void> {
  if (!authToken) return;
  try {
    const projectParam = selectedProjectId ? `&projectId=${encodeURIComponent(selectedProjectId)}` : '';
    const res = await fetch(`http://${serverHost}:${serverPort}/api/mobile/state?token=${authToken}${projectParam}`);
    if (res.status === 401) {
      // 令牌已失效（例如电脑端撤销配对）
      handleUnpair();
      return;
    }
    if (!res.ok) throw new Error('同步状态失败');

    const state: MobileStatePayload = await res.json();
    currentState = state;
    if (state.project && !selectedProjectId) {
      selectedProjectId = state.project.id;
    }
    lastUpdateTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    renderDashboard(state);
    setConnectionStatus('online');
  } catch {
    setConnectionStatus('offline');
  }
}

function connectWebSocket(): void {
  if (!authToken) return;
  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  const wsUrl = `ws://${serverHost}:${serverPort}/api/mobile/ws?token=${authToken}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setConnectionStatus('online');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = event => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state:changed' || msg.type === 'alert') {
        syncState();
      }
      if (msg.type === 'alert') {
        // 前台轻度震动提醒
        if ('vibrate' in navigator) navigator.vibrate([80, 40, 80]);
        showToast(`🔔 ${msg.title}：${msg.body}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    setConnectionStatus('reconnecting');
    if (!reconnectTimer && authToken) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 3000);
    }
  };

  ws.onerror = () => {
    setConnectionStatus('reconnecting');
  };
}

function setConnectionStatus(status: 'online' | 'reconnecting' | 'offline'): void {
  connPill.className = `conn-pill conn-${status}`;
  if (status === 'online') {
    connText.textContent = '已连接';
  } else if (status === 'reconnecting') {
    connText.textContent = '重连中...';
  } else {
    connText.textContent = lastUpdateTime ? `断开 · ${lastUpdateTime}` : '已断开';
  }
}

function renderDashboard(state: MobileStatePayload): void {
  const isInbox = state.project?.kind === 'inbox';
  projName.textContent = state.project?.name || (isInbox ? '自由对话任务' : '蜂群工作台');

  countWaiting.textContent = String(state.waiting.length);
  countProgress.textContent = String(state.inProgress.length);
  countDelivered.textContent = String(state.delivered.length + (state.failed?.length || 0));

  // 1. 等你处理
  if (state.waiting.length > 0) {
    secWaiting.hidden = false;
    listWaiting.innerHTML = '';
    for (const item of state.waiting) {
      const card = document.createElement('div');
      card.className = 'item-card waiting-card';
      const channelTag = item.channelLabel ? `<span class="meta-tag channel-tag">${escapeHtml(item.channelLabel)}</span>` : '';
      const groupTag = item.taskGroup ? `<span class="meta-tag group-tag">${escapeHtml(item.taskGroup)}</span>` : '';
      card.innerHTML = `
        <div class="card-top">
          <span class="member-chip"><span class="member-avatar">!</span>${escapeHtml(item.memberLabel)}</span>
          <div class="card-tags">${channelTag}${groupTag}</div>
          <span class="card-time">${formatTime(item.timestamp)}</span>
        </div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-question">${escapeHtml(item.question)}</div>
        <div class="card-quick-actions">
          <button class="quick-action-btn agree-btn" type="button" data-act="agree">同意推进</button>
          <button class="quick-action-btn" type="button" data-act="reply">输入意见</button>
        </div>
      `;
      // 快捷操作
      const agreeBtn = card.querySelector('[data-act="agree"]');
      const replyBtn = card.querySelector('[data-act="reply"]');
      agreeBtn?.addEventListener('click', e => {
        e.stopPropagation();
        sendQuickReply(item, '同意，按此方案推进');
      });
      replyBtn?.addEventListener('click', e => {
        e.stopPropagation();
        openTaskDetail(item);
        detailReplyInput.focus();
      });
      card.addEventListener('click', () => openTaskDetail(item));
      listWaiting.appendChild(card);
    }
  } else {
    secWaiting.hidden = true;
    listWaiting.innerHTML = '';
  }

  // 2. 进行中 / 排队
  if (state.inProgress.length > 0) {
    listProgress.innerHTML = '';
    for (const item of state.inProgress) {
      const card = document.createElement('div');
      card.className = 'item-card';
      const isRun = item.type === 'running';
      const groupTag = item.taskGroup ? `<span class="meta-tag group-tag">${escapeHtml(item.taskGroup)}</span>` : '';
      card.innerHTML = `
        <div class="card-top">
          <span class="member-chip"><span class="member-avatar">${item.memberLabel.slice(0, 1)}</span>${escapeHtml(item.memberLabel)}</span>
          <div class="card-tags">${groupTag}</div>
          <span class="card-time">${formatTime(item.timestamp)}</span>
        </div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-progress">${isRun ? '⚡ ' : '⏳ '}${escapeHtml(item.progress)}</div>
      `;
      card.addEventListener('click', () => openTaskDetail(item));
      listProgress.appendChild(card);
    }
  } else {
    listProgress.innerHTML = '<div class="empty-tip">当前暂无进行中或排队的任务</div>';
  }

  // 3. 已交付 & 失败
  const hasDelivered = state.delivered.length > 0;
  const hasFailed = state.failed && state.failed.length > 0;

  if (hasDelivered || hasFailed) {
    listDelivered.innerHTML = '';

    // 先渲染失败卡片（高优先级警示）
    if (hasFailed) {
      for (const item of state.failed) {
        const card = document.createElement('div');
        card.className = 'item-card failed-card';
        const groupTag = item.taskGroup ? `<span class="meta-tag group-tag">${escapeHtml(item.taskGroup)}</span>` : '';
        card.innerHTML = `
          <div class="card-top">
            <span class="member-chip failed-chip"><span class="member-avatar">✕</span>${escapeHtml(item.memberLabel)}</span>
            <div class="card-tags"><span class="meta-tag badge-red">异常中断</span>${groupTag}</div>
            <span class="card-time">${formatTime(item.timestamp)}</span>
          </div>
          <div class="card-title">${escapeHtml(item.title)}</div>
          <div class="card-error-hint">⚠️ ${escapeHtml(item.error || '遇到错误，点击查看诊断详情')}</div>
        `;
        card.addEventListener('click', () => openTaskDetail(item));
        listDelivered.appendChild(card);
      }
    }

    // 渲染已完成卡片
    if (hasDelivered) {
      for (const item of state.delivered) {
        const card = document.createElement('div');
        card.className = 'item-card';
        let artifactsHtml = '';
        if (item.artifacts && item.artifacts.length > 0) {
          artifactsHtml = `<div class="artifacts-tag-row">${item.artifacts
            .map(a => `<span class="artifact-pill" data-art-id="${a.id}">📄 ${escapeHtml(a.name)}</span>`)
            .join('')}</div>`;
        }
        const groupTag = item.taskGroup ? `<span class="meta-tag group-tag">${escapeHtml(item.taskGroup)}</span>` : '';
        card.innerHTML = `
          <div class="card-top">
            <span class="member-chip"><span class="member-avatar">✓</span>${escapeHtml(item.memberLabel)}</span>
            <div class="card-tags">${groupTag}</div>
            <span class="card-time">${formatTime(item.timestamp)}</span>
          </div>
          <div class="card-title">${escapeHtml(item.title)}</div>
          ${artifactsHtml}
        `;
        card.addEventListener('click', (e: MouseEvent) => {
          const artTarget = (e.target as HTMLElement).closest('.artifact-pill') as HTMLElement | null;
          if (artTarget && artTarget.dataset.artId) {
            e.stopPropagation();
            openArtifact(artTarget.dataset.artId);
          } else {
            openTaskDetail(item);
          }
        });
        listDelivered.appendChild(card);
      }
    }
  } else {
    listDelivered.innerHTML = '<div class="empty-tip">暂无已交付成果</div>';
  }
}

// ---------------------------------------------------------------- 详情与产物弹层

function openTaskDetail(item: WaitingItem | InProgressItem | DeliveredItem): void {
  currentOpenedItem = item;
  const isWait = 'question' in item;
  const isFailed = item.type === 'failed';
  const isDone = item.type === 'done';

  detailBadge.className = `sec-badge ${isWait || isFailed ? 'badge-red' : isDone ? 'badge-green' : 'badge-blue'}`;
  detailBadge.textContent = isWait ? '等你处理' : isFailed ? '执行异常' : isDone ? '已交付' : '进行中';

  detailTitle.textContent = item.title;
  detailMember.textContent = item.memberLabel;
  detailTime.textContent = formatTime(item.timestamp);

  const textBody = isWait ? item.question : isFailed ? (item.error || '遇到错误') : isDone ? item.conclusion : item.progress;
  detailContent.textContent = textBody;
  currentActiveTaskText = `${item.memberLabel}：${item.title}。${textBody}`;

  // 错误诊断区
  if (isFailed) {
    detailErrorBlock.hidden = false;
    detailErrorContent.textContent = item.rawError || item.error || '任务异常中断';
  } else {
    detailErrorBlock.hidden = true;
  }

  // 快捷回复区
  if (isWait) {
    detailReplyBlock.hidden = false;
    detailReplyInput.value = '';
  } else {
    detailReplyBlock.hidden = true;
  }

  // 产物区
  if (isDone && item.artifacts && item.artifacts.length > 0) {
    detailArtifactsBlock.hidden = false;
    detailArtifactsList.innerHTML = '';
    for (const art of item.artifacts) {
      const row = document.createElement('div');
      row.className = 'artifact-pill';
      row.style.cursor = 'pointer';
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.innerHTML = `<span>📄 ${escapeHtml(art.name)}</span><span style="opacity:0.7">${formatBytes(art.size)}</span>`;
      row.addEventListener('click', () => openArtifact(art.id));
      detailArtifactsList.appendChild(row);
    }
  } else {
    detailArtifactsBlock.hidden = true;
  }

  taskModal.hidden = false;
}

async function handleDetailSendReply(): Promise<void> {
  if (!currentOpenedItem || !('question' in currentOpenedItem)) return;
  const text = detailReplyInput.value.trim();
  if (!text) {
    showToast('请输入回复意见');
    return;
  }
  await sendQuickReply(currentOpenedItem, text);
}

async function sendQuickReply(item: WaitingItem, text: string): Promise<void> {
  const replyText = text.trim();
  if (!replyText) return;

  showToast('正在向蜂群总线发送决策...');
  try {
    const res = await fetch(`http://${serverHost}:${serverPort}/api/mobile/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        token: authToken,
        projectId: currentState?.project?.id || selectedProjectId,
        messageId: item.messageId || item.id,
        threadId: item.threadId,
        channel: item.channelId,
        replyText,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || '发送失败');

    showToast('✅ 决策已送达蜂群总线');
    if (currentState) {
      currentState.waiting = currentState.waiting.filter(w => w.id !== item.id);
      renderDashboard(currentState);
    }
    taskModal.hidden = true;
    syncState();
  } catch (err) {
    showToast(`发送失败：${(err as Error).message}`);
  }
}

function handleCopyError(): void {
  const text = detailErrorContent.textContent || '';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('已复制错误日志'));
  } else {
    showToast('复制失败，请手动长按选择');
  }
}

async function openArtifact(artifactId: string): Promise<void> {
  if (!currentState) return;
  const allArts = currentState.delivered.flatMap(d => d.artifacts);
  const target = allArts.find(a => a.id === artifactId);
  const artName = target?.name || '产物预览';

  artPreviewTitle.textContent = artName;
  artPreviewBody.innerHTML = '<div style="color:var(--text-muted);padding:20px;">正在加载产物...</div>';
  artifactModal.hidden = false;

  try {
    const res = await fetch(`http://${serverHost}:${serverPort}/api/mobile/artifacts/${artifactId}?token=${authToken}`);
    if (!res.ok) throw new Error('读取产物失败');
    const text = await res.text();
    if (artName.endsWith('.md')) {
      artPreviewBody.innerHTML = markdown.render(text);
    } else {
      artPreviewBody.textContent = text;
    }
  } catch (err) {
    artPreviewBody.innerHTML = `<div style="color:#fb7185;padding:20px;">读取产物失败：${(err as Error).message}</div>`;
  }
}

// ---------------------------------------------------------------- 项目/任务切换

function openProjectSelector(): void {
  if (!currentState || !currentState.availableProjects) {
    showToast('暂无其他项目可选');
    return;
  }
  projectList.innerHTML = '';
  for (const p of currentState.availableProjects) {
    const item = document.createElement('div');
    item.className = `project-item-card ${p.id === (currentState.project?.id || selectedProjectId) ? 'active' : ''}`;
    const kindLabel = p.kind === 'inbox' ? '自由对话' : '正式项目';
    const runningBadge = p.isRunning ? '<span class="status-running-badge">⚡ 运行中</span>' : '';
    item.innerHTML = `
      <div class="project-item-title-row">
        <span class="project-item-name">${escapeHtml(p.name)}</span>
        ${runningBadge}
      </div>
      <div class="project-item-meta">
        <span class="meta-tag">${kindLabel}</span>
        ${p.waitingCount > 0 ? `<span class="meta-tag badge-red">待处理 ${p.waitingCount}</span>` : ''}
        ${p.inProgressCount > 0 ? `<span class="meta-tag badge-blue">进行中 ${p.inProgressCount}</span>` : ''}
      </div>
    `;
    item.addEventListener('click', () => {
      selectedProjectId = p.id;
      localStorage.setItem('swarm_selected_project_id', p.id);
      projectModal.hidden = true;
      showToast(`已切换至：${p.name}`);
      syncState();
    });
    projectList.appendChild(item);
  }
  projectModal.hidden = false;
}

// ---------------------------------------------------------------- 离线语音合成 (TTS)

function toggleBriefing(): void {
  if (isSpeaking) {
    stopSpeech();
    return;
  }
  if (!currentState) return;
  const text = currentState.briefingText || '当前没有可播报的内容。';
  startSpeech(text);
}

function readActiveTask(): void {
  if (isSpeaking) {
    stopSpeech();
  } else if (currentActiveTaskText) {
    startSpeech(currentActiveTaskText);
  }
}

function startSpeech(text: string): void {
  isSpeaking = true;
  briefingBtn.classList.add('playing');
  briefingLabel.textContent = '停止';

  // 优先原生 Android TTS
  const bridge = (window as unknown as { SwarmAndroidBridge?: any }).SwarmAndroidBridge;
  if (bridge?.speak) {
    bridge.speak(text);
    return;
  }

  // 浏览器原生 Web Speech API
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    utterance.onend = () => stopSpeech();
    utterance.onerror = () => stopSpeech();
    window.speechSynthesis.speak(utterance);
  } else {
    stopSpeech();
  }
}

function stopSpeech(): void {
  isSpeaking = false;
  briefingBtn.classList.remove('playing');
  briefingLabel.textContent = '听简报';

  const bridge = (window as unknown as { SwarmAndroidBridge?: any }).SwarmAndroidBridge;
  if (bridge?.stopSpeaking) {
    bridge.stopSpeaking();
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function openSettings(): void {
  settingsModal.hidden = false;
}

// ---------------------------------------------------------------- 辅助工具

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

window.addEventListener('DOMContentLoaded', init);
