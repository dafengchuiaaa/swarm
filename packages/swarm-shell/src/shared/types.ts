export interface CatalogHost {
  name: string;
  ready: boolean;
  installed: boolean;
  adapter: boolean;
  state: string;
  note: string;
  enabled: boolean;
  customPath?: string | null;
  nativeModelCatalog?: boolean;
}

export interface HostCatalog {
  hosts: CatalogHost[];
  models: Record<string, [string, string][]>;
  thoughtLevels: Record<string, Record<string, string[]>>;
  modelDetails?: Record<string, Record<string, ModelDetails>>;
  antigravityCli?: string | null;
  quotaAvailable?: boolean;
}

export interface ModelDetails {
  creditMultiplier?: number;
  contextWindow?: number;
  contextWindows?: number[];
  maxInputTokens?: number;
  defaultEffort?: string;
}

export interface HostModelCatalog {
  models: [string, string][];
  thoughtLevels: Record<string, string[]>;
  modelDetails: Record<string, ModelDetails>;
}

export interface ProjectView {
  id: string;
  name: string;
  workspace: string;
  archived: number;
  /** 'inbox' 是首页自由对话的容器，不进项目列表。 */
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface SessionView {
  id: string;
  project_id: string;
  group_id: string;
  /** 派工层级：由哪条主会话派出；空串表示自己是主会话。 */
  parent_session_id: string;
  member_label: string;
  host: string;
  model: string;
  effort: string;
  host_session_id: string | null;
  title: string;
  /** 最近一次派工时间；空串表示从未被派工过（主控或历史席位）。 */
  dispatched_at: string;
  worktree_path?: string;
  created_at: string;
  updated_at: string;
}

/** 「最近」列表用：跨项目会话 + 所属项目名 + 整理状态，侧栏直接平铺渲染。 */
export interface RecentSessionView extends SessionView {
  project_name: string;
  project_kind: string;
  meta_title: string;
  pinned: number;
  archived: number;
  /** 最近一次提问，跨项目会话拿不到 runs 时用它兜标题。 */
  last_prompt: string;
}

export interface ArtifactView {
  id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  name: string;
  path: string;
  size: number;
  verified: number;
  created_at: string;
}

export interface RunView {
  id: string;
  project_id: string;
  session_id: string;
  prompt: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  reply_text: string;
  error: string;
  seconds: number;
  started_at: string;
  ended_at: string | null;
}

export interface TranscriptEntry {
  run: RunView;
  events: { run_id: string; seq: number; kind: string; payload: string; created_at: string }[];
}

/** 会话整理状态；与成员会话本身分开保存。 */
export interface ConversationMetaView {
  session_id: string;
  project_id: string;
  title: string;
  pinned: number;
  group_name: string;
  archived: number;
  updated_at: string;
}

export interface ConversationSearchHitView {
  runId: string;
  seq: number | null;
  field: 'prompt' | 'reply' | 'reasoning' | 'chunk' | 'notice';
  index: number;
}
