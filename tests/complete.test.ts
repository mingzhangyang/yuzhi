import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers';
import { completeProject, createProject, createTask, islandRings, restartProject, setResting, settleDay, freeLandmarkIndex } from '../src/actions';
import { itemKey } from '../src/logic/days';
import { summarize } from '../src/logic/summary';
import { ringCapacity } from '../src/island/map';

describe('落成仪式', () => {
  it('完成项目：放下没做完的任务、腾出村落、立为地标', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '写书');
    const a = createTask(h.store, { title: '初稿', projectId: p.id, scheduledFor: h.today });
    const b = createTask(h.store, { title: '找出版社', projectId: p.id });
    settleDay(h.store, h.today, new Map([[itemKey('task', a.id), { outcome: 'done' }]]));
    expect(completeProject(h.store, p.id, 'landmark')).toBe('landmark');
    expect(h.store.project(p.id)).toMatchObject({ status: 'done', doneAt: '2026-10-01', resting: 'landmark', landmarkIndex: 0 });
    expect(h.store.task(b.id)!.status).toBe('dropped');
    expect(h.store.activeProjects()).toEqual([]);
    expect(h.store.villages().has(p.id)).toBe(false);
    // 槽位空出来，新项目可以住进去
    expect(createProject(h.store, '新项目').islandSlot).toBe(0);
    expect(h.store.data.chronicle.at(-2)!.text).toContain('落成');
  });

  it('选择可以反悔，地标位取最小的空位', () => {
    const h = makeStore();
    const ids = ['A', 'B', 'C'].map((n) => createProject(h.store, n).id);
    for (const id of ids) completeProject(h.store, id, 'landmark');
    expect(ids.map((id) => h.store.project(id)!.landmarkIndex)).toEqual([0, 1, 2]);
    setResting(h.store, ids[1], 'archive');
    expect(h.store.project(ids[1])).toMatchObject({ resting: 'archive', landmarkIndex: undefined });
    expect(freeLandmarkIndex(h.store)).toBe(1);
    setResting(h.store, ids[1], 'landmark');
    expect(h.store.project(ids[1])!.landmarkIndex).toBe(1);
  });

  it('地标越多，岛长出新的年轮', () => {
    const h = makeStore();
    const n = ringCapacity(0) + 1;
    expect(islandRings(h.store)).toBe(0);
    for (let k = 0; k < n; k++) completeProject(h.store, createProject(h.store, `P${k}`).id, 'landmark');
    expect(islandRings(h.store)).toBe(1);
  });

  it('一生之书小结：用时、推迟、卡点、转折', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '健身');
    const t = createTask(h.store, { title: '力量训练', projectId: p.id, scheduledFor: '2026-09-01' });
    for (let k = 0; k < 3; k++) {
      const d = h.store.task(t.id)!.scheduledFor!;
      settleDay(h.store, d, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'postponed' }]]));
    }
    restartProject(h.store, p.id);
    const u = createTask(h.store, { title: '慢跑', projectId: p.id, scheduledFor: '2026-09-05' });
    const v = createTask(h.store, { title: '拉伸', projectId: p.id, scheduledFor: '2026-09-05' });
    h.setToday('2026-09-05');
    settleDay(h.store, '2026-09-05', new Map([[itemKey('task', u.id), { outcome: 'done' }], [itemKey('task', v.id), { outcome: 'skipped', reason: 'no_energy' }]]));
    const s = summarize(h.store.data, h.store.project(p.id)!, '2026-09-10');
    expect(s.days).toBe(10);
    expect(s.postpones).toBe(3);
    expect(s.bricks).toBe(1);
    expect(s.blockers.map((b) => b.text)).toEqual(['推到明天', '没精力', '「力量训练」一再推迟']);
    expect(s.turns[0]).toEqual({ date: '2026-09-01', text: '重新启动，村落重新热闹起来' });
    expect(s.turns.some((x) => x.text === '第一块砖落进村落')).toBe(true);
  });
});
