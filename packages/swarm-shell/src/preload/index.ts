import { contextBridge, ipcRenderer } from 'electron';

const api = {
  catalog: () => ipcRenderer.invoke('system:catalog'),
  quotas: () => ipcRenderer.invoke('system:quotas'),
  codeBuddyModels: () => ipcRenderer.invoke('system:codeBuddyModels'),
  setHostEnabled: (host: string, enabled: boolean) => ipcRenderer.invoke('system:hostEnabled', host, enabled),
  setHostPath: (host: string, file: string) => ipcRenderer.invoke('system:hostPath', host, file),
  probeHost: (host: string, file: string) => ipcRenderer.invoke('system:probeHost', host, file),
  pickHostPath: (host: string) => ipcRenderer.invoke('system:pickHostPath', host),
  defaultProject: () => ipcRenderer.invoke('project:default'),
  paths: () => ipcRenderer.invoke('system:paths'),
  listProjects: () => ipcRenderer.invoke('project:list'),
  pickWorkspace: () => ipcRenderer.invoke('project:pick'),
  createProject: (input: { name: string; workspace: string }) => ipcRenderer.invoke('project:create', input),
  updateProject: (input: { id: string; name?: string; archived?: boolean }) => ipcRenderer.invoke('project:update', input),
  deleteProject: (projectId: string) => ipcRenderer.invoke('project:delete', projectId),
  listSessions: (projectId: string) => ipcRenderer.invoke('session:list', projectId),
  recentSessions: () => ipcRenderer.invoke('session:recent'),
  createSession: (input: { projectId: string; memberLabel: string; host: string; model: string; effort?: string;
    groupId?: string; channelId?: string; scopeSessionId?: string }) =>
    ipcRenderer.invoke('session:create', input),
  moveSession: (input: { sessionId: string; projectId: string }) => ipcRenderer.invoke('session:move', input),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
  detachSession: (input: { projectId: string; sessionId: string }) => ipcRenderer.invoke('session:detach', input),
  reattachSession: (sessionId: string) => ipcRenderer.invoke('session:reattach', sessionId),
  getRun: (runId: string) => ipcRenderer.invoke('run:get', runId),
  listRuns: (projectId: string) => ipcRenderer.invoke('run:list', projectId),
  searchConversation: (sessionId: string, query: string) => ipcRenderer.invoke('conversation:search', { sessionId, query }),
  conversationTurns: (sessionId: string) => ipcRenderer.invoke('conversation:turns', sessionId),
  conversationTranscript: (sessionId: string) => ipcRenderer.invoke('conversation:transcript', sessionId),
  conversationMeta: (projectId: string) => ipcRenderer.invoke('conversation:meta', projectId),
  updateConversation: (input: {
    projectId: string;
    sessionId: string;
    title?: string;
    pinned?: boolean;
    groupName?: string;
    archived?: boolean;
  }) => ipcRenderer.invoke('conversation:update', input),
  openConversationFolder: (projectId: string) => ipcRenderer.invoke('conversation:openFolder', projectId),
  exportMarkdown: (input: { defaultName: string; content: string }) => ipcRenderer.invoke('share:export', input),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  startRun: (input: { projectId: string; sessionId: string; prompt: string; model?: string; effort?: string }) =>
    ipcRenderer.invoke('run:start', input),
  cancelRun: (runId: string) => ipcRenderer.invoke('run:cancel', runId),
  steerRun: (runId: string, text: string) => ipcRenderer.invoke('run:steer', { runId, text }),
  log: (message: string) => ipcRenderer.send('system:log', message),
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized') as Promise<boolean>,
  cursorClientPoint: () => ipcRenderer.invoke('win:cursorClient') as Promise<{ x: number; y: number } | null>,
  sessionDragback: (phase: 'start' | 'end', sessionId: string) => ipcRenderer.send('session:dragback', { phase, sessionId }),
  onWinState: (listener: (maximized: boolean) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(Boolean(value));
    ipcRenderer.on('win:state', handler);
    return () => ipcRenderer.removeListener('win:state', handler);
  },
  openArtifact: (filePath: string) => ipcRenderer.invoke('artifact:open', filePath),
  readArtifact: (filePath: string) => ipcRenderer.invoke('artifact:read', filePath),
  revealArtifact: (filePath: string) => ipcRenderer.invoke('artifact:reveal', filePath),
  listArtifacts: (sessionId: string) => ipcRenderer.invoke('artifact:list', sessionId),
  inspectorReady: (windowId?: string) => ipcRenderer.send('inspector:ready', windowId),
  inspectorDetach: (payload: unknown) => ipcRenderer.invoke('inspector:detach', payload),
  inspectorFocus: (key: string) => ipcRenderer.invoke('inspector:focus', key),
  inspectorContext: (payload: unknown) => ipcRenderer.send('inspector:context', payload),
  inspectorState: (payload: unknown) => ipcRenderer.send('inspector:state', payload),
  inspectorSwap: (sessionId: string) => ipcRenderer.send('inspector:swap', { sessionId }),
  inspectorAssign: (payload: { windowId: string; sessionId: string; mainSessionId?: string }) =>
    ipcRenderer.send('inspector:assign', payload),
  teamState: (projectId: string, sessionId?: string) => ipcRenderer.invoke('team:state', projectId, sessionId),
  resultInbox: (input: { projectId: string; sessionId: string; messageId?: string; offset?: number }) =>
    ipcRenderer.invoke('team:result-inbox', input),
  teamView: (input: { projectId: string; sessionId?: string; viewer?: string; channel?: string }) => ipcRenderer.invoke('team:view', input),
  teamThread: (input: { projectId: string; sessionId?: string; viewer?: string; rootId: string }) => ipcRenderer.invoke('team:thread', input),
  teamPublicBoard: (input: { projectId: string; sessionId?: string }) => ipcRenderer.invoke('team:publicBoard', input),
  getStallMonitor: () => ipcRenderer.invoke('system:getStallMonitor') as Promise<{ enabled: boolean }>,
  setStallMonitor: (enabled: boolean) => ipcRenderer.invoke('system:setStallMonitor', enabled) as Promise<{ enabled: boolean }>,
  teamChannel: (input: { projectId: string; sessionId?: string; operation: 'create' | 'invite' | 'archive' | 'restore';
    name?: string; channelId?: string; memberIds?: string[] }) => ipcRenderer.invoke('team:channel', input),
  teamPost: (input: { projectId: string; sessionId?: string; text: string; to?: string; thread?: string; channel?: string; evidence?: string[] }) =>
    ipcRenderer.invoke('team:post', input),
  teamDispatch: (input: { projectId: string; sessionId?: string; memberId: string; text: string; thread?: string; evidence?: string[] }) =>
    ipcRenderer.invoke('team:dispatch', input),
  teamLaunch: (input: {
    projectId?: string;
    name?: string;
    workspace?: string;
    goal: string;
    leader: { label: string; host: string; model: string; effort?: string };
    members: { label: string; host: string; model: string; effort?: string; duty?: string }[];
  }) => ipcRenderer.invoke('team:launch', input),
  mobileStatus: () => ipcRenderer.invoke('mobile:status'),
  mobileToggle: (enabled?: boolean) => ipcRenderer.invoke('mobile:toggle', enabled),
  mobileRegeneratePin: () => ipcRenderer.invoke('mobile:regeneratePin'),
  mobileRevoke: (token: string) => ipcRenderer.invoke('mobile:revoke', token),
  mobileRevokeAll: () => ipcRenderer.invoke('mobile:revokeAll'),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('swarm', api);
