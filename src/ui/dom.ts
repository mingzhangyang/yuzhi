export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** 用户写的文字放进 HTML 前一律转义 */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

let toastT = 0;
export function toast(msg: string, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove('show'), 2600);
}

/** 只在内容变化时才写 innerHTML，避免打断输入和滚动 */
const cache = new WeakMap<HTMLElement, string>();
export function setHTML(el: HTMLElement, html: string) {
  if (cache.get(el) === html) return;
  cache.set(el, html);
  el.innerHTML = html;
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
