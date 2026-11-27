/**
 * 压缩检测与新会话接手：判据、交接材料、接手动作。
 *
 * 三条口径：
 * 1. 只有宿主自己广播的压缩事件才计数（`confirmed_count`）。估算单独放着，不冒充已确认。
 * 2. “接近第二次压缩”以宿主**自己第一次压缩时的实测占用**为基准，再预留下交接余量；
 *    拿不到实测点就不自动触发，只报覆盖缺口，不拍一个百分比。
 * 3. 交接材料只从落库记录里取（任务目标、回合、成果路径、在途派工），不让模型凭记忆写摘要。
 */
import type { CompactionStateRecord, SessionRecord, SwarmStore } from './store';

/** 宿主桥发上来的压缩载荷：字段名沿用 Python 侧的蛇形命名。 */
export interface CompactionEventPayload {
  source?: string;
  host?: string;
  path?: 'live' | 'replay' | 'estimate';
  phase?: 'start' | 'done' | 'cancelled' | 'limit';
  message_id?: string;
  compact_type?: string;
  confirmed?: boolean;
  context_used?: number;
  context_size?: number;
  budget?: number;
  baseline_used?: number;
  baseline_size?: number;
  invalidate_usage?: boolean;
}

/** 第一次压缩实测点之前要预留的交接余量：留给组装材料与新会话起跑，不是拍脑袋的压缩阈值。 */
export const HANDOFF_RESERVE = 0.9;

export type DecisionLevel = 'none' | 'watch' | 'handoff' | 'limit' | 'stage';

export function isStageTask(goal: string): boolean {
  return /^\s*(?:【阶段性任务】|\[阶段性任务\]|阶段性任务[：:]|任务类型[：:]\s*阶段性任务)/u.test(goal.replace(/^\s*【团队目标】/u, ''));
}

export interface CompactionDecision {
  level: DecisionLevel;
  /** 当前占用 / 预算。预算来自宿主：显式 autocompact 值或上报容量。 */
  ratio: number | null;
  /** 首次压缩时的实测占比；没有就是未知，不做自动触发。 */
  baselineRatio: number | null;
  /** 判据出处，直接写给人看，不藏术语。 */
  basis: string;
  confirmedCount: number;
  autoCount: number;
  /** 无事件宿主靠占用回落估出来的次数，只作参考，不算已确认。 */
  estimateCount: number;
  limitReached: boolean;
  /** 估算档用到的容量与实测单轮增长。 */
  capacity: number;
  lastGrowth: number;
}

function safeRatio(used: number, budget: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0 || used < 0) return null;
  return used / budget;
}

/** 当前占比：优先用宿主显式预算，其次用上报容量。 */
export function currentRatio(state: CompactionStateRecord): { ratio: number | null; basis: string } {
  if (state.compact_budget > 0) {
    const ratio = safeRatio(state.context_used, state.compact_budget);
    return { ratio, basis: ratio === null ? '宿主预算已知但缺当前占用' : '宿主 autocompact 预算' };
  }
  const ratio = safeRatio(state.context_used, state.context_size);
  return { ratio, basis: ratio === null ? '宿主未上报占用或容量' : '宿主上报上下文容量' };
}

