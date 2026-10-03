import { $, esc } from './dom';

export interface ModalOpts {
  kick?: string;
  title: string;
  body: string;
  /** 打开后绑定事件；返回值无意义 */
  mount?: (box: HTMLElement) => void;
  /** 关闭（包括点背景、按 Esc）时调用 */
  onClose?: () => void;
  dismissable?: boolean;
}

let current: ModalOpts | null = null;
let lastFocus: Element | null = null;

export function isModalOpen() {
  return !$('mdl').hidden;
}

export function openModal(o: ModalOpts) {
  if (current) closeModal(false);
  current = o;
  lastFocus = document.activeElement;
  const box = $('mdlBox');
  box.innerHTML = `${o.dismissable === false ? '' : '<button class="x" data-close aria-label="关闭">×</button>'}${o.kick ? `<div class="kick">${esc(o.kick)}</div>` : ''}<h2 id="mdlT">${esc(o.title)}</h2>${o.body}`;
  $('mdl').hidden = false;
  o.mount?.(box);
  const f = box.querySelector<HTMLElement>('[autofocus]') ?? box;
  f.focus();
}

export function closeModal(callOnClose = true) {
  const o = current;
  current = null;
  $('mdl').hidden = true;
  $('mdlBox').innerHTML = '';
  if (callOnClose) o?.onClose?.();
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

export function initModal() {
  $('mdl').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]') || (t.id === 'mdl' && current?.dismissable !== false)) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isModalOpen() && current?.dismissable !== false) closeModal();
  });
}

/** 简单的确认框 */
export function confirmModal(o: { kick?: string; title: string; text: string; ok: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      kick: o.kick,
      title: o.title,
      body: `<p>${esc(o.text)}</p><div class="actions"><button class="btn" data-close>算了</button><button class="btn ${o.danger ? 'danger' : 'primary'}" data-ok autofocus>${esc(o.ok)}</button></div>`,
      mount(box) {
        box.querySelector('[data-ok]')!.addEventListener('click', () => {
          done = true;
          closeModal(false);
          resolve(true);
        });
      },
      onClose: () => {
        if (!done) resolve(false);
      },
    });
  });
}
