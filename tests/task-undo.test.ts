import { describe, expect, it } from 'vitest';
import * as A from '../src/actions';
import { makeStore } from './helpers';

describe('undo a quick “done today”', () => {
  it('removes the settlement fact so the task is open again', () => {
    const { store, today } = makeStore();
    const p = A.createProject(store, '写作');
    const t = A.createTask(store, { title: '第一章', projectId: p.id });
    const undo = A.markTaskDone(store, t.id)!;
    expect(store.task(t.id)!.status).toBe('done');
    expect(A.undoTaskDone(store, undo)).toBe(true);
    expect(store.task(t.id)!.status).toBe('open');
    expect(store.data.entries.some((entry) => entry.date === today && entry.itemId === t.id)).toBe(false);
  });

  it('restores an earlier verdict for the same day exactly, including its seq', () => {
    const { store, today } = makeStore();
    const p = A.createProject(store, '写作');
    const t = A.createTask(store, { title: '第二章', projectId: p.id, scheduledFor: today });
    A.settleDay(store, today, new Map([[`task|${t.id}`, { outcome: 'partial' as const }]]));
    const before = store.data.entries.find((entry) => entry.itemId === t.id)!;
    const undo = A.markTaskDone(store, t.id)!;
    expect(store.data.entries.find((entry) => entry.itemId === t.id)!.outcome).toBe('done');
    A.undoTaskDone(store, undo);
    expect(store.data.entries.find((entry) => entry.itemId === t.id)).toEqual(before);
  });

  it('leaves a verdict alone once it was changed elsewhere', () => {
    const { store, today } = makeStore();
    const p = A.createProject(store, '写作');
    const t = A.createTask(store, { title: '第三章', projectId: p.id, scheduledFor: today });
    const undo = A.markTaskDone(store, t.id)!;
    A.settleDay(store, today, new Map([[`task|${t.id}`, { outcome: 'skipped' as const, reason: 'no_energy' as const }]]));
    expect(A.undoTaskDone(store, undo)).toBe(false);
    expect(store.data.entries.find((entry) => entry.itemId === t.id)!.outcome).toBe('skipped');
  });
});
