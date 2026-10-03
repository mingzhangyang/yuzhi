import { describe, expect, it } from 'vitest';
import { closeProject, createProject, createTask, rescheduleTask, restartProject, settleDay } from '../src/actions';
import { itemKey } from '../src/logic/days';
import { makeStore } from './helpers';

describe('Phase 2 fact replay', () => {
  it('改判旧结算不会覆盖后来手动改期', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);

    settleDay(h.store, '2026-10-01', new Map([[key, { outcome: 'skipped', reason: 'postponed' }]]));
    expect(h.store.task(t.id)).toMatchObject({ scheduledFor: '2026-10-02', postponeCount: 1 });
    expect(h.store.taskRecord(t.id)).toMatchObject({ scheduledFor: '2026-10-01', status: 'open' });
    expect(h.store.data.life.some((entry) => entry.id.startsWith('l|2026-10-01|task|'))).toBe(false);
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
