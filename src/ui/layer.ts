/**
 * 遮罩层（对话框、晚间结算、落成仪式）的公共行为：
 * - 打开时背后的页面和下层遮罩设为 inert：Tab 不会跑到背后，读屏也只读当前这一层；
 * - 锁住页面滚动；
 * - 关闭时把焦点还给打开它的那个控件；
 * - Esc 只关最上面的一层。
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
  document.documentElement.classList.toggle('layer-open', Boolean(top));
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
