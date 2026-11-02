import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers';
import { createDiary, createProject, createSchedule, createTask, editTaskPlan, repairTruncatedYearDates, rescheduleTask } from '../src/actions';
import { backlog } from '../src/logic/metrics';

describe('YZ-F1 待办日期', () => {
  it('建岛日新建的未来待办不算过期，也不进积压', () => {
    const { store, today } = makeStore('2026-11-01', '2026-11-01');
    const project = createProject(store, '屿志推广');
    for (const date of ['2026-11-03', '2026-11-04', '2026-11-04', '2026-11-06', '2026-11-06', '2026-11-08', '2026-11-02']) {
      createTask(store, { title: `待办 ${date}`, projectId: project.id, scheduledFor: date });
    }
    expect(backlog(store.data, today)).toEqual({ dock: 0, overdue: 0, total: 0 });
  });

  it('到期日过去之后才算过期', () => {
    const env = makeStore('2026-11-01', '2026-11-01');
    const project = createProject(env.store, '屿志推广');
    createTask(env.store, { title: '回复帖子', projectId: project.id, scheduledFor: '2026-11-02' });
    env.setToday('2026-11-02');
    expect(backlog(env.store.data, env.today).overdue).toBe(0);
    env.setToday('2026-11-03');
    expect(backlog(env.store.data, env.today).overdue).toBe(1);
  });

  it('拒绝半截年份之类不合理的日期，而不是存成「过期」的任务', () => {
    const { store } = makeStore('2026-11-01', '2026-11-01');
    const project = createProject(store, '屿志推广');
    expect(() => createTask(store, { title: '写帖子', projectId: project.id, scheduledFor: '0002-11-03' })).toThrow('日期');
    expect(store.data.tasks).toEqual([]);

    const task = createTask(store, { title: '写帖子', projectId: project.id, scheduledFor: '2026-11-03' });
    expect(() => rescheduleTask(store, task.id, '0020-11-03')).toThrow('日期');
    expect(() => editTaskPlan(store, task.id, project.id, '2026-02-30')).toThrow('日期');
    expect(store.task(task.id)?.scheduledFor).toBe('2026-11-03');

    expect(() => createDiary(store, { text: '搬进小岛', date: '0002-11-01' })).toThrow('日期');
    expect(() => createSchedule(store, { title: '会议', date: '0202-11-03', start: '09:00', end: '10:00' })).toThrow('日期');
  });
});

describe('YZ-F1 已存错年份的数据修复', () => {
  it('把 1900 年以前的到期日按创建那年修回来，并且不再算过期', async () => {
    const { store, today } = makeStore('2026-11-01', '2026-11-01');
    const project = createProject(store, '屿志推广');
    const good = createTask(store, { title: '本来就对', projectId: project.id, scheduledFor: '2026-11-02' });
    // Simulate a task saved by the old picker: its creation fact carries year 2.
    const bad = createTask(store, { title: '写帖子', projectId: project.id, scheduledFor: '2026-11-03' });
    store.batch(() => {
      store.put('tasks', { ...store.taskRecord(bad.id)!, scheduledFor: '0002-11-03' });
      for (const op of store.data.operations) {
        if (op.taskId === bad.id && op.kind === 'task-created') store.put('operations', { ...op, payload: { ...op.payload, scheduledFor: '0002-11-03' } });
      }
    });
    expect(store.task(bad.id)?.scheduledFor).toBe('0002-11-03');
    expect(backlog(store.data, today).overdue).toBe(1);

    expect(repairTruncatedYearDates(store)).toEqual([bad.id]);
    expect(store.task(bad.id)?.scheduledFor).toBe('2026-11-03');
    expect(store.task(good.id)?.scheduledFor).toBe('2026-11-02');
    expect(backlog(store.data, today).overdue).toBe(0);
    // Idempotent: nothing left to repair.
    expect(repairTruncatedYearDates(store)).toEqual([]);
  });
});
