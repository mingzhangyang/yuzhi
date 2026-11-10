import { describe, expect, it } from 'vitest';
import { createProject, createTask, settleDay } from '../src/actions';
import { itemsForDay, itemKey } from '../src/logic/days';
import { makeStore } from './helpers';

describe('YZ-F9 historical settlement', () => {
  it('settles an archived date without counting tasks from other dates', () => {
    const h = makeStore('2026-11-01', '2026-11-01');
    const p = createProject(h.store, 'Village');
    const due = createTask(h.store, { title: 'Due on the fifth', projectId: p.id, scheduledFor: '2026-11-05' });
    const later = createTask(h.store, { title: 'Due tomorrow', projectId: p.id, scheduledFor: '2026-11-11' });
    h.setToday('2026-11-10');
    h.store.put('days', { date: '2026-11-05', status: 'unrecorded' });
    const items = itemsForDay(h.store.data, '2026-11-05');
    expect(items.map((item) => item.id)).toContain(due.id);
    expect(items.map((item) => item.id)).not.toContain(later.id);
    settleDay(h.store, '2026-11-05', new Map([[itemKey('task', due.id), { outcome: 'done' }]]));
    expect(h.store.data.days.find((day) => day.date === '2026-11-05')?.status).toBe('settled');
    expect(h.store.data.entries.find((entry) => entry.itemId === due.id)?.date).toBe('2026-11-05');
    expect(h.store.data.entries.some((entry) => entry.itemId === later.id)).toBe(false);
  });

  it('records explicitly completed early work without changing its planned date', () => {
    const h = makeStore('2026-11-10', '2026-11-01');
    const p = createProject(h.store, 'Village');
    const task = createTask(h.store, { title: 'Early work', projectId: p.id, scheduledFor: '2026-11-12' });
    const date = '2026-11-10';
    const extra = { key: itemKey('task', task.id), type: 'task' as const, id: task.id, title: task.title, projectId: p.id };
    settleDay(h.store, date, new Map([[extra.key, { outcome: 'done' }]]), [extra]);
    expect(h.store.data.entries.find((entry) => entry.itemId === task.id)?.date).toBe(date);
    expect(h.store.task(task.id)?.scheduledFor).toBe('2026-11-12');
    expect(h.store.data.operations.some((operation) => operation.kind === 'task-rescheduled')).toBe(false);
  });

  it('revising the same historical date does not duplicate its settlement entry', () => {
    const h = makeStore('2026-11-10', '2026-11-01');
    const p = createProject(h.store, 'Village');
    const task = createTask(h.store, { title: 'Revised', projectId: p.id, scheduledFor: '2026-11-10' });
    const key = itemKey('task', task.id);
    settleDay(h.store, '2026-11-10', new Map([[key, { outcome: 'done' }]]));
    settleDay(h.store, '2026-11-10', new Map([[key, { outcome: 'partial' }]]));
    expect(h.store.data.entries.filter((entry) => entry.itemId === task.id)).toHaveLength(1);
    expect(h.store.data.entries.find((entry) => entry.itemId === task.id)?.outcome).toBe('partial');
  });
});
