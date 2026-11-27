// 额度行展示决策：单宿主临时读取失败时保留上次成功数值并标注，
// 已连接但尚无成功数值时显示读取状态，而不是整行消失。

export interface AccountQuota {
  status: string;
  note?: string;
  plan?: string;
  source?: string;
  updated?: number;
  amount?: number;
  currency?: string;
  balances?: string[];
  windows?: { label: string; remaining_percent?: number; resets_at?: number }[];
}

export interface QuotaTile {
  data: AccountQuota;
  value: string;
  percent: number | null;
  windows: NonNullable<AccountQuota['windows']>;
  /** true = 本次读取失败，展示的是上次成功数值 */
  stale: boolean;
  /** true = 尚无任何成功数值，展示读取状态占位 */
  pending: boolean;
}

/** 从一份额度数据算出可显示数值；算不出返回 null。与旧版口径一致。 */
export function quotaValue(data: AccountQuota | undefined): { value: string; percent: number | null; windows: NonNullable<AccountQuota['windows']> } | null {
  if (!data || data.status !== 'ready') return null;
  const credits = data.currency === 'credits';
  const windows = credits ? [] : (data.windows ?? []).filter(item => Number.isFinite(item.remaining_percent));
  const percent = windows.length ? Math.min(...windows.map(item => item.remaining_percent!)) : null;
  const amount = data.amount;
  const value = amount !== undefined && Number.isFinite(amount) && credits
    ? `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 积分`
    : percent !== null ? `${Math.round(percent)}%`
    : data.currency === 'CNY' && amount !== undefined && Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : null;
  if (!value) return null;
  return { value, percent, windows };
}

/**
 * 决定一个已连接宿主的额度行：
 * 1. 本次数据可显示 → 用新值；
 * 2. 本次失败 / 缺行，但有上次成功值 → 保留旧值并标 stale；
 * 3. 从未成功过 → 读取状态占位（读取中 / 读取失败）。
 */
export function resolveQuotaTile(incoming: AccountQuota | undefined, lastGood: AccountQuota | undefined, busy: boolean): QuotaTile {
  const fresh = quotaValue(incoming);
  if (fresh && incoming) return { data: incoming, ...fresh, stale: false, pending: false };
  const kept = quotaValue(lastGood);
  if (kept && lastGood) return { data: lastGood, ...kept, stale: true, pending: false };
  const placeholder: AccountQuota = { status: incoming?.status ?? 'pending', note: incoming?.note };
  return { data: placeholder, value: busy ? '读取中' : '读取失败', percent: null, windows: [], stale: false, pending: true };
}

/**
 * 合并一次额度回包：按宿主覆盖，缺行的宿主保留旧数据（子进程超时的部分回包）。
 * 同时把每个可显示的 ready 值记入 lastGood。
 */
export function mergeQuotas(
  previous: Record<string, AccountQuota>,
  accounts: Record<string, AccountQuota>,
  lastGood: Record<string, AccountQuota>,
): { quotas: Record<string, AccountQuota>; lastGood: Record<string, AccountQuota> } {
  const quotas = { ...previous, ...accounts };
  const nextGood = { ...lastGood };
  for (const [host, data] of Object.entries(accounts)) {
    if (quotaValue(data)) nextGood[host] = data;
  }
  return { quotas, lastGood: nextGood };
}