import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeModal, confirmModal, openModal } from '../src/ui/modal';
import { emptyData, MemoryPersistence } from '../src/db';
import { Store } from '../src/store';
import { addFileSource } from '../src/calendar';

// Minimal DOM port: exercise the real modal lifetime, not browser layout.
class ElementStub extends EventTarget {
  hidden = true;
  button: ElementStub | undefined;
  set innerHTML(value: string) {
    this.button = value.includes('data-ok') ? new ElementStub() : undefined;
  }
  querySelector(selector: string) { return selector === '[data-ok]' ? this.button : null; }
  focus() {}
  click() { this.dispatchEvent(new Event('click')); }
}
let box: ElementStub;
beforeEach(() => {
  box = new ElementStub();
  const modal = new ElementStub();
  vi.stubGlobal('HTMLElement', ElementStub);
  vi.stubGlobal('document', {
    activeElement: null,
    getElementById: (id: string) => id === 'mdlBox' ? box : modal,
  });
});
afterEach(() => { closeModal(false); vi.unstubAllGlobals(); });

const question = { title: '确认', text: '替换？', ok: '确认' };
describe('modal-owned asynchronous intentions', () => {
  it('replacement cancels a pending confirmation and its detached button', async () => {
    const pending = confirmModal(question);
    const oldButton = box.button!;
    openModal({ title: '新窗口', body: '' });
    await expect(pending).resolves.toBe(false);
    oldButton.click();
    let signal!: AbortSignal;
    openModal({ title: '新操作', body: '', mount: (_box, s) => { signal = s; } });
    oldButton.click();
    expect(signal.aborted).toBe(false);
  });

  it('system cancellation settles confirmation without running dismissal mutations', async () => {
    const pending = confirmModal(question);
    closeModal(false);
    await expect(pending).resolves.toBe(false);
    const onClose = vi.fn();
    let signal!: AbortSignal;
    openModal({ title: '', body: '', onClose, mount: (_box, s) => { signal = s; } });
    closeModal(false);
    expect(signal.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('confirmed intentions cannot resume after writer-reader-writer before the microtask', async () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    const context = store.captureWriteContext();
    const pending = confirmModal(question);
    box.button!.click();
    store.setReadOnly(true);
    closeModal(false);
    store.setReadOnly(false);
    await expect(pending).resolves.toBe(true);
    expect(context.isCurrent()).toBe(false);
  });

  it('closing a modal discards its in-flight file read without revoking other work', async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(emptyData(), persistence);
    let signal!: AbortSignal;
    openModal({ title: '', body: '', mount: (_box, s) => { signal = s; } });
    let finish!: (text: string) => void;
    const file = { name: 'test.ics', text: () => new Promise<string>((resolve) => { finish = resolve; }) } as File;
    const pending = addFileSource(store, file, signal);
    closeModal(false);
    openModal({ title: '另一个操作', body: '' });
    finish('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR');
    await expect(pending).rejects.toThrow('已失效');
    expect(store.data.sources).toEqual([]);
    store.saveSettings({ theme: 'dark' });
    await store.flush();
    expect((await persistence.load()).settings.theme).toBe('dark');
  });

  it('a picker context is invalid as soon as its modal is replaced', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    let context!: ReturnType<Store['captureWriteContext']>;
    openModal({ title: '', body: '', mount: (_box, signal) => { context = store.captureWriteContext(signal); } });
    openModal({ title: '新窗口', body: '' });
    expect(context.isCurrent()).toBe(false);
    expect(() => context.assertCurrent()).toThrow('已失效');
  });
});
