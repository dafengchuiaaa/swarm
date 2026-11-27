interface PickerContext {
  model: HTMLSelectElement;
  effort: HTMLSelectElement;
  host: () => string;
  edge?: 'above' | 'below';
  composer?: HTMLElement;
}

interface PickerDetails {
  rate: string;
  capacity: [string, string][];
  efforts: [string, string][];
  initialEffort: string;
}

type Binding = PickerContext & { button: HTMLButtonElement };

const icons = import.meta.glob('./brand-icons/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const vendors = [
  ['hunyuan', '腾讯混元', /^(hy\d|hunyuan|混元)/i],
  ['deepseek', 'DeepSeek', /^deepseek/i],
  ['zhipu', '智谱 GLM', /^(glm|zhipu)/i],
  ['qwen', '通义千问', /^(qwen|通义)/i],
  ['kimi', '月之暗面', /^(kimi|moonshot)/i],
  ['minimax', 'MiniMax', /^minimax/i],
  ['stepfun', '阶跃星辰', /^step[\s-]*\d|^stepfun/i],
  ['mimo', '小米 MiMo', /^(xiaomi|mimo)/i],
  ['openai', 'OpenAI', /^(gpt|codex|o[134](?:\b|-))/i],
  ['claude', 'Anthropic', /^claude/i],
  ['gemini', 'Google Gemini', /^gemini/i],
  ['qoder', 'Qoder', /^(auto|ultimate|fast|efficient|sonus|cantus)$/i],
] as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = css;
  if (text) node.textContent = text;
  return node;
}

