export type InspectorMode = 'files' | 'preview' | 'session' | 'thread';

export interface InspectorPreviewRef {
  path: string;
  name: string;
}

export interface InspectorSnapshot {
  projectId?: string;
  mainSessionId?: string;
  artifactSessionId?: string;
  boardSessionId?: string;
  channelId?: string;
  detachedSessions?: string[];
  mode: InspectorMode;
  sessionId: string | null;
  preview?: InspectorPreviewRef | null;
  rootId?: string | null;
  open?: boolean;
}

export interface OccupiedInspectorItem {
  source: string;
  key: string;
  mode: InspectorMode;
  projectId?: string;
  sessionId: string | null;
  previewPath: string | null;
  rootId: string | null;
}

export interface InspectorOccupancyPayload {
  items: OccupiedInspectorItem[];
}

export function inspectorKey(
  snapshot: Pick<InspectorSnapshot, 'mode' | 'projectId' | 'artifactSessionId' | 'preview' | 'rootId'> & {
    sessionId?: string | null;
  },
): string {
  const project = snapshot.projectId ?? '';
  if (snapshot.mode === 'session' && snapshot.sessionId) {
    return `session:${snapshot.sessionId}`;
  }
  if (snapshot.mode === 'preview' && snapshot.preview?.path) {
    return `preview:${project}:${snapshot.preview.path}`;
  }
  if (snapshot.mode === 'thread' && snapshot.rootId) {
    return `thread:${project}:${snapshot.rootId}`;
  }
  return `files:${project}:${snapshot.artifactSessionId || 'team'}`;
}

export function canDetachInspector(
  snapshot: Pick<InspectorSnapshot, 'mode' | 'preview' | 'rootId'> & { sessionId?: string | null },
): { ok: true } | { ok: false; message: string } {
  if (snapshot.mode === 'session' && !snapshot.sessionId) {
    return { ok: false, message: '当前没有可拆出的成员会话' };
  }
  if (snapshot.mode === 'preview' && !snapshot.preview?.path) {
    return { ok: false, message: '当前没有可拆出的文件预览' };
  }
  if (snapshot.mode === 'thread' && !snapshot.rootId) {
    return { ok: false, message: '当前没有可拆出的讨论串' };
  }
  return { ok: true };
}

export function toOccupiedItem(source: string, snapshot: InspectorSnapshot): OccupiedInspectorItem | null {
  if (source === 'main' && !snapshot.open) return null;
  return {
    source,
    key: inspectorKey(snapshot),
    mode: snapshot.mode,
    projectId: snapshot.projectId,
    sessionId: snapshot.mode === 'session' ? snapshot.sessionId : null,
    previewPath: snapshot.mode === 'preview' ? (snapshot.preview?.path ?? null) : null,
    rootId: snapshot.mode === 'thread' ? (snapshot.rootId ?? null) : null,
  };
}

export function occupiedByOthers(items: OccupiedInspectorItem[], selfSource: string): OccupiedInspectorItem[] {
  return items.filter(item => item.source !== selfSource);
}

export function occupiedSessionIds(items: OccupiedInspectorItem[], selfSource: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.source === selfSource) continue;
    if (item.sessionId) ids.add(item.sessionId);
  }
  return ids;
}

export function findOccupiedByKey(
  items: OccupiedInspectorItem[],
  key: string,
  excludeSources: string[] = [],
): OccupiedInspectorItem | undefined {
  const excluded = new Set(excludeSources);
  return items.find(item => !excluded.has(item.source) && item.key === key);
}
