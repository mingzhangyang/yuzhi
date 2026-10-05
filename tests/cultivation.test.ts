import { describe, expect, it, vi } from 'vitest';
import { createDiary, createProject, createSchedule, createTask, deleteDiary, deleteSchedule, settleDay } from '../src/actions';
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

  it('describes repeated partial work as progress occurrences rather than distinct Todos', () => {
    const { store, setToday } = makeStore('2026-10-04');
    const p = createProject(store, '长任务');
    const task = createTask(store, { title: '分段完成', projectId: p.id, scheduledFor: '2026-10-04' });

    settleDay(store, '2026-10-04', new Map([[itemKey('task', task.id), { outcome: 'partial' }]]));
    setToday('2026-10-05');
    settleDay(store, '2026-10-05', new Map([[itemKey('task', task.id), { outcome: 'partial' }]]));

    const field = cultivationState(store.data, '2026-10-05').field;
    expect(field.score).toBe(2);
    expect(field.summary).toContain('2 次部分推进');
    expect(field.summary).not.toContain('2 件');
  });

  it('does not grow the orchard from planning alone; settlement is the cultivation fact', () => {
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
    expect(cultivationState(store.data, '2026-10-05').orchard).toMatchObject({ score: 0, level: 0 });

    settleDay(store, '2026-10-05', new Map([[itemKey('event', event.id), { outcome: 'done' }]]));
    expect(cultivationState(store.data, '2026-10-05').orchard).toMatchObject({ score: 2, level: 2 });
  });

  it('lets an honestly settled missed schedule leave a small orchard trace', () => {
    const { store } = makeStore('2026-10-05');
    const event = createSchedule(store, {
      title: '本来想散步',
      date: '2026-10-05',
      start: '18:00',
      end: '19:00',
      projectId: CHORES,
    });

    settleDay(store, '2026-10-05', new Map([[
      itemKey('event', event.id),
      { outcome: 'skipped', reason: 'no_energy' },
    ]]));

    expect(cultivationState(store.data, '2026-10-05').orchard).toMatchObject({ score: 0.5, level: 1 });
  });

  it('rejects a nonexistent DST wall-clock time even when the normalized interval stays positive', () => {
    vi.stubEnv('TZ', 'America/New_York');
    try {
      const { store } = makeStore('2026-03-08');
      expect(() => createSchedule(store, {
        title: 'DST gap',
        date: '2026-03-08',
        start: '02:30',
        end: '04:00',
        projectId: CHORES,
      })).toThrow('这个当地时间因夏令时切换不存在，请重新选择');
      expect(store.data.events).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
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

  it('deleting a diary immediately recalculates the garden from remaining facts', () => {
    const { store, setToday } = makeStore('2026-10-04');
    const first = createDiary(store, { text: '第一天' });
    setToday('2026-10-05');
    createDiary(store, { text: '第二天' });
    expect(cultivationState(store.data, '2026-10-05').garden.score).toBe(2);

    deleteDiary(store, first.id);
    expect(store.data.diaries.map((entry) => entry.text)).toEqual(['第二天']);
    expect(cultivationState(store.data, '2026-10-05').garden.score).toBe(1);
  });

  it('deletes only unsettled local schedules and preserves settled history', () => {
    const { store } = makeStore('2026-10-05');
    const removable = createSchedule(store, {
      title: '可删日程',
      date: '2026-10-05',
      start: '11:00',
      end: '12:00',
      projectId: CHORES,
    });
    deleteSchedule(store, removable.id);
    expect(store.data.events.some((event) => event.id === removable.id)).toBe(false);

    const historical = createSchedule(store, {
      title: '历史日程',
      date: '2026-10-05',
      start: '18:00',
      end: '19:00',
      projectId: CHORES,
    });
    settleDay(store, '2026-10-05', new Map([[itemKey('event', historical.id), { outcome: 'done' }]]));
    expect(() => deleteSchedule(store, historical.id)).toThrow('这个日程已经留下结算记录，不能直接删除');
    expect(store.data.events.some((event) => event.id === historical.id)).toBe(true);
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
