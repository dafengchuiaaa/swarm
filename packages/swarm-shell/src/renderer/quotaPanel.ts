import type { HostCatalog } from '../shared/types';
import { mergeQuotas, resolveQuotaTile, type AccountQuota } from './quotaView';

const QUOTA_HOSTS = [
  ['CodeBuddy', 'CB / WB', 'CodeBuddy / WorkBuddy'],
  ['GPT / Codex', 'Codex', 'Codex'],
  ['Antigravity', 'AG', 'Antigravity'],
  ['Qoder', 'Qoder', 'Qoder'],
  ['DeepSeek Harness', 'DSH', 'DeepSeek Harness'],
  ['ZCode', 'ZCode', 'ZCode'],
] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createQuotaPanel(
  rail: HTMLElement,
  list: HTMLElement,
  status: HTMLElement,
  refreshButton: HTMLButtonElement,
  getCatalog: () => HostCatalog | null,
  readQuotas: () => Promise<Record<string, AccountQuota>>,
) {
  let quotas: Record<string, AccountQuota> = {};
  let lastGoodQuotas: Record<string, AccountQuota> = {};
  let quotaError = false;
  let quotaBusy = false;

  function render(): void {
    const catalog = getCatalog();
    rail.hidden = !catalog?.quotaAvailable;
    if (rail.hidden) return;
    list.replaceChildren();
    for (const [host, short, name] of QUOTA_HOSTS) {
      if (!catalog?.hosts.some(item => item.name === host && item.ready)) continue;
      // 临时失败保留上次成功数值；从未成功过则显示读取状态，不再整行消失。
      const tileData = resolveQuotaTile(quotas[host], lastGoodQuotas[host], quotaBusy);
      const { data, value, percent, windows, stale, pending } = tileData;
      const meter = el('span', 'quota-meter');
      if (percent === null) meter.classList.add('balance');
      else {
        meter.classList.toggle('low', percent <= 20);
        meter.style.setProperty('--fill', `${Math.min(100, Math.max(0, percent))}%`);
      }
      const tile = el('div', 'quota-tile');
      if (stale) tile.classList.add('stale');
      if (pending) tile.classList.add('pending');
      tile.tabIndex = 0;
      tile.append(meter, el('span', '', short), el('strong', '', value));
      tile.title = [name,
        stale ? '本次读取失败，显示上次成功数值' : '',
        pending ? (data.note || '尚未读到额度数值') : '',
        data?.plan, ...windows.map(item => `${item.label} ${Math.round(item.remaining_percent!)}%${item.resets_at ? ` · ${new Date(item.resets_at * 1000).toLocaleString()} 重置` : ''}`),
        ...(data.balances ?? []), stale ? '' : data.note,
        data?.updated ? `更新于 ${new Date(data.updated * 1000).toLocaleString()}` : '', data?.source].filter(Boolean).join('\n');
      tile.setAttribute('aria-label', tile.title);
      list.append(tile);
    }
    status.hidden = !quotaError;
    status.textContent = '额度暂时无法更新';
  }

  async function refresh(): Promise<void> {
    if (quotaBusy || !getCatalog()?.quotaAvailable) return;
    quotaBusy = true;
    refreshButton.disabled = true;
    render();
    try {
      const accounts = await readQuotas();
      const merged = mergeQuotas(quotas, accounts, lastGoodQuotas);
      quotas = merged.quotas;
      lastGoodQuotas = merged.lastGood;
      quotaError = false;
    } catch {
      quotaError = true;
    } finally {
      quotaBusy = false;
      refreshButton.disabled = false;
      render();
    }
  }

  function start(): void {
    render();
    refreshButton.addEventListener('click', () => void refresh());
    void refresh();
    window.setInterval(() => void refresh(), 5 * 60_000);
  }

  return { start, render, refresh };
}