export function compactionDecision(state: CompactionStateRecord, stageTask = false): CompactionDecision {
  const { ratio, basis } = currentRatio(state);
  const baselineRatio = state.baseline_used > 0 && state.baseline_budget > 0 ? safeRatio(state.baseline_used, state.baseline_budget) : null;
  const autoCount = Math.max(0, state.confirmed_count - state.manual_count);
  const capacity = state.compact_budget > 0 ? state.compact_budget : state.context_size;
  const base: Omit<CompactionDecision, 'level' | 'basis'> = {
    ratio,
    baselineRatio,
    confirmedCount: state.confirmed_count,
    autoCount,
    estimateCount: state.estimate_count,
    limitReached: state.limit_reached === 1,
    capacity,
    lastGrowth: state.last_growth,
  };

  if (state.handoff_state === 'done' || state.handoff_state === 'requested') {
    return { ...base, level: 'none', basis: '已进入接手流程，不重复触发' };
  }
  // 宿主自报压不动了：这是真实容量告警，直接接手，不等下一次。
  if (base.limitReached) return { ...base, level: 'limit', basis: '宿主 compact-limit-reached' };

  if (stageTask && (autoCount >= 1 || state.estimate_count >= 1)) {
    return { ...base, level: 'stage', basis: autoCount >= 1 ? '阶段任务已首次压缩，保存阶段交接' : '估算：阶段任务出现首次压缩迹象，保存阶段交接' };
  }

  if (autoCount < 1) {
    // 没有压缩广播的宿主（Antigravity）：首次压缩允许继续，抓到“压缩后回落”才判第二次。
    if (state.estimate_count < 1) {
      return { ...base, level: 'none', basis: `${basis}；无宿主压缩事件，也还没有压缩回落证据` };
    }
    if (ratio === null || capacity <= 0) {
      return { ...base, level: 'watch', basis: '有压缩回落证据，但宿主没给占用或容量' };
    }
    if (state.last_growth <= 0) {
      return { ...base, level: 'watch', basis: '有压缩回落证据，但缺单轮增长实测，只能观察' };
    }
    // 余量按实测增长算，不用统一百分比：留两轮的增长空间给组装材料和新会话起跑。
    const reserve = (state.last_growth * 2) / capacity;
    if (ratio >= 1 - reserve) {
      return {
        ...base,
        level: 'handoff',
        basis: `估算：容量 ${capacity}，最近单轮增长 ${state.last_growth}，预留两轮后已用 ${Math.round(ratio * 100)}%`,
      };
    }
    return {
      ...base,
      level: 'none',
      basis: `估算：已用 ${Math.round(ratio * 100)}%，按单轮增长 ${state.last_growth} 预留两轮仍有余量`,
    };
  }

  if (state.baseline_budget > 0 && capacity > 0 && state.baseline_budget !== capacity) {
    return { ...base, level: 'watch', basis: '宿主容量与首次压缩时不同，暂不套用旧阈值' };
  }
  if (baselineRatio === null || ratio === null || state.context_used <= 0) {
    return { ...base, level: 'watch', basis: '已确认首次压缩，但缺实测占用点，只能观察不能自动判定第二次' };
  }
  if (ratio >= baselineRatio * HANDOFF_RESERVE) {
    return {
      ...base,
      level: 'handoff',
      basis: `已用 ${Math.round(ratio * 100)}%，达到首次压缩实测点 ${Math.round(baselineRatio * 100)}% 的 ${Math.round(HANDOFF_RESERVE * 100)}%`,
    };
  }
  return { ...base, level: 'none', basis: `已用 ${Math.round(ratio * 100)}%，距首次压缩实测点 ${Math.round(baselineRatio * 100)}% 仍有余量` };
}

export interface HandoffExtras {
  /** 在途派工：调用方从总线的派工队列取，不在这里猜。 */
  pendingDispatches?: string[];
  /** 未处理信箱条目。 */
  unread?: string[];
  /** 任务范围说明：阶段任务还是长程任务，来自用户或任务单原文。 */
  scope?: string;
  goal?: string;
  next?: string;
  evidence?: string[];
}

export interface HandoffFacts {
  goal: string;
  constraints: string[];
  decisions: string[];
  done: string[];
  pending: string[];
  artifacts: { path: string; verified: boolean }[];
  evidence: string[];
  dispatches: string[];
  unread: string[];
}

/** 交接材料：全部来自落库记录，缺什么就写明缺，不补想象。 */
export function buildHandoffFacts(store: SwarmStore, sessionId: string, extras: HandoffExtras = {}): HandoffFacts {
  const session = store.session(sessionId);
  const project = session ? store.project(session.project_id) : undefined;
  const runs = store.sessionRuns(sessionId);
  const artifacts = store.listArtifacts(sessionId);
  const state = store.compactionState(sessionId);

  const goal = extras.goal || runs[0]?.prompt || '';
  const doneRuns = runs.filter(run => run.status === 'done');
  const failedRuns = runs.filter(run => run.status === 'failed');
  const runningRuns = runs.filter(run => run.status === 'running');

  const facts: HandoffFacts = {
    goal,
    constraints: [
      project ? `工作区：${project.workspace}` : '工作区未记录',
      session ? `成员：${session.member_label}（${session.host} / ${session.model}${session.effort ? ` / ${session.effort}` : ''}）` : '成员信息缺失',
      extras.scope ? `任务范围：${extras.scope}` : '任务范围：未在记录中写明（按长程处理，首次压缩后继续）',
    ],
    decisions: [],
    done: doneRuns.slice(-5).map(run => `${run.started_at} 完成，回复摘要：${run.reply_text.slice(0, 200)}`),
    pending: [
      ...(extras.next ? [extras.next] : []),
      ...runningRuns.map(run => `${run.started_at} 起跑未收尾：${run.prompt.slice(0, 160)}`),
      ...failedRuns.slice(-3).map(run => `${run.started_at} 失败：${run.error.slice(0, 120)}`),
    ],
    artifacts: artifacts.map(item => ({ path: item.path, verified: item.verified === 1 })),
    evidence: [...(extras.evidence ?? [])],
    dispatches: extras.pendingDispatches ?? [],
    unread: extras.unread ?? [],
  };

  if (state) {
    facts.evidence.push(
      `压缩记录：已确认 ${state.confirmed_count} 次（其中自动 ${Math.max(0, state.confirmed_count - state.manual_count)} 次），宿主会话 ${state.host_session_id || '未绑定'}`,
    );
    if (state.context_used > 0) facts.evidence.push(`最近占用：${state.context_used}${state.compact_budget > 0 ? ` / ${state.compact_budget}` : state.context_size > 0 ? ` / ${state.context_size}` : ''}`);
    if (state.limit_reached === 1) facts.evidence.push('宿主已报 compact-limit-reached');
    if (state.estimate_count > 0) {
      facts.evidence.push(`估算：占用回落 ${state.estimate_count} 次（该宿主没有压缩广播，仅供参考，未计入已确认）`);
    }
  }
  if (!artifacts.length) facts.evidence.push('本次会话暂无登记成果，接手后需重新核对磁盘');
  return facts;
}

