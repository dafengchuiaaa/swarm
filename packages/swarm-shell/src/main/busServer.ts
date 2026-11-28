/**
 * 协作服务的本地网关：Agent 只能通过一次 run 的 token 访问自己的信箱和频道。
 *
 * 为什么不用共享内存 / 起第二个数据库：总线状态只在 Electron 主进程里有一份权威副本，
 * MCP 进程只能提交"动作"，不能自己写状态，避免两边各写一份互相覆盖。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { OWNER, type TeamService } from '../../../swarm-team/src/service';
import type { BusCursor, BusMessage } from '../../../swarm-team/src/collaborationBus';

const OPENING_INBOX_LIMIT = 8;

interface Identity {
  projectId: string;
  memberId: string;
  runId: string;
  context?: { id: string; cursor: BusCursor };
  confirmedContext?: string;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'swarm_context',
    description: '读取自上次确认以来新增的上下文。收到 context_receipt 后用 swarm_ack 确认本页送达；消息全文用 swarm_read 回读。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回多少条，默认 8，上限 32' } },
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_read',
    description: '按消息 id 分页回读可见原文。续读时传该消息的 id 和返回的 next_offset。',
    inputSchema: {
      type: 'object',
      properties: {
        message_ids: { type: 'array', items: { type: 'string' }, description: '最多 16 个消息 id' },
        max_chars: { type: 'integer', minimum: 1, description: '子任务结果默认 800 字，普通消息默认 4000 字，上限 4000' },
        offset: { type: 'integer', minimum: 0, description: '从该位置读取，默认 0。续读使用该消息的 next_offset' },
      },
      required: ['message_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_say',
    description: '发留言或回复留言。回复已有留言时传 thread（原留言 ID），回复留在原串；省略 thread 会另发新帖。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的内容（人话，带结论和证据）' },
        to: { type: 'string', description: "收件成员 id 或 'all'（默认 all）" },
        channel: { type: 'string', description: '发新帖的频道 ID，默认主线。回复时传 thread 即可。' },
        thread: { type: 'string', description: '原留言或串内回复的消息 ID；回复已有留言时必填，省略才会新开一条' },
        evidence: { type: 'array', items: { type: 'string' }, description: '证据：消息 id、任务 id 或工作区文件路径' },
        requires_action: { type: 'boolean', description: '是否要求对方行动（会进派工队列）' },
        event_id: { type: 'string', description: '本次请求 id；重试时带同一个 id 只落一条' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_channel',
    description: '查看自己加入的频道，读频道消息，创建专题频道或把当前项目的成员加入频道。归档保留记录，可恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'create', 'invite', 'archive', 'restore'] },
        channel: { type: 'string', description: '频道 ID' },
        name: { type: 'string', description: '创建频道时使用的名称' },
        members: { type: 'array', items: { type: 'string' }, description: '本项目已有成员 ID' },
        before: { type: 'string', description: '读取更早消息时填上一页第一条消息 ID' },
        limit: { type: 'integer', description: '最多读取多少条，默认 8，上限 16' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_inbox',
    description: '读取信箱，优先返回点名消息和你发起的公告栏讨论串的新回复。回复附原帖 ID；处理后用 swarm_ack 确认该回复的消息 ID。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多取几条，默认 8，上限 16' } },
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_ack',
    description: '用 context_receipt 确认已收到增量页，或用 message_ids 确认已处理的消息。',
    inputSchema: {
      type: 'object',
      properties: { message_ids: { type: 'array', items: { type: 'string' } }, context_receipt: { type: 'string' }, receipt: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_board_read',
    description: '读取团队共享板当前的值和版本。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'swarm_board_write',
    description: '按版本号更新共享板；版本对不上会记冲突而不覆盖旧值。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
        expected_version: { type: 'number' },
        event_id: { type: 'string' },
      },
      required: ['key', 'value', 'expected_version'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_report',
    description: '汇报自己的任务进度。in_progress 需要给出下一步；blocked 必须说明原因。',
    inputSchema: {
      type: 'object',
      properties: {
        progress: { type: 'string', enum: ['in_progress', 'submitted', 'blocked'] },
        evidence: { type: 'array', items: { type: 'string' } },
        next: { type: 'string' },
        blocker: { type: 'string' },
        event_id: { type: 'string' },
      },
      required: ['progress'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_artifact',
    description: '交付成果。给真实工作区路径时必须确实存在且在项目工作区内；也可以直接给内容。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        event_id: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_dispatch',
    description: '向另一位 Agent 的信箱派工并启动它。已有成员传 to 和 text，也可传宿主 host、模型 model 和任务 text。请它回复公告栏时用 thread 引用原留言，蜂群在私信附上引用，由收件成员自行回复。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        host: { type: 'string', description: '已启用的宿主，例如 CodeBuddy、Qoder、Antigravity' },
        model: { type: 'string', description: '宿主的模型 ID，例如 glm-5.3-flash' },
        text: { type: 'string' },
        thread: { type: 'string', description: '可选的原留言消息 ID，作为信箱任务的参考' },
        evidence: { type: 'array', items: { type: 'string' } },
        workspace_mode: {
          type: 'string',
          enum: ['worktree', 'inherit'],
          description: '工作区模式：worktree 为独立 Git 工作树隔离（子成员默认），inherit 为共享主工作区',
        },
        event_id: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'swarm_fanout',
    description: '批量分片派工：一次性把多个独立子任务并行派发给多个分片成员（默认各自使用独立 Git Worktree 隔离），适合多文件/多模块并行开发。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '分片成员名称，如 分片-1' },
              text: { type: 'string', description: '该分片的具体任务' },
              to: { type: 'string', description: '可选，指定已有成员 ID 或名称' },
              host: { type: 'string', description: '可选，宿主名' },
              model: { type: 'string', description: '可选，模型 ID' },
              workspace_mode: { type: 'string', enum: ['worktree', 'inherit'] },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        default_host: { type: 'string', description: '未在单项指定 to/host 时的默认宿主' },
        default_model: { type: 'string', description: '未在单项指定 to/model 时的默认模型' },
        workspace_mode: { type: 'string', enum: ['worktree', 'inherit'], description: '默认工作区模式，默认 worktree' },
        thread: { type: 'string', description: '可选的原留言消息 ID' },
        event_id: { type: 'string', description: '可选的幂等前缀' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
];

export class BusGateway {
  private readonly http = createServer((request, response) => void this.handle(request, response));
  private readonly tokens = new Map<string, Identity>();
  private port = 0;

  constructor(
    private readonly team: TeamService,
    private readonly onAction?: (input: {
      projectId: string;
      memberId: string;
      messageId: string;
      text: string;
      workspaceMode?: 'worktree' | 'inherit';
    }) => void,
    private readonly onChanged?: (projectId: string) => void,
    private readonly provisionMember?: (input: {
      projectId: string;
      from: string;
      host: string;
      model: string;
      label?: string;
      dedicated?: boolean;
      workspaceMode?: 'worktree' | 'inherit';
    }) => Promise<string>,
  ) {}

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.http.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.http.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  issue(projectId: string, memberId: string, runId: string, dispatchId?: string): {
    token: string; url: string; openingInbox: string[];
  } {
    const messages = this.team.openingInbox(projectId, memberId, dispatchId);
    const openingInbox = this.inboxLines(projectId, messages.slice(0, OPENING_INBOX_LIMIT), true);
    const remaining = messages.length - OPENING_INBOX_LIMIT;
    if (remaining > 0) {
      openingInbox.push(`另有 ${remaining} 条待看消息，需要时用 swarm_inbox 读取。`);
    }
    const token = randomUUID().replace(/-/g, '');
    this.tokens.set(token, { projectId, memberId, runId });
    return { token, url: this.url, openingInbox };
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  private inboxLines(projectId: string, messages: BusMessage[], preview = false): string[] {
    if (!messages.length) return [];
    const labels = this.team.memberLabels(projectId);
    return messages.map(message => {
      const scope = message.channel.startsWith('dm:') ? '私信' : message.threadId ? '公告栏回复' : '频道';
      const thread = message.threadId ? `，原帖 ${message.threadId}` : '';
      const evidence = !preview && message.evidence?.length ? `（证据：${message.evidence.join(' / ')}）` : '';
      const text = preview && message.text.length > 400
        ? `${message.text.slice(0, 400)}…（完整内容可用 swarm_read 回读）`
        : message.text;
      return `[${message.id}] 来自 ${labels.get(message.sender) ?? message.sender}（${scope}${thread}）：${text}${evidence}`;
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const auth = String(request.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const identity = this.tokens.get(token);
      if (!identity) {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'token 无效' }));
        return;
      }
      try {
        if (request.method === 'GET' && request.url === '/tools') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, tools: TOOLS }));
          return;
        }
        if (request.method !== 'POST' || request.url !== '/tool') {
          response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: '未知入口' }));
          return;
        }
        const body = await readBody(request);
        const payload = JSON.parse(body || '{}') as { name?: string; args?: Record<string, unknown> };
        const result = await this.call(identity, String(payload.name), payload.args ?? {});
        this.onChanged?.(identity.projectId);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: (error as Error).message }),
        );
      }
  }

  /** Agent 可能报成员 ID，也可能报成员名；两种都认，重名或多义直接拒绝。 */
  private resolveMember(projectId: string, memberId: string, raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) throw new Error('收件人不能为空');
    if (value === 'all') return 'all';
    const members = this.team.members(projectId, memberId);
    const byId = members.find(item => item.id === value);
    if (byId) return byId.id;
    const byLabel = members.filter(item => item.label === value);
    if (byLabel.length === 1) return byLabel[0].id;
    throw new Error(byLabel.length > 1 ? `成员名「${value}」对应多个成员，请用成员 ID` : `成员不存在：${value}`);
  }

  private async call(identity: Identity, name: string, args: Record<string, unknown>): Promise<{ text: string; data?: unknown }> {
    const { projectId, memberId } = identity;
    const team = this.team;
    switch (name) {
      case 'swarm_channel': {
        const action = args.action;
        const channelId = String(args.channel ?? '');
        if (action === 'list') {
          const channels = team.agentChannels(projectId, memberId);
          return { text: channels.map(channel => `${channel.name} · ${channel.id}${channel.archived ? '（已归档）' : ''}`).join('\n'), data: { channels } };
        }
        if (action === 'read') {
          const requested = Number(args.limit ?? 8);
          const limit = Number.isFinite(requested) ? Math.max(1, Math.min(16, Math.trunc(requested))) : 8;
          const messages = team.readChannel(projectId, memberId, channelId, limit, args.before ? String(args.before) : undefined)
            .map(({ id, senderLabel, text, threadId }) => ({ id, senderLabel, threadId, preview: text.slice(0, 240) }));
          return {
            text: messages.map(message => `[${message.id}] ${message.senderLabel}${message.threadId ? `（回复 ${message.threadId}）` : ''}：${message.preview}`).join('\n')
              || '频道里还没有消息。', data: { messages, before: messages.length === limit ? messages[0]?.id : undefined },
          };
        }
        if (action !== 'create' && action !== 'invite' && action !== 'archive' && action !== 'restore') {
          throw new Error('未知频道操作');
        }
        const channel = team.manageChannel({ projectId, from: memberId, operation: action, channelId,
          name: String(args.name ?? ''), memberIds: Array.isArray(args.members) ? args.members.map(String) : [] });
        return { text: `${channel.name} · ${channel.id}${channel.archived ? '（已归档）' : ''}`, data: { channel } };
      }
      case 'swarm_context': {
        const limit = Number(args.limit ?? 8);
        const { cursor, ...context } = team.context(projectId, memberId, Number.isFinite(limit) ? limit : 8);
        const receipt = context.items.length ? randomUUID() : undefined;
        if (receipt) identity.context = { id: receipt, cursor };
        const lines = [
          `项目 ${context.project}｜工作区 ${context.workspace}`,
          ...context.items.map(item => item.text),
        ];
        if (!context.items.length) lines.push('没有新变化。');
        if (receipt) lines.push(`确认收到：swarm_ack({"context_receipt":"${receipt}"})。`);
        lines.push(`待接派工 ${context.pending} 条${context.remaining ? `；另有 ${context.remaining} 条没装下，下次再读` : ''}。`);
        return { text: lines.join('\n'), data: { ...context, context_receipt: receipt } };
      }
      case 'swarm_read': {
        const ids = Array.isArray(args.message_ids) ? args.message_ids.map(String) : [];
        if (!ids.length) throw new Error('必须给出消息 id');
        const maxChars = args.max_chars;
        const offset = args.offset ?? 0;
        if ((maxChars !== undefined && typeof maxChars !== 'number') || typeof offset !== 'number') {
          throw new Error('max_chars 和 offset 必须是数字');
        }
        const messages = team.readMessages(projectId, memberId, ids, maxChars, offset);
        const lines = messages.length
          ? messages.map(message => {
              const next = message.next_offset === null ? '' :
                `\n续读：swarm_read(${JSON.stringify({ message_ids: [message.id], offset: message.next_offset })})`;
              return `[${message.id}] ${message.senderLabel}：${message.text}${next}`;
            })
          : ['没有可读的消息（可能不属于你或 id 不存在）。'];
        return { text: lines.join('\n\n'), data: { messages } };
      }
      case 'swarm_say':
      case 'swarm_dispatch': {
        const isDispatch = name === 'swarm_dispatch';
        const task = String(args.text ?? '').trim();
        if (isDispatch && !task) throw new Error('派工内容不能为空');
        const workspaceMode =
          args.workspace_mode === 'inherit' || args.workspace_mode === 'worktree' ? args.workspace_mode : undefined;
        let to: string;
        if (isDispatch && (args.host || args.model)) {
          if (args.to) throw new Error('请选已有成员 to，或传 host 和 model');
          if (!this.provisionMember) throw new Error('当前入口需要指定已有成员');
          const host = String(args.host ?? '').trim();
          const model = String(args.model ?? '').trim();
          if (!host || !model) throw new Error('派工请传 to，或同时传 host 和 model');
          to = await this.provisionMember({ projectId, from: memberId, host, model, workspaceMode });
        } else {
          to = this.resolveMember(projectId, memberId, args.to ?? (isDispatch ? '' : 'all'));
        }
        if (isDispatch && (to === memberId || to === 'all' || to === OWNER)) {
          throw new Error('派工对象须为另一位 Agent 成员');
        }
        const accepted = team.post({
          projectId,
          from: memberId,
          to,
          text: String(args.text ?? ''),
          thread: args.thread ? String(args.thread) : undefined,
          channel: !isDispatch && args.channel ? String(args.channel) : undefined,
          evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [],
          // 只有显式派工才会触发对方开跑；普通发言（含私信）不启动回合，避免自动对轰
          requiresAction: isDispatch,
          eventId: args.event_id ? String(args.event_id) : undefined,
        });
        const text =
          accepted.messageIds.length === 0
            ? `这次请求已经落过（重试未重复发布）。${accepted.result}`
            : `已发布消息 ${accepted.messageIds.join(', ')}，收件人 ${to}。${accepted.conflicts.length ? `共享板冲突 ${accepted.conflicts.length} 条，见频道。` : ''}`;
        if (isDispatch) {
          for (const messageId of accepted.messageIds) {
            this.onAction?.({ projectId, memberId: to, messageId, text: accepted.result, workspaceMode });
          }
        }
        return isDispatch
          ? { text: accepted.messageIds.length ? `已派工给「${team.labelOf(projectId, to)}」，派工 ID：${accepted.messageIds.join(', ')}。可在成员席查看进度和回复。` : text,
            data: { ...accepted, member_id: to } }
          : { text, data: accepted };
      }
      case 'swarm_fanout': {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (!rawTasks.length) throw new Error('tasks 不能为空');
        if (rawTasks.length > 16) throw new Error('单次批量分片最多 16 项');
        const defaultHost = String(args.default_host ?? '').trim();
        const defaultModel = String(args.default_model ?? '').trim();
        const defaultMode = args.workspace_mode === 'inherit' ? 'inherit' : 'worktree';
        const thread = args.thread ? String(args.thread) : undefined;
        const eventPrefix = args.event_id ? String(args.event_id) : '';
        const dispatches: Array<{
          index: number;
          member_id: string;
          member_label: string;
          message_ids: string[];
          workspace_mode: 'worktree' | 'inherit';
        }> = [];
        for (let i = 0; i < rawTasks.length; i += 1) {
          const item = (rawTasks[i] ?? {}) as Record<string, unknown>;
          const taskText = String(item.text ?? '').trim();
          if (!taskText) throw new Error(`第 ${i + 1} 个分片任务内容不能为空`);
          const mode = item.workspace_mode === 'inherit' || item.workspace_mode === 'worktree' ? item.workspace_mode : defaultMode;
          let to: string;
          if (item.to) {
            to = this.resolveMember(projectId, memberId, item.to);
          } else {
            if (!this.provisionMember) throw new Error('当前入口不支持自动新建分片成员');
            const host = String(item.host ?? defaultHost).trim();
            const model = String(item.model ?? defaultModel).trim();
            if (!host || !model) throw new Error(`第 ${i + 1} 个分片缺少 to，或 default_host / default_model`);
            const label = String(item.label ?? '').trim() || `分片-${i + 1}`;
            to = await this.provisionMember({
              projectId,
              from: memberId,
              host,
              model,
              label,
              dedicated: true,
              workspaceMode: mode,
            });
          }
          if (to === memberId || to === 'all' || to === OWNER) {
            throw new Error(`第 ${i + 1} 个分片派工对象须为另一位 Agent 成员`);
          }
          const accepted = team.post({
            projectId,
            from: memberId,
            to,
            text: taskText,
            thread,
            requiresAction: true,
            eventId: eventPrefix ? `${eventPrefix}:${i}` : undefined,
          });
          for (const messageId of accepted.messageIds) {
            this.onAction?.({ projectId, memberId: to, messageId, text: accepted.result, workspaceMode: mode });
          }
          dispatches.push({
            index: i,
            member_id: to,
            member_label: team.labelOf(projectId, to),
            message_ids: accepted.messageIds,
            workspace_mode: mode,
          });
        }
        const summary = dispatches
          .map(d => `#${d.index + 1}「${d.member_label}」(${d.workspace_mode}) -> ${d.message_ids.join(', ') || '已幂等跳过'}`)
          .join('\n');
        return {
          text: `已批量分片派工 ${dispatches.length} 项：\n${summary}`,
          data: { dispatches },
        };
      }
      case 'swarm_inbox': {
        const limit = Number(args.limit ?? 8);
        const messages = team.takeInbox(projectId, memberId, Math.max(1, Math.min(16, Number.isFinite(limit) ? limit : 8)));
        const lines = this.inboxLines(projectId, messages);
        return { text: lines.length ? lines.join('\n') : '信箱为空。', data: { messages } };
      }
      case 'swarm_ack': {
        const ids = Array.isArray(args.message_ids) ? args.message_ids.map(String) : [];
        const receipt = args.context_receipt ?? args.receipt;
        const needsConfirmation = receipt && receipt !== identity.confirmedContext;
        const context = needsConfirmation ? identity.context : undefined;
        if (needsConfirmation && context?.id !== receipt) throw new Error('上下文回执已失效，请重新读取增量');
        if (context || ids.length) team.ack(projectId, memberId, ids, context?.cursor);
        if (context) {
          identity.confirmedContext = context.id;
          identity.context = undefined;
        }
        return { text: `${receipt ? '已确认收到上下文。' : ''}${ids.length || !receipt ? `已确认处理 ${ids.length} 条消息。` : ''}` };
      }
      case 'swarm_board_read': {
        const board = team.board(projectId, memberId);
        return { text: JSON.stringify(board, null, 2), data: board };
      }
      case 'swarm_board_write': {
        const accepted = team.writeBoard({
          projectId,
          from: memberId,
          key: String(args.key ?? ''),
          value: String(args.value ?? ''),
          expectedVersion: Number(args.expected_version ?? 0),
          eventId: args.event_id ? String(args.event_id) : undefined,
        });
        return {
          text: accepted.conflicts.length
            ? `版本冲突，未覆盖：期望 ${accepted.conflicts[0].expected}，实际 ${accepted.conflicts[0].actual}。请先读共享板。`
            : `共享板 ${args.key} 已更新。`,
          data: accepted,
        };
      }
      case 'swarm_report': {
        const accepted = team.report({
          projectId,
          from: memberId,
          progress: String(args.progress ?? 'in_progress') as 'in_progress' | 'submitted' | 'blocked',
          evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [],
          next: args.next ? String(args.next) : undefined,
          blocker: args.blocker ? String(args.blocker) : undefined,
          eventId: args.event_id ? String(args.event_id) : undefined,
        });
        return { text: `任务进度已记录（版本见任务回执）。`, data: accepted };
      }
      case 'swarm_artifact': {
        const accepted = team.submitArtifact({
          projectId,
          from: memberId,
          runId: identity.runId,
          name: String(args.name ?? ''),
          path: args.path ? String(args.path) : undefined,
          content: args.content ? String(args.content) : undefined,
          eventId: args.event_id ? String(args.event_id) : undefined,
        });
        return { text: `成果已登记：${accepted.artifactIds.join(', ')}`, data: accepted };
      }
      default:
        throw new Error(`未知工具：${name}`);
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) request.destroy(new Error('请求过大'));
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}
