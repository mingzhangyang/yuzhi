import { describe, expect, it, vi } from 'vitest';
import { emptyData, MemoryPersistence } from '../src/db';
import { Store } from '../src/store';

const toast = vi.fn();
const openModal = vi.fn();
vi.mock('../src/ui/dom', async (importOriginal) => ({ ...(await importOriginal<object>()), toast: (...a: unknown[]) => toast(...a) }));
vi.mock('../src/ui/modal', async (importOriginal) => ({ ...(await importOriginal<object>()), openModal: (...a: unknown[]) => openModal(...a) }));

const { openCalendar, openClassify, openNew } = await import('../src/ui/forms');

describe('calendar dialog', () => {
  it('a read-only tab gets a notice instead of a partially bound dialog', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    store.setReadOnly(true);
    expect(() => openCalendar(store, () => {})).not.toThrow();
    expect(openModal).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('只读'), true);
  });

  it('a writer tab opens the dialog', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    openCalendar(store, () => {});
    expect(openModal).toHaveBeenCalledOnce();
  });

  it('honors an explicitly selected empty calendar summary', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    const event = (id: string, title: string, hour: number) => ({
      id,
      sourceId: 's',
      uid: id,
      title,
      start: new Date(2026, 9, 4, hour).toISOString(),
      end: new Date(2026, 9, 4, hour + 1).toISOString(),
      allDay: false,
      classified: false,
    });
    // The blank group is deliberately second, so a truthiness fallback would
    // open the wrong first group.
    store.data.events.push(event('named', '普通日程', 9), event('blank', '   ', 10));

    openClassify(store, new Set(), '');

    const dialog = openModal.mock.calls.at(-1)?.[0] as { title?: string } | undefined;
    expect(dialog?.title).toBe('「」属于哪里？');
  });
  it('does not fall back to another group when an explicit drift title went stale', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    store.data.events.push({
      id: 'still-here',
      sourceId: 's',
      uid: 'still-here',
      title: '仍存在的日程',
      start: new Date(2026, 9, 4, 9).toISOString(),
      end: new Date(2026, 9, 4, 10).toISOString(),
      allDay: false,
      classified: false,
    });
    const callsBefore = openModal.mock.calls.length;

    openClassify(store, new Set(), '已经消失的漂流瓶');

    expect(openModal.mock.calls.length).toBe(callsBefore);
  });
});


describe('unified capture dialog', () => {
  it('keeps global Todo capture intentionally unscheduled and unassigned by default', () => {
    const store = new Store(emptyData(), new MemoryPersistence());

    openNew(store, 'task');

    const dialog = openModal.mock.calls.at(-1)?.[0] as { title?: string; body?: string } | undefined;
    expect(dialog?.title).toBe('新建 Todo');
    expect(dialog?.body).toContain('<option value="" selected>不定日期</option>');
    expect(dialog?.body).toContain('未指定 · 先停在码头');
    expect(dialog?.body).toContain('其他日期…');
  });

  it('uses task-specific titles instead of exposing the internal “现实输入” concept', () => {
    const store = new Store(emptyData(), new MemoryPersistence());

    openNew(store, 'diary');
    expect((openModal.mock.calls.at(-1)?.[0] as { title?: string }).title).toBe('写日记');

    openNew(store, 'schedule');
    expect((openModal.mock.calls.at(-1)?.[0] as { title?: string; body?: string }).title).toBe('新建日程');
    expect((openModal.mock.calls.at(-1)?.[0] as { body?: string }).body).toContain('其他日期…');

    openNew(store, 'project');
    expect((openModal.mock.calls.at(-1)?.[0] as { title?: string }).title).toBe('新建项目');
  });
});
