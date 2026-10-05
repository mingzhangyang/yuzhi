import { describe, expect, it } from 'vitest';
import { createDiary, createProject, createSchedule, createTask, settleDay } from '../src/actions';
import { cultivationState } from '../src/logic/cultivation';
import { itemKey } from '../src/logic/days';
import { exportBackup, parseBackup } from '../src/db';
import { CHORES, LOCAL_CALENDAR_SOURCE_ID } from '../src/types';
import { makeStore } from './helpers';

describe('real-life cultivation read model', () => {
  it('does not grow the field when a Todo is merely created, but grows after real progress', () => {
    const { store } = makeStore('2026-10-05');
    const p = createProject(store, '写书');
    const task = createTask(store, { title: '写一页', projectId: p.id, scheduledFor: '2026-10-05' });

    expect(cultivationState(store.data, '2026-10-05').field.level).toBe(0);

    settleDay(store, '2026-10-05', new Map([[itemKey('task', task.id), { outcome: 'done' }]]));
    expect(cultivationState(store.data, '2026-10-05').field.score).toBe(2);
  });

  it('maps local schedules into the calendar pipeline and the orchard', () => {
    const { store } = makeStore('2026-10-05');
    const event = createSchedule(store, {
      title: '散步',
      date: '2026-10-05',
      start: '18:00',
      end: '19:00',
      projectId: CHORES,
    });

    expect(event).toMatchObject({
      sourceId: LOCAL_CALENDAR_SOURCE_ID,
      classified: true,
      projectId: CHORES,
    });
    expect(cultivationState(store.data, '2026-10-05').orchard.level).toBeGreaterThan(0);

    settleDay(store, '2026-10-05', new Map([[itemKey('event', event.id), { outcome: 'done' }]]));
    expect(cultivationState(store.data, '2026-10-05').orchard.score).toBeGreaterThan(1);
  });

  it('rejects a local schedule that inverts after DST-gap normalization', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const { store } = makeStore('2026-03-08');
      expect(() => createSchedule(store, {
        title: 'DST gap',
        date: '2026-03-08',
        start: '02:30',
        end: '03:00',
        projectId: CHORES,
      })).toThrow('日程结束时间要晚于开始时间');
    } finally {
      if (previous == null) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('counts diary days rather than diary volume, and preserves diaries in backup', () => {
    const { store, setToday } = makeStore('2026-10-04');
    createDiary(store, { text: '第一篇' });
    createDiary(store, { text: '同一天第二篇' });
    expect(cultivationState(store.data, '2026-10-04').garden.score).toBe(1);

    setToday('2026-10-05');
    createDiary(store, { text: '第二天' });
    expect(cultivationState(store.data, '2026-10-05').garden.score).toBe(2);

    expect(parseBackup(exportBackup(store.data)).diaries).toHaveLength(3);
  });

  it('lets an honestly settled hard day nourish the pond even when the Todo was skipped', () => {
    const { store } = makeStore('2026-10-05');
    const p = createProject(store, '恢复节律');
    const task = createTask(store, { title: '今天先休息', projectId: p.id, scheduledFor: '2026-10-05' });

    settleDay(store, '2026-10-05', new Map([[
      itemKey('task', task.id),
      { outcome: 'skipped', reason: 'no_energy' },
    ]]));

    expect(cultivationState(store.data, '2026-10-05').pond).toMatchObject({ score: 1, level: 1 });
  });

  it('keeps cultivation derived instead of persisting a second state', () => {
    const { store } = makeStore('2026-10-05');
    expect(Object.hasOwn(store.data, 'cultivation')).toBe(false);
  });
});