export function renderHandoffBrief(session: SessionRecord | undefined, facts: HandoffFacts): string {
  const section = (title: string, lines: string[]): string =>
    [`【${title}】`, ...(lines.length ? lines.map(line => `- ${line}`) : ['- 无记录']), ''].join('\n');
  return [
    '【接手说明】这是同一成员、同一项目的新宿主会话。旧会话历史保留可回读，下列内容取自记录，不是模型回忆。',
    session ? `旧会话：${session.id}（宿主 ${session.host}，模型 ${session.model}）` : '旧会话：未取到',
    '',
    section('当前目标', facts.goal ? [facts.goal] : []),
    section('硬约束', facts.constraints),
    section('已完成', facts.done),
    section('未完成', facts.pending),
    section('成果路径', facts.artifacts.map(item => `${item.path}${item.verified ? '' : '（未核实）'}`)),
    section('证据与判据', facts.evidence),
    section('在途派工', facts.dispatches),
    section('未处理信箱', facts.unread),
    '【要求】接手后先核对上述路径是否存在，再继续未完成事项；不要重复已完成的派工，也不要假装知道旧会话里没记录的内容。',
  ].join('\n');
}

export interface HandoffResult {
  ok: boolean;
  fromSessionId: string;
  toSessionId?: string;
  brief?: string;
  error?: string;
}

/**
 * 真实换会话：新开一条成员席位，宿主会话 ID 留空由下一次真实回合绑定，
 * 旧席位保留原宿主会话 ID 以便回读。失败只留原因，不动旧席位和待办。
 */
export function startHandoff(store: SwarmStore, sessionId: string, extras: HandoffExtras = {}): HandoffResult {
  const session = store.session(sessionId);
  if (!session) return { ok: false, fromSessionId: sessionId, error: '成员会话不存在' };

  const state = store.compactionState(sessionId);
  if (state && (state.handoff_state === 'done' || state.handoff_state === 'requested')) {
    return { ok: false, fromSessionId: sessionId, error: '已经进入接手流程，不重复换会话' };
  }

  const facts = buildHandoffFacts(store, sessionId, extras);
  const brief = renderHandoffBrief(session, facts);
  if (!facts.goal) return { ok: false, fromSessionId: sessionId, error: '旧会话没有可交接的目标记录，先补任务说明再接手' };


  try {
    const successor = store.createHandoffSuccessor(session);
    return { ok: true, fromSessionId: sessionId, toSessionId: successor.id, brief };
  } catch (error) {
    const message = (error as Error).message || '接手失败';
    store.markHandoff(sessionId, 'failed', { reason: message });
    return { ok: false, fromSessionId: sessionId, error: message, brief };
  }
}

/** 只有交接回合真实完成并取得独立的宿主会话，才提交路由切换。 */
export function finishHandoff(store: SwarmStore, from: string, runId: string, error?: string): string | undefined {
  const state = store.compactionState(from);
  if (state?.handoff_state !== 'requested') return '没有待确认的接手';
  const run = store.run(runId);
  const original = store.session(from);
  const successor = store.session(state.successor_session_id);
  const nextHost = successor?.host_session_id;
  const failure = error || (!nextHost || nextHost === original?.host_session_id ? '新宿主会话未绑定' :
    run?.session_id !== successor?.id || run?.status !== 'done' || !/^已接手[。.]?$/u.test(run.reply_text.trim())
      ? '新会话未确认收到交接' : undefined);
  store.markHandoff(from, failure ? 'failed' : 'done', { reason: failure ?? '新宿主会话已确认收到交接' });
  return failure;
}
