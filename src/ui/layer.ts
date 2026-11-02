/**
 * 遮罩层（对话框、晚间结算、落成仪式）的公共行为：
 * - 打开时背后的页面和下层遮罩设为 inert：Tab 不会跑到背后，读屏也只读当前这一层；
 * - 锁住页面滚动；
 * - 关闭时把焦点还给打开它的那个控件；
 * - Esc 只关最上面的一层，Tab / Shift+Tab 只在当前顶层循环。
 *
 * 每一层自己管内容；这里只管层与层、层与页面之间的关系。
 */

interface Layer {
  el: HTMLElement;
  restore: Element | null;
}

const stack: Layer[] = [];

/** 遮罩打开时需要变成 inert 的背景：页面主体、⋯ 菜单，以及所有遮罩层的根 */
const BACKGROUND_SELECTORS = ['.wrap', '#menu', '#mdl', '#settle', '#ceremony'];
const OVERLAYS = ['#mdl', '#settle', '#ceremony'];
// Three registered overlays occupy 50/60/70, below toast (80) and flying bricks (90).
const LAYER_Z_BASE = 50;
const LAYER_Z_STEP = 10;

/** Candidates in keyboard tab order; hidden, disabled and inert nodes are filtered below. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
let focusTrapAttached = false;

function trapTab(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const top = stack[stack.length - 1]?.el;
  if (!top) return;

  const tabbables = [...top.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    // getClientRects filters display:none and detached nodes; computed visibility
    // also excludes visibility:hidden elements (which still have a rect).
    (el.tabIndex >= 0 || (el.isContentEditable && el.getAttribute('tabindex') !== '-1'))
    && !el.matches(':disabled')
    && !el.inert && !el.closest('[inert]')
    && el.getClientRects().length > 0
    && getComputedStyle(el).visibility === 'visible',
  );
  const active = document.activeElement;
  if (!tabbables.length) {
    // Our three dialog contents are focusable via tabindex=-1 even when no
    // enabled controls exist. Keep keyboard focus inside rather than in chrome.
    e.preventDefault();
    const fallback = top.querySelector<HTMLElement>('[role="dialog"]') ?? top;
    if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
    fallback.focus({ preventScroll: true });
    return;
  }

  const index = tabbables.indexOf(active as HTMLElement);
  if (index < 0 || (e.shiftKey && index === 0) || (!e.shiftKey && index === tabbables.length - 1)) {
    e.preventDefault();
    (e.shiftKey ? tabbables[tabbables.length - 1] : tabbables[0]).focus({ preventScroll: true });
  }
}

function syncFocusTrap(hasTop: boolean) {
  // One capture listener handles Tab for whichever layer is currently top.
  // Removing it on last pop lets normal document tab navigation resume.
  if (hasTop && !focusTrapAttached) {
    document.addEventListener('keydown', trapTab, true);
    focusTrapAttached = true;
  } else if (!hasTop && focusTrapAttached) {
    document.removeEventListener('keydown', trapTab, true);
    focusTrapAttached = false;
  }
}

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof document.querySelectorAll === 'function';
}

function sync() {
  if (!hasDom()) return;
  const top = stack[stack.length - 1]?.el ?? null;
  for (const selector of BACKGROUND_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.inert = Boolean(top) && el !== top;
  }
  // Keep the visible paint order consistent with the interactive stack.
  // Fixed CSS z-indices alone put ceremonies over later opened dialogs.
  for (const selector of OVERLAYS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const index = stack.findIndex((layer) => layer.el === el);
    el.style.zIndex = index < 0 ? '' : String(LAYER_Z_BASE + index * LAYER_Z_STEP);
  }
  // A toast remains a live announcement, but Undo cannot be clicked or
  // focused behind a modal. Restore it if the toast outlives the modal.
  const action = document.querySelector<HTMLButtonElement>('#toast .toast-act');
  if (action) action.inert = Boolean(top);
  document.documentElement.classList.toggle('layer-open', Boolean(top));
  syncFocusTrap(Boolean(top));
}

export function pushLayer(el: HTMLElement) {
  if (stack.some((layer) => layer.el === el)) return;
  stack.push({ el, restore: typeof document !== 'undefined' ? document.activeElement : null });
  sync();
}

export function popLayer(el: HTMLElement) {
  const index = stack.findIndex((layer) => layer.el === el);
  if (index < 0) return;
  const [layer] = stack.splice(index, 1);
  const wasTop = index === stack.length;
  sync();
  if (!wasTop) return;
  const restore = layer.restore;
  if (typeof HTMLElement !== 'undefined' && restore instanceof HTMLElement && restore.isConnected !== false) {
    restore.focus({ preventScroll: true });
  }
}

/** 这一层是不是最上面那层：Esc 和点背景只对最上层生效 */
export function isTopLayer(el: HTMLElement): boolean {
  return stack[stack.length - 1]?.el === el;
}
