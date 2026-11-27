/**
 * 独立蜂群自己的持久化层：一份 SQLite，项目 / 成员 / 宿主会话 / 主对话 / 事件 / 成果。
 *
 * 使用 Electron 37 内置的 node:sqlite，无需为发行包重编译原生模块。
 * 所有写入都走同步事务，重启后按同一主键读回。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDatabase };

interface SqliteStatement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}
export interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'project',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT NOT NULL DEFAULT '',
  member_label TEXT NOT NULL,
  host TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT '',
  host_session_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  dispatched_at TEXT NOT NULL DEFAULT '',
  worktree_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  reply_text TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  seconds REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);
CREATE TABLE IF NOT EXISTS bus_state (
  project_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_meta (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compaction_receipts (
  session_id TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (session_id, host_session_id, message_id)
);

CREATE TABLE IF NOT EXISTS compaction_state (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  host_session_id TEXT NOT NULL DEFAULT '',
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  manual_count INTEGER NOT NULL DEFAULT 0,
  estimate_count INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_phase TEXT NOT NULL DEFAULT '',
  limit_reached INTEGER NOT NULL DEFAULT 0,
  context_used INTEGER NOT NULL DEFAULT 0,
  context_size INTEGER NOT NULL DEFAULT 0,
  compact_budget INTEGER NOT NULL DEFAULT 0,
  /** 最近一次实测的单轮上下文增长，用来给估算档留余量。 */
  last_growth INTEGER NOT NULL DEFAULT 0,
  /** 首次确认压缩时的实测占用与预算：第二次的接近度以宿主自己的触发点为基准。 */
  baseline_used INTEGER NOT NULL DEFAULT 0,
  baseline_budget INTEGER NOT NULL DEFAULT 0,
  handoff_state TEXT NOT NULL DEFAULT '',
  handoff_reason TEXT NOT NULL DEFAULT '',
  successor_session_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compaction_host ON compaction_state(host_session_id);
