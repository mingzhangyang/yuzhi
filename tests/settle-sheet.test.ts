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
  querySelector(_selector: string): unknown { return null; }
  querySelectorAll() { return []; }
}
let box: ElementStub;
beforeEach(() => {
  const els = new Map<string, ElementStub>();
  box = new ElementStub();
  els.set('settleBox', box);
  vi.stubGlobal('window', { setTimeout: () => 0 });
  // The Node test runner has no DOM globals. The fixture IDs are selector-safe;
  // production still uses the browser's native CSS.escape implementation.
  vi.stubGlobal('CSS', { escape: (value: string) => value });
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

/** Exercise delegated sheet events without depending on a browser layout. */
function sheetEvent(type: string, target: object, key?: string) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  if (key) Object.defineProperty(event, 'key', { value: key });
  box.dispatchEvent(event);
  return event;
}

describe('YZ-F9 sheet regression coverage', () => {
  it('uses historical task eligibility and ownership when recording pulled work', () => {
    const h = makeStore('2026-11-01', '2026-11-01');
    const villageA = A.createProject(h.store, 'Village A');
    const villageB = A.createProject(h.store, 'Village B');
    const closedVillage = A.createProject(h.store, 'Later closed');
    const moved = A.createTask(h.store, { title: 'Moved early', projectId: villageA.id, scheduledFor: '2026-11-12' });
    const completed = A.createTask(h.store, { title: 'Completed later', projectId: villageA.id, scheduledFor: '2026-11-13' });
    const dropped = A.createTask(h.store, { title: 'Dropped later', projectId: villageA.id, scheduledFor: '2026-11-14' });
    const closed = A.createTask(h.store, { title: 'Village closed later', projectId: closedVillage.id, scheduledFor: '2026-11-15' });
    h.setToday('2026-11-08');
    A.moveTask(h.store, moved.id, villageB.id);
    A.markTaskDone(h.store, completed.id);
    A.dropTask(h.store, dropped.id);
    A.closeProject(h.store, closedVillage.id, 'Archived village');
    const tooNew = A.createTask(h.store, { title: 'Created after history', projectId: villageB.id, scheduledFor: '2026-11-16' });
    h.setToday('2026-11-10');

    const sheet = new SettleSheet(h.store, { brick() {}, onOpenChange() {} });
    sheet.open('2026-11-05');
    const html = box.innerHTML;
    for (const task of [moved, completed, dropped, closed]) {
      expect(html).toContain('value="' + task.id + '"');
    }
    expect(html).not.toContain('value="' + tooNew.id + '"');
    expect(html).toContain('Moved early · Village A');
    expect(html).not.toContain('Moved early · Village B');

    // The UI path that previously called pullIntoDay: select + commit.
    sheetEvent('change', { value: moved.id, matches: (s: string) => s === '[data-pull]' });
    click('[data-act]', { dataset: { act: 'commit' } });
    const entry = h.store.data.entries.find((item) => item.itemId === moved.id && item.date === '2026-11-05');
    expect(entry?.projectId).toBe(villageA.id);
    expect(entry?.outcome).toBe('done');
    expect(h.store.task(moved.id)?.scheduledFor).toBe('2026-11-12');
    expect(h.store.data.operations.some((operation) => operation.kind === 'task-rescheduled')).toBe(false);
  });

  it('opens today after committing an archived historical day with no pending work', () => {
    const h = makeStore('2026-11-01', '2026-11-01');
    const village = A.createProject(h.store, 'Village');
    A.createTask(h.store, { title: 'Old work', projectId: village.id, scheduledFor: '2026-11-05' });
    h.setToday('2026-11-10');
    h.store.put('days', { date: '2026-11-05', status: 'unrecorded' });
    const sheet = new SettleSheet(h.store, { brick() {}, onOpenChange() {} });
    sheet.open('2026-11-05');
    click('[data-act]', { dataset: { act: 'commit' } });
    expect(h.store.data.days.find((day) => day.date === '2026-11-05')?.status).toBe('settled');
    sheet.open();
    expect(box.innerHTML).toContain('data-history-date aria-label="补结算日期" min="2026-11-01" max="2026-11-10" value="2026-11-10"');
  });

  it('defaults to the earliest pending day, not a previously viewed historical tab', () => {
    const h = makeStore('2026-11-01', '2026-11-01');
    const village = A.createProject(h.store, 'Village');
    A.createTask(h.store, { title: 'Pending work', projectId: village.id, scheduledFor: '2026-11-07' });
    h.setToday('2026-11-10');
    const sheet = new SettleSheet(h.store, { brick() {}, onOpenChange() {} });
    sheet.open('2026-11-05');
    sheet.close();
    sheet.open();
    expect(box.innerHTML).toContain('value="2026-11-07"');
  });

  it('preserves intermediate native date edits, validates on Enter, and applies only on explicit confirmation', () => {
    const { store, today } = makeStore('2026-11-10', '2026-11-01');
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open(today);
    const html = box.innerHTML;
    const reportValidity = vi.fn();
    const input = {
      value: '0002-11-05',
      matches: (selector: string) => selector === '[data-history-date]',
      checkValidity: () => input.value === '2026-11-05',
      reportValidity,
      focus: vi.fn(),
    };

    sheetEvent('change', input);
    expect(input.value).toBe('0002-11-05');
    expect(box.innerHTML).toBe(html);
    const key = sheetEvent('keydown', input, 'Enter');
    expect(key.defaultPrevented).toBe(true);
    expect(reportValidity).toHaveBeenCalledOnce();
    expect(input.value).toBe('0002-11-05');

    sheetEvent('focusout', input);
    expect(input.value).toBe(today);
    expect(box.innerHTML).toBe(html);

    input.value = '2026-11-05';
    sheetEvent('change', input);
    sheetEvent('focusout', input);
    // Valid blur leaves the current review visible and any pressed button alive.
    expect(input.value).toBe('2026-11-05');
    expect(box.innerHTML).toBe(html);

    vi.spyOn(box, 'querySelector').mockImplementation((selector) =>
      selector === '[data-history-date]' ? input : null);
    click('[data-act]', { dataset: { act: 'apply-date' } });
    expect(box.innerHTML).toContain('value="2026-11-05"');

    sheet.open(today);
    input.value = '2026-11-05';
    sheetEvent('keydown', input, 'Enter');
    expect(box.innerHTML).toContain('value="2026-11-05"');
  });

  it('preserves a day-tab first click after the date field loses focus', () => {
    const { store, today } = makeStore('2026-11-10', '2026-11-01');
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open('2026-11-05');
    const before = box.innerHTML;
    const input = {
      value: '2026-11-07',
      matches: (selector: string) => selector === '[data-history-date]',
      checkValidity: () => true,
    };
    sheetEvent('focusout', input);
    // The click target must not be replaced between pointerdown and click.
    expect(box.innerHTML).toBe(before);
    click('[data-day]', { dataset: { day: today } });
    expect(box.innerHTML).toContain('value="2026-11-10"');
  });

  it('commits the visible day rather than an un-applied historical date after blur', () => {
    const { store, today } = makeStore('2026-11-10', '2026-11-01');
    const p = A.createProject(store, 'Visible village');
    const task = A.createTask(store, { title: 'Visible work', projectId: p.id, scheduledFor: today });
    const sheet = new SettleSheet(store, { brick() {}, onOpenChange() {} });
    sheet.open(today);
    const item = { dataset: { key: `task|${task.id}`, project: '' } };
    click('[data-set]', { dataset: { set: 'done' }, closest: () => item });
    const before = box.innerHTML;
    sheetEvent('focusout', {
      value: '2026-11-05',
      matches: (selector: string) => selector === '[data-history-date]',
      checkValidity: () => true,
    });
    expect(box.innerHTML).toBe(before);
    click('[data-act]', { dataset: { act: 'commit' } });
    expect(store.data.entries.find((entry) => entry.itemId === task.id)?.date).toBe(today);
    expect(store.data.days.find((day) => day.date === '2026-11-05')).toBeUndefined();
  });

});
