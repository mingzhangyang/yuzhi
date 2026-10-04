import { describe, expect, it } from 'vitest';
import { closeProject, completeProject, createProject, createTask, moveTask, rescheduleTask, restartProject, settleDay } from '../src/actions';
import { itemKey } from '../src/logic/days';
import { taskState, taskStates, taskStatesForDates } from '../src/logic/read-model';
import { makeStore } from './helpers';

describe('Phase 2 fact replay', () => {
  it('历史快照不包含 throughDate 之后才创建的回填任务', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '团队');
    h.setToday('2026-09-10');
    const futureTask = createTask(h.store, { title: '后来补录', projectId: p.id, scheduledFor: '2026-09-02' });

    expect(taskStates(h.store.data, '2026-09-02').some((task) => task.id === futureTask.id)).toBe(false);
  });

  it('重开旧结算时保留 settlement 当时的项目归属，即使同日后来搬村', () => {
    const h = makeStore('2026-10-01');
    const p1 = createProject(h.store, '原项目');
    const p2 = createProject(h.store, '新项目');
    const t = createTask(h.store, { title: '历史任务', projectId: p1.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'skipped', reason: 'no_energy' }]]));
    const original = h.store.data.entries.find((entry) => entry.itemId === t.id)!;
    expect(original.projectId).toBe(p1.id);

    moveTask(h.store, t.id, p2.id);
    expect(h.store.task(t.id)?.projectId).toBe(p2.id);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'done' }]]));
    const corrected = h.store.data.entries.find((entry) => entry.itemId === t.id)!;
    expect(corrected.projectId).toBe(p1.id);
    expect(corrected.seq).toBe(original.seq);
  });

  it('已有 settlement 的空 projectId 也是历史快照，不被后来搬村补回', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '后来项目');
    const t = createTask(h.store, { title: '码头任务', scheduledFor: h.today });
    const key = itemKey('task', t.id);

    h.store.data.entries.push({
      id: `2026-10-01|task|${t.id}`,
      seq: Math.max(0, ...h.store.data.operations.map((event) => event.seq)) + 1,
      date: h.today,
      itemType: 'task',
      itemId: t.id,
      outcome: 'skipped',
      reason: 'no_energy',
      title: t.title,
    });
    moveTask(h.store, t.id, p.id);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'done' }]]));
    expect(h.store.data.entries.find((entry) => entry.itemId === t.id)?.projectId).toBeUndefined();
  });

  it('改判旧结算不会覆盖后来手动改期', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);

    settleDay(h.store, '2026-10-01', new Map([[key, { outcome: 'skipped', reason: 'postponed' }]]));
    expect(h.store.task(t.id)).toMatchObject({ scheduledFor: '2026-10-02', postponeCount: 1 });
    expect(h.store.taskRecord(t.id)).toMatchObject({ scheduledFor: '2026-10-01', status: 'open' });
    expect('life' in h.store.data).toBe(false);
    expect('interruptions' in h.store.data).toBe(false);

    h.setToday('2026-10-02');
    rescheduleTask(h.store, t.id, '2026-10-10');
    const manual = h.store.data.operations.find((event) => event.kind === 'task-rescheduled' && event.taskId === t.id)!;
    const originalSeq = h.store.data.entries.find((entry) => entry.itemId === t.id)!.seq;
    expect(manual.seq).toBeGreaterThan(originalSeq);

    settleDay(h.store, '2026-10-01', new Map([[key, { outcome: 'skipped', reason: 'no_energy' }]]));
    expect(h.store.data.entries.find((entry) => entry.itemId === t.id)!.seq).toBe(originalSeq);
    expect(h.store.task(t.id)).toMatchObject({
      status: 'open',
      scheduledFor: '2026-10-10',
      postponeCount: 0,
    });
  });

  it('历史日期的村落计算不受项目当前已关闭状态影响', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '后来关闭');
    const t = createTask(h.store, { title: '历史推进', projectId: p.id, scheduledFor: '2026-09-08' });
    h.setToday('2026-09-08');
    settleDay(h.store, h.today, new Map([[itemKey('task', t.id), { outcome: 'done' }]]));

    h.setToday('2026-09-10');
    closeProject(h.store, p.id, '后来关闭');
    expect(h.store.project(p.id)?.status).toBe('closed');

    // Rejudging 9/8 asks computeAllVillages(..., 9/8) for the before/after
    // stage. The project was active on that date even though it is closed now.
    settleDay(h.store, '2026-09-08', new Map([[itemKey('task', t.id), { outcome: 'partial' }]]));
    expect(h.store.data.chronicle.find((line) => line.id === 'day|2026-09-08')).toBeTruthy();
  });

  it('批量历史快照与逐日权威 taskState 完全一致', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '一致性');
    const t = createTask(h.store, { title: '双轴事实', projectId: p.id, scheduledFor: '2026-09-02' });

    h.setToday('2026-09-03');
    rescheduleTask(h.store, t.id, '2026-09-04');
    h.setToday('2026-09-05');
    settleDay(h.store, '2026-09-02', new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'postponed' }]]));
    h.setToday('2026-09-06');
    restartProject(h.store, p.id);

    const dates = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
    const batched = taskStatesForDates(h.store.data, h.store.taskRecord(t.id)!, dates);
    for (const date of dates) {
      expect(batched.get(date)).toEqual(taskState(h.store.data, h.store.taskRecord(t.id)!, date));
    }
  });

  it('项目关闭后改判更早的 done 为 partial，任务仍在关闭事实处被放下', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);
    settleDay(h.store, h.today, new Map([[key, { outcome: 'done' }]]));

    h.setToday('2026-10-02');
    closeProject(h.store, p.id, '暂停');
    expect(h.store.task(t.id)!.status).toBe('done');

    settleDay(h.store, '2026-10-01', new Map([[key, { outcome: 'partial' }]]));
    expect(h.store.task(t.id)).toMatchObject({ status: 'dropped', closedAt: '2026-10-02' });
  });

  it('改判为已完成后忽略项目完成时遗留的 task-dropped 事实', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '完成项目');
    const t = createTask(h.store, { title: '最后一件事', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'partial' }]]));
    expect(h.store.task(t.id)!.status).toBe('open');

    h.setToday('2026-10-02');
    completeProject(h.store, p.id, 'archive');
    expect(h.store.task(t.id)!.status).toBe('dropped');
    expect(h.store.data.operations.some(
      (event) => event.kind === 'task-dropped' && event.taskId === t.id && event.payload?.source === 'project-completed',
    )).toBe(true);

    settleDay(h.store, '2026-10-01', new Map([[key, { outcome: 'done' }]]));
    expect(h.store.task(t.id)).toMatchObject({ status: 'done', closedAt: '2026-10-01' });
  });

  it('同日先推迟后重启时，重启按 seq 清零；之后改判也不改变顺序', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '研究');
    const t = createTask(h.store, { title: '读论文', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'skipped', reason: 'postponed' }]]));
    const entrySeq = h.store.data.entries.find((entry) => entry.itemId === t.id)!.seq;
    expect(h.store.task(t.id)!.postponeCount).toBe(1);

    restartProject(h.store, p.id);
    const restart = h.store.data.operations.find((event) => event.kind === 'project-restarted' && event.projectId === p.id)!;
    expect(restart.seq).toBeGreaterThan(entrySeq);
    expect(h.store.task(t.id)!.postponeCount).toBe(0);

    settleDay(h.store, h.today, new Map([[key, { outcome: 'skipped', reason: 'interrupted' }]]));
    settleDay(h.store, h.today, new Map([[key, { outcome: 'skipped', reason: 'postponed' }]]));
    expect(h.store.data.entries.find((entry) => entry.itemId === t.id)!.seq).toBe(entrySeq);
    expect(h.store.task(t.id)!.postponeCount).toBe(0);
  });
});
