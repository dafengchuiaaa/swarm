import { describe, expect, it } from 'vitest';
import { mergeQuotas, quotaValue, resolveQuotaTile, type AccountQuota } from '../../../packages/swarm-shell/src/renderer/quotaView';

const codexReady: AccountQuota = {
  status: 'ready',
  updated: 1_700_000_000,
  windows: [
    { label: '5 小时', remaining_percent: 5, resets_at: 1_700_003_600 },
    { label: '每周', remaining_percent: 62 },
  ],
};
const codexError: AccountQuota = { status: 'error', note: '读取失败，请检查原客户端登录或网络' };
const qoderCredits: AccountQuota = { status: 'ready', currency: 'credits', amount: 1234.5, updated: 1_700_000_100 };

describe('额度行容错', () => {
  it('正常 ready 数据取最小窗口百分比，credits 显示积分', () => {
    expect(quotaValue(codexReady)).toMatchObject({ value: '5%', percent: 5 });
    expect(quotaValue(qoderCredits)?.value).toContain('积分');
    expect(quotaValue(codexError)).toBeNull();
    expect(quotaValue(undefined)).toBeNull();
  });

  it('单宿主临时失败：保留上次成功数值并标 stale，不整行消失', () => {
    const tile = resolveQuotaTile(codexError, codexReady, false);
    expect(tile.value).toBe('5%');
    expect(tile.stale).toBe(true);
    expect(tile.pending).toBe(false);
    expect(tile.data.updated).toBe(codexReady.updated);
  });

  it('部分回包缺行（子进程超时）同样保留旧值', () => {
    const tile = resolveQuotaTile(undefined, codexReady, true);
    expect(tile.value).toBe('5%');
    expect(tile.stale).toBe(true);
  });

  it('已连接但从未成功：读取中 / 读取失败占位，而不是隐藏', () => {
    expect(resolveQuotaTile(undefined, undefined, true)).toMatchObject({ value: '读取中', pending: true });
    expect(resolveQuotaTile(codexError, undefined, false)).toMatchObject({ value: '读取失败', pending: true });
  });

  it('恢复后回到新值，stale 清除', () => {
    const recovered: AccountQuota = { ...codexReady, windows: [{ label: '5 小时', remaining_percent: 80 }], updated: 1_700_009_999 };
    const tile = resolveQuotaTile(recovered, codexReady, false);
    expect(tile.value).toBe('80%');
    expect(tile.stale).toBe(false);
  });

  it('合并按宿主覆盖：error 行不清掉其他宿主，lastGood 只记可显示的 ready 值', () => {
    const first = mergeQuotas({}, { 'GPT / Codex': codexReady, Qoder: qoderCredits }, {});
    expect(first.lastGood['GPT / Codex']).toEqual(codexReady);
    const second = mergeQuotas(first.quotas, { 'GPT / Codex': codexError }, first.lastGood);
    expect(second.quotas.Qoder).toEqual(qoderCredits);
    expect(second.quotas['GPT / Codex']).toEqual(codexError);
    expect(second.lastGood['GPT / Codex']).toEqual(codexReady);
    // 缺行宿主保留旧数据
    const third = mergeQuotas(second.quotas, { Qoder: qoderCredits }, second.lastGood);
    expect(third.quotas['GPT / Codex']).toEqual(codexError);
  });
});