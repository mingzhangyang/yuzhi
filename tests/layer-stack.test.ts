import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTopLayer, popLayer, pushLayer } from '../src/ui/layer';

/** Minimal DOM double for the layer stack: no browser or jsdom required. */
class FakeElement {
  inert = false;
  isConnected = true;
  style = { zIndex: '' };
  constructor(readonly id: string) {}
  focus() {
    (document as unknown as { activeElement: FakeElement }).activeElement = this;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('shared dialog layer stack', () => {
  it('keeps paint order, focus and background Undo isolation in sync', () => {
    const elements = new Map([
      ['.wrap', new FakeElement('page')],
      ['#menu', new FakeElement('menu')],
      ['#mdl', new FakeElement('modal')],
      ['#settle', new FakeElement('settle')],
      ['#ceremony', new FakeElement('ceremony')],
      ['#toast .toast-act', new FakeElement('undo')],
    ]);
    let locked = false;
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: (selector: string) => elements.get(selector) ?? null,
      activeElement: elements.get('.wrap'),
      documentElement: { classList: { toggle: (_: string, on: boolean) => { locked = on; } } },
    });
    const page = elements.get('.wrap')!;
    const settle = elements.get('#settle')!;
    const modal = elements.get('#mdl')!;
    const undo = elements.get('#toast .toast-act')!;

    pushLayer(settle as unknown as HTMLElement);
    expect(isTopLayer(settle as unknown as HTMLElement)).toBe(true);
    expect(locked).toBe(true);
    expect(page.inert).toBe(true);
    expect(undo.inert).toBe(true);

    (document as unknown as { activeElement: FakeElement }).activeElement = settle;
    pushLayer(modal as unknown as HTMLElement);
    expect(isTopLayer(modal as unknown as HTMLElement)).toBe(true);
    expect(settle.inert).toBe(true);
    expect(modal.inert).toBe(false);
    expect(Number(modal.style.zIndex)).toBeGreaterThan(Number(settle.style.zIndex));

    popLayer(modal as unknown as HTMLElement);
    expect(isTopLayer(settle as unknown as HTMLElement)).toBe(true);
    expect(settle.inert).toBe(false);
    expect((document as unknown as { activeElement: FakeElement }).activeElement).toBe(settle);
    popLayer(settle as unknown as HTMLElement);
    expect(locked).toBe(false);
    expect(page.inert).toBe(false);
    expect(undo.inert).toBe(false);
    expect((document as unknown as { activeElement: FakeElement }).activeElement).toBe(page);
  });
});
