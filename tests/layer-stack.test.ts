import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTopLayer, popLayer, pushLayer } from '../src/ui/layer';

/** Lightweight DOM model for exercising the real shared keyboard handler. */
class FakeElement {
  inert = false;
  isConnected = true;
  visible = true;
  disabled = false;
  isContentEditable = false;
  style = { zIndex: '' };
  tabIndex = -1;
  private parent: FakeElement | null = null;
  private children: FakeElement[] = [];
  private explicitTabIndex = false;

  constructor(readonly id: string, readonly roleDialog = false) {}

  append(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  makeTabbable() {
    this.tabIndex = 0;
    this.explicitTabIndex = true;
    return this;
  }

  makeDialog() {
    this.tabIndex = -1;
    this.explicitTabIndex = true;
    return this;
  }

  hasAttribute(name: string) {
    return name === 'tabindex' && this.explicitTabIndex;
  }

  getAttribute(name: string) {
    return this.hasAttribute(name) ? String(this.tabIndex) : null;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  matches(selector: string) {
    return selector === ':disabled' && this.disabled;
  }

  closest(selector: string): FakeElement | null {
    if (selector !== '[inert]') return null;
    for (let cur: FakeElement | null = this; cur; cur = cur.parent) {
      if (cur.inert) return cur;
    }
    return null;
  }

  contains(target: FakeElement) {
    for (let cur: FakeElement | null = target; cur; cur = cur.parent) {
      if (cur === this) return true;
    }
    return false;
  }

  querySelectorAll(): FakeElement[] {
    return this.children.flatMap((child): FakeElement[] => [child, ...child.querySelectorAll()]);
  }

  querySelector(selector: string): FakeElement | null {
    return selector === '[role="dialog"]'
      ? this.querySelectorAll().find((child) => child.roleDialog) ?? null
      : null;
  }

  focus() {
    (document as unknown as { activeElement: FakeElement }).activeElement = this;
  }
}

const openLayers: FakeElement[] = [];
afterEach(() => {
  for (const el of openLayers.reverse()) popLayer(el as unknown as HTMLElement);
  openLayers.length = 0;
  vi.unstubAllGlobals();
});

function setup() {
  const page = new FakeElement('page');
  const menu = new FakeElement('menu');
  const modal = new FakeElement('modal');
  const settle = new FakeElement('settle');
  const ceremony = new FakeElement('ceremony');
  const undo = new FakeElement('undo').makeTabbable();
  const elements = new Map([
    ['.wrap', page],
    ['#menu', menu],
    ['#mdl', modal],
    ['#settle', settle],
    ['#ceremony', ceremony],
    ['#toast .toast-act', undo],
  ]);
  const keydownListeners = new Set<(event: KeyboardEvent) => void>();
  let locked = false;
  const mockDocument = {
    activeElement: page,
    querySelectorAll: () => [],
    querySelector: (selector: string) => elements.get(selector) ?? null,
    documentElement: { classList: { toggle: (_name: string, value: boolean) => { locked = value; } } },
    addEventListener: (type: string, fn: (event: KeyboardEvent) => void, capture: boolean) => {
      if (type === 'keydown' && capture) keydownListeners.add(fn);
    },
    removeEventListener: (type: string, fn: (event: KeyboardEvent) => void, capture: boolean) => {
      if (type === 'keydown' && capture) keydownListeners.delete(fn);
    },
  };
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', mockDocument);
  vi.stubGlobal('getComputedStyle', (el: FakeElement) => ({ visibility: el.visible ? 'visible' : 'hidden' }));

  const push = (el: FakeElement) => {
    pushLayer(el as unknown as HTMLElement);
    openLayers.push(el);
  };
  const tab = (shiftKey = false) => {
    const preventDefault = vi.fn();
    const event = {
      key: 'Tab', shiftKey, ctrlKey: false, altKey: false, metaKey: false, preventDefault,
    } as unknown as KeyboardEvent;
    for (const fn of keydownListeners) fn(event);
    return { preventDefault };
  };
  return {
    page, modal, settle, ceremony, undo, push, tab,
    get active() { return mockDocument.activeElement; },
    get locked() { return locked; },
    get keyboardListenerCount() { return keydownListeners.size; },
  };
}

describe('shared dialog layer stack', () => {
  it('keeps dialog paint order below toast and flying bricks, while isolating Undo', () => {
    const d = setup();
    d.push(d.settle);
    expect(d.settle.style.zIndex).toBe('50');
    expect(isTopLayer(d.settle as unknown as HTMLElement)).toBe(true);
    expect(d.locked).toBe(true);
    expect(d.page.inert).toBe(true);
    expect(d.undo.inert).toBe(true);

    d.settle.focus();
    d.push(d.modal);
    expect(d.modal.style.zIndex).toBe('60');
    expect(d.settle.inert).toBe(true);

    d.modal.focus();
    d.push(d.ceremony);
    expect(d.ceremony.style.zIndex).toBe('70');
    expect(Number(d.ceremony.style.zIndex)).toBeLessThan(80); // toast = 80; brick = 90
    expect(Number(d.ceremony.style.zIndex)).toBeGreaterThan(Number(d.modal.style.zIndex));
    expect(d.modal.inert).toBe(true);

    popLayer(d.ceremony as unknown as HTMLElement);
    expect(d.active).toBe(d.modal);
    expect(d.ceremony.style.zIndex).toBe('');
    expect(d.modal.inert).toBe(false);
    popLayer(d.modal as unknown as HTMLElement);
    expect(d.active).toBe(d.settle);
    popLayer(d.settle as unknown as HTMLElement);
    expect(d.active).toBe(d.page);
    expect(d.locked).toBe(false);
    expect(d.page.inert).toBe(false);
    expect(d.undo.inert).toBe(false);
    expect(d.keyboardListenerCount).toBe(0);
  });

  it('traps Tab and Shift+Tab in the current top layer, including empty dialogs', () => {
    const d = setup();
    const box = d.modal.append(new FakeElement('modal-content', true).makeDialog());
    const first = box.append(new FakeElement('first').makeTabbable());
    const disabled = box.append(new FakeElement('disabled').makeTabbable());
    disabled.disabled = true;
    const hidden = box.append(new FakeElement('hidden').makeTabbable());
    hidden.visible = false;
    const last = box.append(new FakeElement('last').makeTabbable());

    d.push(d.modal);
    expect(d.keyboardListenerCount).toBe(1);

    last.focus();
    expect(d.tab().preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(first);

    first.focus();
    expect(d.tab(true).preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(last);

    box.focus(); // tabindex=-1: the initial dialog container is not a Tab stop
    expect(d.tab().preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(first);

    d.page.focus(); // defensive recovery if external code moved focus away
    expect(d.tab(true).preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(last);

    first.disabled = true;
    last.disabled = true;
    d.page.focus();
    expect(d.tab().preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(box); // no enabled controls => focus dialog fallback

    first.disabled = false;
    last.disabled = false;
    const upper = d.settle.append(new FakeElement('settle-content', true).makeDialog());
    const upperButton = upper.append(new FakeElement('upper-button').makeTabbable());
    d.push(d.settle);
    first.focus(); // the lower layer must not intercept Tab
    expect(d.tab().preventDefault).toHaveBeenCalledOnce();
    expect(d.active).toBe(upperButton);
    expect(d.keyboardListenerCount).toBe(1);

    popLayer(d.settle as unknown as HTMLElement);
    expect(d.keyboardListenerCount).toBe(1);
    popLayer(d.modal as unknown as HTMLElement);
    expect(d.keyboardListenerCount).toBe(0);
    const event = d.tab();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
