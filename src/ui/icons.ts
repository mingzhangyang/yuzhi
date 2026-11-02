/**
 * 界面里的小图标：内联 SVG，跟随文字颜色（currentColor）。
 * 用来替代 📅 这类 emoji 和 ✓ ✕ ⤢ 字符——它们在不同系统上的样子、粗细和基线都不一样。
 * 一律 aria-hidden：按钮自己的 aria-label 负责说明用途。
 */
const svg = (body: string) =>
  `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  check: svg('<path d="M3.5 8.6 6.6 11.6 12.6 4.6"/>'),
  cross: svg('<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>'),
  calendar: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3"/>'),
} as const;
