// 视觉增强层：只绑纯前端交互（建议芯片、自定义窗口控件），不碰业务逻辑。
// 所有入口都做了存在性保护，preload 未提供窗口 API 时静默降级。

type WinApi = {
  winMinimize?: () => void;
  winMaximize?: () => void;
  winClose?: () => void;
  winIsMaximized?: () => Promise<boolean>;
  onWinState?: (listener: (maximized: boolean) => void) => () => void;
};

const api = (window as unknown as { swarm?: WinApi }).swarm;
const app = document.querySelector('.app');

// 首页建议芯片：点一下把任务写进输入框并聚焦，光标落在末尾。
document.querySelectorAll<HTMLButtonElement>('.chip-suggest').forEach(chip => {
  chip.addEventListener('click', () => {
    const prompt = document.querySelector<HTMLTextAreaElement>('#home-prompt');
    if (!prompt) return;
    prompt.value = chip.dataset.prompt ?? '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });
});

// 自定义标题栏窗口控件（无边框窗口配套）。
const bind = (id: string, fn?: () => void) => {
  const node = document.querySelector<HTMLButtonElement>(id);
  if (node && fn) node.addEventListener('click', fn);
};
bind('#win-min', api?.winMinimize);
bind('#win-max', api?.winMaximize);
bind('#win-close', api?.winClose);

const setMaximized = (maximized: boolean) => app?.classList.toggle('maximized', maximized);
if (api?.onWinState) api.onWinState(setMaximized);
void api?.winIsMaximized?.().then(setMaximized).catch(() => undefined);