export function createModelPicker(detailsFor: (host: string, model: string) => PickerDetails) {
  const popup = document.querySelector<HTMLElement>('#model-picker')!;
  const list = popup.querySelector<HTMLElement>('#model-picker-list')!;
  const info = popup.querySelector<HTMLElement>('#model-picker-info')!;
  const bindings = new Map<string, Binding>();
  let active: Binding | null = null;
  let previewRow: HTMLButtonElement | null = null;

  function choose(select: HTMLSelectElement, value: string): void {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function position(): void {
    if (!active || !popup.matches(':popover-open')) return;
    const anchor = active.button.getBoundingClientRect();
    if (!anchor.width) {
      popup.hidePopover();
      return;
    }
    const inset = 12;
    const gap = 8;
    const composer = active.composer?.getBoundingClientRect() ?? anchor;
    const above = composer.top - inset - gap;
    const below = innerHeight - composer.bottom - inset - gap;
    const available = active.edge === 'above' ? above : below;
    const upward = active.edge && available >= Math.min(110, popup.offsetHeight)
      ? active.edge === 'above' : above > below;
    active.button.dataset.opens = upward ? 'above' : 'below';
    popup.style.setProperty('--picker-space', `${Math.max(0, upward ? above : below)}px`);
    const left = Math.min(anchor.left, innerWidth - popup.offsetWidth - inset);
    popup.style.left = `${Math.max(inset, left)}px`;
    popup.style.top = `${upward ? Math.max(inset, composer.top - gap - popup.offsetHeight) : composer.bottom + gap}px`;
    positionDetails();
  }

  function positionDetails(): void {
    if (!previewRow?.isConnected || !info.matches(':popover-open')) return;
    const menu = popup.getBoundingClientRect();
    const row = previewRow.getBoundingClientRect();
    const inset = 12;
    const gap = 6;
    const right = innerWidth - menu.right - inset - gap;
    const left = menu.left - inset - gap;
    const width = info.offsetWidth;
    let x = right >= width || right >= left ? menu.right + gap : menu.left - width - gap;
    x = Math.max(inset, Math.min(innerWidth - width - inset, x));
    const above = active?.button.dataset.opens === 'above';
    const top = active?.composer && !above ? menu.top : inset;
    const bottom = active?.composer && above ? menu.bottom : innerHeight - inset;
    info.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const y = Math.max(top, Math.min(Math.max(menu.top, row.top), bottom - info.offsetHeight));
    info.style.left = `${x}px`;
    info.style.top = `${y}px`;
  }

  function hideDetails(): void {
    if (info.matches(':popover-open')) info.hidePopover();
    previewRow = null;
  }

  function showDetails(option: HTMLOptionElement, row: HTMLButtonElement): void {
    const binding = active;
    if (!binding) return;
    const selected = binding.model.value === option.value;
    const details = detailsFor(binding.host(), option.value);
    if (!details.capacity.length && !details.efforts.length) {
      hideDetails();
      return;
    }
    previewRow = row;
    const title = element('h3', 'model-picker-name', option.label);
    const capacity = element('dl', 'model-picker-capacity');
    for (const [label, value] of details.capacity) {
      capacity.append(element('dt', '', label), element('dd', '', value));
    }
    const heading = element('h4', '', '思考档位');
    const efforts = element('div', 'model-picker-efforts');
    for (const [value, label] of details.efforts) {
      const button = element('button', 'model-effort-choice', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String((selected ? binding.effort.value : details.initialEffort) === value));
      button.onclick = () => {
        choose(binding.model, option.value);
        choose(binding.effort, value);
        refresh(binding.button.id);
        popup.hidePopover();
        binding.button.focus();
      };
      efforts.append(button);
    }
    info.replaceChildren(title);
    if (details.capacity.length) info.append(capacity);
    if (details.efforts.length) info.append(heading, efforts);
    if (!info.matches(':popover-open')) info.showPopover({ source: row });
    positionDetails();
  }

  function renderOptions(): void {
    if (!active) return;
    const options = [...active.model.options];
    const selected = options.find(option => option.value === active?.model.value);
    const binding = active;
    list.replaceChildren();
    const groups = new Map<string, HTMLElement>();
    let currentRow: HTMLButtonElement | null = null;
    const current = selected ?? options[0];
    for (const option of options) {
      const [vendor, groupLabel] = vendors.find(([, , pattern]) => pattern.test(option.label) || pattern.test(option.value))
        ?? ['other', '其他模型'];
      let group = groups.get(vendor);
      if (!group) {
        group = element('div', 'model-picker-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', groupLabel);
        group.append(element('div', 'model-picker-group-label', groupLabel));
        groups.set(vendor, group);
        list.append(group);
      }
      const button = element('button', 'model-picker-option');
      button.type = 'button';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option === selected));
      button.setAttribute('popovertarget', info.id);
      const marker = element('span', 'model-picker-mark', option === selected ? '✓' : '');
      marker.setAttribute('aria-hidden', 'true');
      const url = icons[`./brand-icons/${vendor}.png`];
      const mark = url ? element('img', 'model-brand-icon') : element('span', 'model-brand-icon model-brand-fallback', option.label.slice(0, 1));
      if (mark instanceof HTMLImageElement) {
        mark.src = url;
        mark.alt = '';
      } else mark.setAttribute('aria-hidden', 'true');
      const rate = element('span', 'model-picker-rate', detailsFor(binding.host(), option.value).rate);
      if (rate.textContent) rate.title = '积分倍率';
      button.title = option.label;
      button.append(mark, element('span', 'model-picker-label', option.label), rate, marker);
      button.onfocus = button.onpointerenter = () => showDetails(option, button);
      button.onclick = event => {
        event.preventDefault();
        choose(binding.model, option.value);
        list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
      };
      if (option === current) currentRow = button;
      group.append(button);
    }
    position();
    if (current && currentRow) {
      const viewport = list.getBoundingClientRect();
      const row = currentRow.getBoundingClientRect();
      if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
      else if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
      showDetails(current, currentRow);
    } else {
      hideDetails();
    }
  }

  function refresh(id: string): void {
    const binding = bindings.get(id);
    if (!binding) return;
    const model = binding.model.selectedOptions[0];
    const modelLabel = model?.label ?? '选择模型';
    const effort = binding.effort.selectedOptions[0]?.label;
    const meta = [binding.effort.disabled ? '' : effort, model && detailsFor(binding.host(), model.value).rate]
      .filter(Boolean).join(' · ');
    const caret = element('span', 'model-trigger-caret');
    caret.setAttribute('aria-hidden', 'true');
    binding.button.replaceChildren(element('span', 'model-trigger-name', modelLabel));
    if (meta) binding.button.append(element('small', 'model-trigger-meta', meta));
    binding.button.append(caret);
    binding.button.disabled = binding.model.disabled && binding.effort.disabled;
    if (active === binding && popup.matches(':popover-open')) renderOptions();
  }

  function bind(id: string, context: PickerContext): void {
    const button = document.getElementById(id) as HTMLButtonElement;
    const binding = { ...context, button };
    bindings.set(id, binding);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', popup.id);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('popovertarget', popup.id);
    button.onclick = event => {
      event.preventDefault();
      if (popup.matches(':popover-open')) {
        const same = active === binding;
        popup.hidePopover();
        if (same) return;
      }
      active = binding;
      button.setAttribute('aria-expanded', 'true');
      (button.closest('[aria-modal="true"]') ?? document.body).append(popup);
      popup.style.removeProperty('--picker-space');
      popup.showPopover({ source: button });
      renderOptions();
      list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    };
    refresh(id);
  }

  popup.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      const option = event.target instanceof HTMLButtonElement && list.contains(event.target) ? event.target : null;
      if (option) {
        event.preventDefault();
        option.click();
      }
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>('button')];
    if (!rows.length || !list.contains(event.target as Node)) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus();
  });
  popup.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState !== 'closed') return;
    hideDetails();
    active?.button.setAttribute('aria-expanded', 'false');
    active = null;
  });
  window.addEventListener('resize', position);
  list.addEventListener('scroll', positionDetails);
  return { bind, refresh };
}