`;

export interface ProjectRecord {
  id: string;
  name: string;
  workspace: string;
  archived: number;
  /** 'inbox' = 首页自由对话的归属容器，不算用户项目，不进项目列表。 */
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  project_id: string;
  group_id: string;
  /** 派工关系：本会话由哪条主会话派出。空串表示自己就是主会话。 */
  parent_session_id: string;
  member_label: string;
  host: string;
  model: string;
  effort: string;
  host_session_id: string | null;
  title: string;
  /** 最近一次被派工的时间；复用老成员时也刷新，排序不能退回创建时间。 */
  dispatched_at: string;
  worktree_path?: string;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  project_id: string;
  session_id: string;
  prompt: string;
  status: RunStatus;
  reply_text: string;
  error: string;
  seconds: number;
  started_at: string;
  ended_at: string | null;
}

export interface RunEventRecord {
  run_id: string;
  seq: number;
  kind: string;
  payload: string;
  created_at: string;
}

export interface ArtifactRecord {
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

/** 会话整理状态与 sessions 表分开：改名、置顶、分组、归档都不改写成员状态和宿主续接 ID。 */
export interface ConversationMetaRecord {
  session_id: string;
  project_id: string;
  title: string;
  pinned: number;
  group_name: string;
  archived: number;
  updated_at: string;
}

/**
 * 压缩检测进度：按成员会话记录已确认次数、占用与接手状态。
 * 计数只认宿主自己广播的压缩事件，`estimate_count` 单独放，不冒充已确认。
 */
export interface CompactionStateRecord {
  session_id: string;
  project_id: string;
  host: string;
  /** 计数绑定到具体宿主会话：换会话即视为新的一段，旧计数不延续。 */
  host_session_id: string;
  confirmed_count: number;
  manual_count: number;
  estimate_count: number;
  last_message_id: string;
  last_phase: string;
  limit_reached: number;
  context_used: number;
  context_size: number;
  compact_budget: number;
  last_growth: number;
  baseline_used: number;
  baseline_budget: number;
  /** '' | 'requested' | 'done' | 'failed' */
  handoff_state: string;
  handoff_reason: string;
  successor_session_id: string;
  updated_at: string;
}

export interface RecentSessionRecord extends SessionRecord {
  project_name: string;
  project_kind: string;
  meta_title: string;
  pinned: number;
  archived: number;
  /** 最近一次提问的原话，用来给跨项目会话兜出可读标题。 */
  last_prompt: string;
}

export interface ConversationSearchHit {
  runId: string;
  seq: number | null;
  field: 'prompt' | 'reply' | 'reasoning' | 'chunk' | 'notice';
  index: number;
}

const iso = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

export class SwarmStore {
  readonly db: SqliteDatabase;
  readonly file: string;
  readonly folder: string;

  constructor(folder: string) {
    mkdirSync(folder, { recursive: true });
    this.folder = path.resolve(folder);
    this.file = path.join(folder, 'swarm-shell.sqlite3');
    this.db = new sqlite.DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 旧库补列：会话按任务分组（group_id），项目可归档（archived）。只跑一次，幂等。 */
  private migrate(): void {
    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!sessionCols.some(col => col.name === 'group_id')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN group_id TEXT NOT NULL DEFAULT ''");
      // 历史会话没有分组概念：同一项目的旧会话视为一组，保持原有可见范围。
      this.db.exec("UPDATE sessions SET group_id = project_id WHERE group_id = ''");
    }
    if (!sessionCols.some(col => col.name === 'dispatched_at')) {
      // 历史会话没有派工时间，留空由前端退回创建时间，不改写任何时间戳。
      this.db.exec("ALTER TABLE sessions ADD COLUMN dispatched_at TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionCols.some(col => col.name === 'parent_session_id')) {
      // 旧数据没有派工层级，一律留空当主会话，不改写任何历史会话的归属。
      this.db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionCols.some(col => col.name === 'worktree_path')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN worktree_path TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
    const projectCols = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!projectCols.some(col => col.name === 'archived')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    if (!projectCols.some(col => col.name === 'kind')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'");
    }
    // 旧版首页自由任务是隐式建了一个叫「蜂群任务」的普通项目来收留会话，导致侧栏多出假项目、
    // 换项目后历史对话整片消失。这里把落在默认工作区的那一个转成自由对话容器（只转一次、幂等）。
    this.db.prepare("UPDATE projects SET name = '对话' WHERE kind = 'inbox' AND name = '自由对话'").run();
    const inbox = this.db.prepare("SELECT id FROM projects WHERE kind = 'inbox' LIMIT 1").get() as { id: string } | undefined;
    if (!inbox) {
      // 数据目录一旦被 SWARM_DATA_DIR 挪过位置，绝对路径就对不上，所以再兜一层按默认目录名匹配。
      const legacy = this.db
        .prepare(
          "SELECT id FROM projects WHERE kind = 'project' AND (workspace = ? OR workspace LIKE ?) ORDER BY created_at ASC LIMIT 1",
        )
        .get(this.inboxWorkspace(), '%SwarmIndependent\\workspace') as { id: string } | undefined;
      if (legacy) {
        this.db.prepare("UPDATE projects SET kind = 'inbox', name = '对话', archived = 0 WHERE id = ?").run(legacy.id);
      }
    }
  }

  /** 自由对话容器的工作目录：默认数据目录下的 workspace，和用户自己接入的项目目录互不干扰。 */
  private inboxWorkspace(): string {
    return path.join(this.folder, 'workspace');
  }

  // ---------------------------------------------------------------- 项目

  listProjects(): ProjectRecord[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRecord[];
  }

  /** 自由对话容器：没有就建一个。首页新建任务、未选项目时加的成员都落在这里，不再伪装成项目。 */
  inboxProject(): ProjectRecord {
    const existing = this.db.prepare("SELECT * FROM projects WHERE kind = 'inbox' ORDER BY created_at ASC LIMIT 1").get() as
      | ProjectRecord
      | undefined;
    if (existing) {
      mkdirSync(existing.workspace, { recursive: true });
      return existing;
    }
    const workspace = this.inboxWorkspace();
    mkdirSync(workspace, { recursive: true });
    const now = iso();
    const record: ProjectRecord = {
      id: id('P'),
      name: '对话',
      workspace,
      archived: 0,
      kind: 'inbox',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare('INSERT INTO projects (id,name,workspace,archived,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(record.id, record.name, record.workspace, record.archived, record.kind, record.created_at, record.updated_at);
    return record;
  }

  project(id: string): ProjectRecord | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRecord | undefined;
  }

  createProject(name: string, workspace: string): ProjectRecord {
    const now = iso();
    const existing = this.db.prepare('SELECT * FROM projects WHERE workspace = ?').get(workspace) as ProjectRecord | undefined;
    if (existing) return existing;
    const record: ProjectRecord = {
      id: id('P'),
      name,
      workspace,
      archived: 0,
      kind: 'project',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare('INSERT INTO projects (id,name,workspace,archived,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(record.id, record.name, record.workspace, record.archived, record.kind, record.created_at, record.updated_at);
    return record;
  }

  touchProject(projectId: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(iso(), projectId);
  }

  updateProject(projectId: string, patch: { name?: string; archived?: boolean }): ProjectRecord | undefined {
    const current = this.project(projectId);
    if (!current) return undefined;
    const name = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
    const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : current.archived;
    this.db.prepare('UPDATE projects SET name = ?, archived = ?, updated_at = ? WHERE id = ?').run(name, archived, iso(), projectId);
    return this.project(projectId);
  }

  /** 删除项目及其全部会话、回合、事件、成果、整理状态和协作总线快照。 */
  deleteProject(projectId: string): void {
    for (const session of this.listSessions(projectId)) this.deleteSession(session.id);
    this.db.prepare('DELETE FROM bus_state WHERE project_id = ? OR instr(project_id, ?) = 1').run(projectId, projectId + '/');
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  // ---------------------------------------------------------------- 成员会话

  listSessions(projectId: string): SessionRecord[] {
    return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as SessionRecord[];
  }

  session(id: string): SessionRecord | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRecord | undefined;
  }

  /** 「最近」列表：跨项目的会话按更新时间一锅端，侧栏不再分自由对话/项目两块。 */
  recentSessions(limit = 80): RecentSessionRecord[] {
    return this.db
      .prepare(
        `SELECT s.*, p.name AS project_name, p.kind AS project_kind,
                COALESCE(m.title, '') AS meta_title,
                COALESCE(m.pinned, 0) AS pinned,
                COALESCE(m.archived, 0) AS archived,
                COALESCE((SELECT r.prompt FROM runs r WHERE r.session_id = s.id ORDER BY r.started_at ASC, r.rowid ASC LIMIT 1), '') AS last_prompt
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN conversation_meta m ON m.session_id = s.id
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as RecentSessionRecord[];
  }

  createSession(input: {
    projectId: string;
    memberLabel: string;
    host: string;
    model: string;
    effort?: string;
    title?: string;
    groupId?: string;
    parentSessionId?: string;
    dispatchedAt?: string;
    worktreePath?: string;
  }): SessionRecord {
    const now = iso();
    const record: SessionRecord = {
      id: id('S'),
      project_id: input.projectId,
      group_id: input.groupId ?? id('G'),
      parent_session_id: input.parentSessionId ?? '',
      member_label: input.memberLabel,
      host: input.host,
      model: input.model,
      effort: input.effort ?? '',
      host_session_id: null,
      title: input.title ?? '',
      dispatched_at: input.dispatchedAt ?? '',
      worktree_path: input.worktreePath ?? '',
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id,project_id,group_id,parent_session_id,member_label,host,model,effort,host_session_id,title,dispatched_at,worktree_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.id,
        record.project_id,
        record.group_id,
        record.parent_session_id,
        record.member_label,
        record.host,
        record.model,
        record.effort,
        record.host_session_id,
        record.title,
        record.dispatched_at,
        record.worktree_path,
        record.created_at,
        record.updated_at,
      );
    return record;
  }

  updateSessionWorktree(sessionId: string, worktreePath: string): void {
    this.db.prepare('UPDATE sessions SET worktree_path = ?, updated_at = ? WHERE id = ?').run(worktreePath, iso(), sessionId);
  }

  getSetting(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, iso());
  }

  getStallMonitorEnabled(): boolean {
    return this.getSetting('stall_monitor_enabled', 'false') === 'true';
  }

  setStallMonitorEnabled(enabled: boolean): void {
    this.setSetting('stall_monitor_enabled', enabled ? 'true' : 'false');
  }

  /** 会话跨项目移动：回合、成果、整理状态跟着走，宿主续接 ID 不变。 */
  moveSession(sessionId: string, projectId: string): SessionRecord | undefined {
    const session = this.session(sessionId);
    if (!session || !this.project(projectId)) return undefined;
    const now = iso();
    this.db.prepare('UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?').run(projectId, now, sessionId);
    this.db.prepare('UPDATE runs SET project_id = ? WHERE session_id = ?').run(projectId, sessionId);
    this.db.prepare('UPDATE artifacts SET project_id = ? WHERE session_id = ?').run(projectId, sessionId);
    this.db.prepare('UPDATE conversation_meta SET project_id = ?, updated_at = ? WHERE session_id = ?').run(projectId, now, sessionId);
    return this.session(sessionId);
  }

  /** 删除会话及其回合、事件、成果和整理状态；调用方先确认没有正在跑的回合。 */
  deleteSession(sessionId: string): void {
    const runs = this.sessionRuns(sessionId);
    if (runs.length) {
      const placeholders = runs.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM run_events WHERE run_id IN (${placeholders})`).run(...runs.map(run => run.id));
    }
    this.db.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM conversation_meta WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM compaction_receipts WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM compaction_state WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  /** 每次派工都刷新这条席位的派工时间：右侧顺序按真实派工先后，而不是会话创建先后。 */
  markDispatched(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET dispatched_at = ? WHERE id = ?').run(iso(), sessionId);
  }

  bindHostSession(sessionId: string, hostSessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET host_session_id = ?, updated_at = ? WHERE id = ?')
      .run(hostSessionId, iso(), sessionId);
  }

  updateSessionMeta(sessionId: string, patch: { model?: string; effort?: string; title?: string }): void {
    const current = this.session(sessionId);
    if (!current) return;
    this.db
      .prepare('UPDATE sessions SET model = ?, effort = ?, title = ?, updated_at = ? WHERE id = ?')
      .run(patch.model ?? current.model, patch.effort ?? current.effort, patch.title ?? current.title, iso(), sessionId);
  }

  // ---------------------------------------------------------------- 会话整理

  listConversationMeta(projectId: string): ConversationMetaRecord[] {
    return this.db.prepare('SELECT * FROM conversation_meta WHERE project_id = ?').all(projectId) as ConversationMetaRecord[];
  }

  conversationMeta(sessionId: string): ConversationMetaRecord | undefined {
    return this.db.prepare('SELECT * FROM conversation_meta WHERE session_id = ?').get(sessionId) as
      | ConversationMetaRecord
      | undefined;
  }

  /** 只写整理字段；成员名、宿主、模型和宿主会话 ID 仍由 sessions 表持有。 */
  updateConversationMeta(input: {
    projectId: string;
    sessionId: string;
    title?: string;
    pinned?: boolean;
    groupName?: string;
    archived?: boolean;
  }): ConversationMetaRecord {
    const current = this.conversationMeta(input.sessionId);
    const record: ConversationMetaRecord = {
      session_id: input.sessionId,
      project_id: input.projectId,
      title: input.title ?? current?.title ?? '',
      pinned: (input.pinned ?? current?.pinned === 1) ? 1 : 0,
      group_name: input.groupName ?? current?.group_name ?? '',
      archived: (input.archived ?? current?.archived === 1) ? 1 : 0,
      updated_at: iso(),
    };
    this.db
      .prepare(
        'INSERT INTO conversation_meta (session_id,project_id,title,pinned,group_name,archived,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, pinned=excluded.pinned, group_name=excluded.group_name, archived=excluded.archived, updated_at=excluded.updated_at',
      )
      .run(record.session_id, record.project_id, record.title, record.pinned, record.group_name, record.archived, record.updated_at);
    return record;
  }

  // ---------------------------------------------------------------- 主对话

  startRun(input: { projectId: string; sessionId: string; prompt: string; id?: string }): RunRecord {
    const record: RunRecord = {
      id: input.id ?? id('R'),
      project_id: input.projectId,
      session_id: input.sessionId,
      prompt: input.prompt,
      status: 'running',
      reply_text: '',
      error: '',
      seconds: 0,
      started_at: iso(),
      ended_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO runs (id,project_id,session_id,prompt,status,reply_text,error,seconds,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.id,
        record.project_id,
        record.session_id,
        record.prompt,
        record.status,
        record.reply_text,
        record.error,
        record.seconds,
        record.started_at,
        record.ended_at,
      );
    return record;
  }

  appendEvent(runId: string, seq: number, kind: string, payload: unknown): void {
    this.db.prepare('INSERT INTO run_events (run_id,seq,kind,payload,created_at) VALUES (?,?,?,?,?)').run(
      runId,
      seq,
      kind,
      JSON.stringify(payload ?? null),
      iso(),
    );
  }

  finishRun(runId: string, status: RunStatus, replyText: string, error = '', seconds = 0): void {
    this.db
      .prepare('UPDATE runs SET status = ?, reply_text = ?, error = ?, seconds = ?, ended_at = ? WHERE id = ?')
      .run(status, replyText, error, seconds, iso(), runId);
  }

  run(runId: string): RunRecord | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRecord | undefined;
  }

  runningRuns(projectId: string): RunRecord[] {
    return this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND status = 'running'").all(projectId) as RunRecord[];
  }

  projectRuns(projectId: string): RunRecord[] {
    return this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at').all(projectId) as RunRecord[];
  }

  /** 启动时把上一次没正常收尾的 run 标成中断，避免界面把它当成还在跑。 */
  markInterrupted(): number {
    const result = this.db
      .prepare("UPDATE runs SET status = 'failed', error = '进程重启，本轮中断', ended_at = ? WHERE status = 'running'")
      .run(iso());
    return result.changes;
  }

  firstUserTaskPrompt(projectId: string, sessionIds: string[]): string | undefined {
    if (!sessionIds.length) return undefined;
    const placeholders = sessionIds.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT prompt FROM runs
       WHERE project_id = ? AND session_id IN (${placeholders})
         AND trim(prompt) <> '' AND instr(prompt, ?) <> 1
       ORDER BY started_at, rowid LIMIT 1`,
    ).get(projectId, ...sessionIds, '项目里有人给你派了一件需要行动的事（派工 ID / 消息 ID：') as { prompt: string } | undefined;
    return row?.prompt;
  }

  listRunSummaries(projectId: string): Pick<RunRecord, 'id' | 'session_id' | 'status' | 'prompt' | 'started_at'>[] {
    return this.db.prepare('SELECT id, session_id, status, prompt, started_at FROM runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC')
      .all(projectId) as Pick<RunRecord, 'id' | 'session_id' | 'status' | 'prompt' | 'started_at'>[];
  }

  events(runId: string): RunEventRecord[] {
    return this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunEventRecord[];
  }

  /** 一整条会话的全部回合（按时间正序），分享和跨回合搜索共用同一个会话边界。 */
  sessionRuns(sessionId: string): RunRecord[] {
    return this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC').all(sessionId) as RunRecord[];
  }

  /** 在同一成员会话的所有回合里检索提问、回复和正文事件；返回按回合先后排列的命中位置。 */
  searchSession(sessionId: string, query: string, limit = 500): ConversationSearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: ConversationSearchHit[] = [];
    const countIn = (text: string | null | undefined): number[] => {
      if (!text) return [];
      const lower = text.toLowerCase();
      const found: number[] = [];
      let from = lower.indexOf(needle);
      while (from >= 0) {
        found.push(from);
        from = lower.indexOf(needle, from + needle.length);
      }
      return found;
    };
    const runs = this.sessionRuns(sessionId);
    const eventsByRun = new Map<string, RunEventRecord[]>();
    if (runs.length) {
      const placeholders = runs.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM run_events WHERE kind IN ('reasoning','chunk','notice') AND run_id IN (${placeholders}) ORDER BY run_id, seq ASC`)
        .all(...runs.map(run => run.id)) as RunEventRecord[];
      for (const row of rows) {
        const list = eventsByRun.get(row.run_id) ?? [];
        list.push(row);
        eventsByRun.set(row.run_id, list);
      }
    }
    for (const run of runs) {
      for (const index of countIn(run.prompt)) hits.push({ runId: run.id, seq: null, field: 'prompt', index });
      for (const index of countIn(run.reply_text)) hits.push({ runId: run.id, seq: null, field: 'reply', index });
      for (const event of eventsByRun.get(run.id) ?? []) {
        let text = '';
        try {
          const payload: unknown = JSON.parse(event.payload);
          text = typeof payload === 'string' ? payload : '';
        } catch {
          text = event.payload;
        }
        const field = event.kind === 'reasoning' ? 'reasoning' : event.kind === 'chunk' ? 'chunk' : 'notice';
        for (const index of countIn(text)) hits.push({ runId: run.id, seq: event.seq, field, index });
        if (hits.length >= limit) return hits.slice(0, limit);
      }
      if (hits.length >= limit) return hits.slice(0, limit);
    }
    return hits;
  }

  // ---------------------------------------------------------------- 成果

  addArtifact(input: Omit<ArtifactRecord, 'id' | 'created_at'> & { id?: string }): ArtifactRecord {
    const record: ArtifactRecord = { ...input, id: input.id ?? id('A'), created_at: iso() };
    this.db
      .prepare(
        'INSERT INTO artifacts (id,project_id,session_id,run_id,name,path,size,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.id,
        record.project_id,
        record.session_id,
        record.run_id,
        record.name,
        record.path,
        record.size,
        record.verified,
        record.created_at,
      );
    return record;
  }

  listArtifacts(sessionId: string): ArtifactRecord[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as ArtifactRecord[];
  }

  listProjectArtifacts(projectId: string): ArtifactRecord[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ArtifactRecord[];
  }

  // ---------------------------------------------------------------- 协作总线

  /** 总线快照整份落库：消息、回执、共享板、任务、成果和幂等记录一次事务提交。 */
  saveBusState(projectId: string, snapshot: { channelId: string; runId: string; state: unknown }): void {
    this.db
      .prepare('INSERT INTO bus_state (project_id,channel_id,run_id,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET channel_id=excluded.channel_id, run_id=excluded.run_id, payload=excluded.payload, updated_at=excluded.updated_at')
      .run(projectId, snapshot.channelId, snapshot.runId, JSON.stringify(snapshot.state), iso());
  }

  loadBusState(projectId: string): { channelId: string; runId: string; state: unknown } | undefined {
    const row = this.db.prepare('SELECT channel_id, run_id, payload FROM bus_state WHERE project_id = ?').get(projectId) as
      | { channel_id: string; run_id: string; payload: string }
      | undefined;
    if (!row) return undefined;
    return { channelId: row.channel_id, runId: row.run_id, state: JSON.parse(row.payload) };
  }

  busProjectIds(): string[] {
    const rows = this.db.prepare('SELECT project_id FROM bus_state').all() as { project_id: string }[];
    return [...new Set(rows.map(row => row.project_id.split('/')[0]))];
  }

  // ---------------------------------------------------------------- 压缩检测

  compactionState(sessionId: string): CompactionStateRecord | undefined {
    return this.db.prepare('SELECT * FROM compaction_state WHERE session_id = ?').get(sessionId) as
      | CompactionStateRecord
      | undefined;
  }

  private ensureCompaction(sessionId: string, projectId: string, host: string): CompactionStateRecord {
    const existing = this.compactionState(sessionId);
    if (existing) return existing;
    const record: CompactionStateRecord = {
      session_id: sessionId,
      project_id: projectId,
      host,
      host_session_id: '',
      confirmed_count: 0,
      manual_count: 0,
      estimate_count: 0,
      last_message_id: '',
      last_phase: '',
      limit_reached: 0,
      context_used: 0,
      context_size: 0,
      compact_budget: 0,
      last_growth: 0,
      baseline_used: 0,
      baseline_budget: 0,
      handoff_state: '',
      handoff_reason: '',
      successor_session_id: '',
      updated_at: iso(),
    };
    this.db
      .prepare(
        'INSERT INTO compaction_state (session_id,project_id,host,host_session_id,confirmed_count,manual_count,estimate_count,last_message_id,last_phase,limit_reached,context_used,context_size,compact_budget,last_growth,baseline_used,baseline_budget,handoff_state,handoff_reason,successor_session_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.session_id,
        record.project_id,
        record.host,
        record.host_session_id,
        record.confirmed_count,
        record.manual_count,
        record.estimate_count,
        record.last_message_id,
        record.last_phase,
        record.limit_reached,
        record.context_used,
        record.context_size,
        record.compact_budget,
        record.last_growth,
        record.baseline_used,
        record.baseline_budget,
        record.handoff_state,
        record.handoff_reason,
        record.successor_session_id,
        record.updated_at,
      );
    return record;
  }

  private writeCompaction(record: CompactionStateRecord): CompactionStateRecord {
    record.updated_at = iso();
    this.db
      .prepare(
        'UPDATE compaction_state SET project_id=?,host=?,host_session_id=?,confirmed_count=?,manual_count=?,estimate_count=?,last_message_id=?,last_phase=?,limit_reached=?,context_used=?,context_size=?,compact_budget=?,last_growth=?,baseline_used=?,baseline_budget=?,handoff_state=?,handoff_reason=?,successor_session_id=?,updated_at=? WHERE session_id=?',
      )
      .run(
        record.project_id,
        record.host,
        record.host_session_id,
        record.confirmed_count,
        record.manual_count,
        record.estimate_count,
        record.last_message_id,
        record.last_phase,
        record.limit_reached,
        record.context_used,
        record.context_size,
        record.compact_budget,
        record.last_growth,
        record.baseline_used,
        record.baseline_budget,
        record.handoff_state,
        record.handoff_reason,
        record.successor_session_id,
        record.updated_at,
        record.session_id,
      );
    return record;
  }

  /**
   * 落一次压缩信号。重复事件、历史回放和宿主切换都不会重复计数：
   * 计数以宿主给出的 messageId 为幂等键，换宿主会话则视为新的一段重新起算。
   */
  recordCompaction(input: {
    sessionId: string;
    projectId: string;
    host: string;
    hostSessionId?: string | null;
    path?: 'live' | 'replay' | 'estimate';
    phase?: 'start' | 'done' | 'cancelled' | 'limit';
    messageId?: string;
    compactType?: string;
    contextUsed?: number;
    contextSize?: number;
    budget?: number;
    baselineUsed?: number;
    baselineSize?: number;
    invalidateUsage?: boolean;
  }): { state: CompactionStateRecord; counted: boolean; reason: string } {
    this.db.exec('BEGIN');
    try {
      const result = this.applyCompaction(input);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private applyCompaction(input: Parameters<SwarmStore['recordCompaction']>[0]): {
    state: CompactionStateRecord; counted: boolean; reason: string;
  } {
    const record = this.ensureCompaction(input.sessionId, input.projectId, input.host);
    record.project_id = input.projectId;
    record.host = input.host;

    if (input.hostSessionId && input.hostSessionId !== record.host_session_id) {
      record.host_session_id = input.hostSessionId;
      record.confirmed_count = 0;
      record.manual_count = 0;
      record.estimate_count = 0;
      record.last_message_id = '';
      record.last_phase = '';
      record.limit_reached = 0;
      record.baseline_used = 0;
      record.baseline_budget = 0;
      record.context_used = 0;
      record.context_size = 0;
      record.compact_budget = 0;
      record.last_growth = 0;
    }

    if (input.path === 'replay') {
      return { state: record, counted: false, reason: 'replay-ignored' };
    }
    if (input.phase === 'done' && input.messageId) {
      const receipt = this.db.prepare(
        'INSERT OR IGNORE INTO compaction_receipts VALUES (?, ?, ?)',
      ).run(input.sessionId, record.host_session_id ?? '', input.messageId);
      if (receipt.changes === 0) return { state: record, counted: false, reason: 'duplicate' };
    }
    if (typeof input.contextUsed === 'number' && input.contextUsed >= 0) {
      const previous = record.context_used;
      // 首帧没有基线，不能把整段占用当成"单轮增长"。
      if (previous > 0 && input.contextUsed > previous) record.last_growth = input.contextUsed - previous;
      // 没有压缩广播的宿主（如 Antigravity）只能看占用回落：掉幅超过容量的 20% 记一次估算，
      // 只写 estimate_count，绝不写进 confirmed_count。
      const size = input.contextSize && input.contextSize > 0 ? input.contextSize : record.context_size;
      if (
        (input.host === 'Antigravity' || input.host.startsWith('Qoder'))
        && record.confirmed_count === 0
        && record.host_session_id
        && previous > 0
        && input.contextUsed < previous
        && size > 0
        && previous - input.contextUsed >= size * 0.2
      ) {
        record.estimate_count += 1;
      }
      record.context_used = input.contextUsed;
    }
    if (typeof input.contextSize === 'number' && input.contextSize >= 0) record.context_size = input.contextSize;
    if (typeof input.budget === 'number' && input.budget > 0) record.compact_budget = input.budget;

    const phase = input.phase ?? '';
    const messageId = input.messageId ?? '';
    let counted = false;
    let reason = '';

    if (phase === 'start') {
      record.last_message_id = messageId || record.last_message_id;
      record.last_phase = 'start';
      if (input.compactType !== 'manual' && record.confirmed_count === record.manual_count) {
        record.baseline_used = record.context_used;
        record.baseline_budget = record.compact_budget || record.context_size;
      }
      reason = 'started';
    } else if (phase === 'done') {
      if (messageId && messageId === record.last_message_id && record.last_phase === 'done') {
        reason = 'duplicate';
      } else {
        const firstCompaction = input.compactType !== 'manual' && record.confirmed_count === record.manual_count;
        record.confirmed_count += 1;
        if (firstCompaction && input.baselineUsed && input.baselineSize) {
          record.baseline_used = input.baselineUsed;
          record.baseline_budget = input.baselineSize;
        } else if (firstCompaction && !input.invalidateUsage && !record.baseline_used) {
          record.baseline_used = record.context_used;
          record.baseline_budget = record.compact_budget || record.context_size;
        }
        if (input.invalidateUsage) {
          record.context_used = 0;
          record.context_size = 0;
          record.last_growth = 0;
        }
        if (input.compactType === 'manual') {
          record.manual_count += 1;
          reason = 'manual';
        } else {
          reason = 'auto';
        }
        counted = true;
        record.last_message_id = messageId || record.last_message_id;
        record.last_phase = 'done';
      }
    } else if (phase === 'cancelled') {
      reason = 'cancelled';
    } else if (phase === 'limit') {
      record.limit_reached = 1;
      reason = 'limit';
    } else if (path === 'estimate') {
      reason = 'estimate';
    } else {
      reason = 'ignored';
    }

    return { state: this.writeCompaction(record), counted, reason };
  }

  /** 新席位和待确认状态同步落盘，启动被打断时可以恢复旧路由。 */
  createHandoffSuccessor(session: SessionRecord): SessionRecord {
    this.db.exec('BEGIN');
    try {
      const successor = this.createSession({
        projectId: session.project_id,
        memberLabel: session.member_label,
        host: session.host,
        model: session.model,
        effort: session.effort,
        title: session.title,
        groupId: session.group_id,
        parentSessionId: session.id,
      });
      if (!this.markHandoff(session.id, 'requested', { successorSessionId: successor.id, reason: '等待新宿主会话确认' })) {
        throw new Error('缺少旧会话的压缩检测记录');
      }
      this.db.exec('COMMIT');
      return successor;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 历史席位与其接手会话共用同一个协作身份。 */
  collaborationMemberId(sessionId: string): string {
    let current = sessionId;
    while (true) {
      const row = this.db.prepare(
        "SELECT session_id FROM compaction_state WHERE successor_session_id = ? AND handoff_state = 'done'",
      ).get(current) as { session_id: string } | undefined;
      if (!row) return current;
      current = row.session_id;
    }
  }

  isHandoffSuccessor(sessionId: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM compaction_state WHERE successor_session_id = ?',
    ).get(sessionId));
  }

  recoverInterruptedHandoffs(): void {
    this.db.prepare(
      "UPDATE compaction_state SET handoff_state = 'failed', handoff_reason = '进程重启，接手未确认' WHERE handoff_state = 'requested'",
    ).run();
  }

  /** 已完成接手的席位：后续派工落到接手会话，旧会话只留历史可回读。 */
  successorOf(sessionId: string): string | undefined {
    const record = this.compactionState(sessionId);
    if (!record || record.handoff_state !== 'done') return undefined;
    const next = record.successor_session_id;
    if (!next || next === sessionId) return undefined;
    return this.session(next) ? next : undefined;
  }

  /** 接手状态只写标记，不在这里换会话：换会话由调用方在压缩信号处理之外完成。 */
  markHandoff(sessionId: string, state: 'requested' | 'done' | 'failed', patch: { reason?: string; successorSessionId?: string } = {}): CompactionStateRecord | undefined {
    const record = this.compactionState(sessionId);
    if (!record) return undefined;
    record.handoff_state = state;
    if (patch.reason !== undefined) record.handoff_reason = patch.reason;
    if (patch.successorSessionId !== undefined) record.successor_session_id = patch.successorSessionId;
    return this.writeCompaction(record);
  }

  close(): void {
    this.db.close();
  }
}

export function defaultDataDir(): string {
  if (process.env.SWARM_DATA_DIR) return path.resolve(process.env.SWARM_DATA_DIR);
  return path.join(process.env.APPDATA ?? process.env.HOME ?? '.', 'SwarmIndependent');
}
