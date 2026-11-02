import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as A from '../src/actions';
import { SettleSheet } from '../src/ui/settle';
import { makeStore } from './helpers';

// Minimal DOM port: the sheet's state machine, not browser layout.
class ElementStub extends EventTarget {
  hidden = true;
  innerHTML = '';
  textContent = '';
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
let box: ElementStub;
beforeEach(() => {
  const els = new Map<string, ElementStub>();
  box = new ElementStub();
  els.set('settleBox', box);
  vi.stubGlobal('window', { setTimeout: () => 0 });
  vi.stubGlobal('document', {
    addEventListener() {},
    body: { style: {} },
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, new ElementStub());
      return els.get(id);
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A click whose target answers closest() for one selector. */
function click(selector: string, target: object) {
  const e = new Event('click');
  Object.defineProperty(e, 'target', { value: { closest: (s: string) => (s === selector ? target : null) } });
  box.dispatchEvent(e);
}

describe('settlement sheet ownership', () => {
  it('drafts made under a lost writer lease are not committed after takeover', () => {
    const { store, today } = makeStore();
    const p = A.createProject(store, '团队');
    const t = A.createTask(store, { title: '写周报', projectId: p.id, scheduledFor: today });
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open(today);
    const item = { dataset: { key: `task|${t.id}`, project: '' } };
    click('[data-set]', { dataset: { set: 'done' }, closest: () => item });

    // writer -> reader -> writer
    store.setReadOnly(true);
    sheet.discard();
    store.setReadOnly(false);

    sheet.open(today);
    click('[data-act]', { dataset: { act: 'commit' } });
    expect(store.data.entries.some((e) => e.outcome === 'done')).toBe(false);
  });

  it('an ordinary close keeps the draft', () => {
    const { store, today } = makeStore();
    const p = A.createProject(store, '团队');
    const t = A.createTask(store, { title: '写周报', projectId: p.id, scheduledFor: today });
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open(today);
    const item = { dataset: { key: `task|${t.id}`, project: '' } };
    click('[data-set]', { dataset: { set: 'done' }, closest: () => item });
    sheet.close();

    sheet.open(today);
    click('[data-act]', { dataset: { act: 'commit' } });
    expect(store.data.entries.some((e) => e.outcome === 'done')).toBe(true);
  });
});

describe('YZ-F5 结算时「还做了别的事」', () => {
  it('明天的任务单独分组并标出原定日期，到期和未定日期的放在前面', () => {
    const { store, today } = makeStore('2026-11-01', '2026-11-01');
    const p = A.createProject(store, '屿志推广');
    A.createTask(store, { title: '回复帖子', projectId: p.id, scheduledFor: '2026-11-02' });
    A.createTask(store, { title: '整理素材', projectId: p.id });
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open(today);
    const html = box.innerHTML;
    const due = html.indexOf('<optgroup label="到期未做、未定日期的">');
    const ahead = html.indexOf('<optgroup label="提前做了的（原定在之后）">');
    expect(due).toBeGreaterThan(-1);
    expect(ahead).toBeGreaterThan(due);
    expect(html.slice(due, ahead)).toContain('整理素材 · 屿志推广 · 未定日期');
    expect(html.slice(ahead)).toContain('回复帖子 · 屿志推广 · 原定明天');
  });
});
