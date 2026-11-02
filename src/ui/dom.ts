export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 用户写的文字放进 HTML 前一律转义 */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

let toastT = 0;
let toastClearT = 0;

export interface ToastAction {
  label: string;
  run(): void;
}

/**
 * 页面顶部的一句提示。带 action 时多一个按钮（例如「撤销」），停留更久，
 * 消失后按钮随之移除，不会留在 Tab 顺序里。
 */
export function toast(msg: string, bad = false, action?: ToastAction) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.toggle('has-action', Boolean(action));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-act';
    button.textContent = action.label;
    // A live-region announcement may appear behind a dialog, but its Undo
    // action must never be usable outside the active layer.
    button.inert = document.documentElement.classList.contains('layer-open');
    button.addEventListener('click', () => {
      el.classList.remove('show', 'has-action');
      button.remove();
      action.run();
    }, { once: true });
    el.append(button);
  }
  el.classList.add('show');
  clearTimeout(toastT);
  clearTimeout(toastClearT);
  toastT = window.setTimeout(() => {
    el.classList.remove('show');
    toastClearT = window.setTimeout(() => {
      el.classList.remove('has-action');
      el.querySelector('.toast-act')?.remove();
    }, 250);
  }, action ? 6000 : 2600);
}

/** 只在内容变化时才写 innerHTML，避免打断输入和滚动 */
const cache = new WeakMap<HTMLElement, string>();
export function setHTML(el: HTMLElement, html: string) {
  if (cache.get(el) === html) return;
  cache.set(el, html);
  el.innerHTML = html;
}
/** 忘掉 setHTML 记下的内容：下次即使字符串相同也会重写（用于把被用户改动过的控件复位） */
export function forgetHTML(el: HTMLElement) {
  cache.delete(el);
}
export function setText(el: HTMLElement, t: string) {
  if (el.textContent !== t) el.textContent = t;
}

export function download(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function pickFile(input: HTMLInputElement): Promise<File | null> {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
