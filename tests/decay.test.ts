import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers';
import { createProject, createTask, settleDay, archiveOldDays, restartProject, trimProject, projectsNeedingPrompt } from '../src/actions';
import { recoverOne, stageOfNeglect } from '../src/logic/decay';
import { itemKey } from '../src/logic/days';

describe('阶段换算', () => {
  it('天数对应阶段', () => {
    expect([0, 6, 7, 13, 14, 27, 28, 60].map(stageOfNeglect)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it('一天推进回退一个阶段', () => {
    expect(recoverOne(40)).toBe(14);
    expect(recoverOne(14)).toBe(7);
    expect(recoverOne(9)).toBe(0);
    expect(recoverOne(3)).toBe(0);
  });
});

describe('衰败与恢复', () => {
  it('没有条目的日子照样流逝，荒了一个月进入搬离', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '团队');
    h.setToday('2026-09-08');
    expect(h.store.villages().get(p.id)!.stage).toBe(0); // 6 天
    h.setToday('2026-09-09');
    expect(h.store.villages().get(p.id)!.stage).toBe(1); // 7 天
    h.setToday('2026-10-01');
    expect(h.store.villages().get(p.id)!.stage).toBe(3);
    expect(projectsNeedingPrompt(h.store).map((x) => x.id)).toEqual([p.id]);
  });

  it('荒了一个月，认真三天就恢复热闹', () => {
    const h = makeStore('2026-08-01', '2026-08-01');
    const p = createProject(h.store, '写书');
    h.setToday('2026-09-05');
    expect(h.store.villages().get(p.id)!.stage).toBe(3);
    for (let k = 0; k < 3; k++) {
      const t = createTask(h.store, { title: `第${k}章`, projectId: p.id, scheduledFor: h.today });
      settleDay(h.store, h.today, new Map([[itemKey('task', t.id), { outcome: 'done' }]]));
      if (k < 2) expect(h.store.villages().get(p.id)!.stage).toBe(2 - k);
      h.advance();
    }
    // 第三天结算后，今天（新的一天）还没过完
    h.advance(-1);
    expect(h.store.villages().get(p.id)!.stage).toBe(0);
  });

  it('没精力不伤害村落，未结算的日子不产生后果', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '健身');
    for (let k = 1; k <= 10; k++) {
      const d = h.advance();
      const t = createTask(h.store, { title: `练 ${k}`, projectId: p.id, scheduledFor: d });
      settleDay(h.store, d, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'no_energy' }]]));
    }
    expect(h.store.villages().get(p.id)!.neglect).toBe(0);
    // 接下来 3 天有任务但没结算：雾里，不计
    const t = createTask(h.store, { title: '慢跑', projectId: p.id, scheduledFor: h.advance() });
    h.advance(2);
    expect(t).toBeTruthy();
    expect(h.store.villages().get(p.id)!.neglect).toBe(1); // 未结算那天冻结，之后一天空白日（今天还没过完不算）
  });

  it('超过 3 天未结算自动归档为未记录，不算做也不算没做', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, 'A');
    createTask(h.store, { title: 'x', projectId: p.id, scheduledFor: '2026-09-02' });
    h.setToday('2026-09-05');
    expect(archiveOldDays(h.store)).toEqual([]);
    h.setToday('2026-09-06');
    expect(archiveOldDays(h.store)).toEqual(['2026-09-02']);
    expect(h.store.data.days).toEqual([{ date: '2026-09-02', status: 'unrecorded' }]);
    expect(h.store.data.entries).toEqual([]);
    // 9/2 冻结；9/3、9/4、9/5 空白 → 3
    expect(h.store.villages().get(p.id)!.neglect).toBe(3);
  });

  it('同一任务推迟 3 次起，村落额外加重一档；重新启动清零', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, 'B');
    const t = createTask(h.store, { title: '拖着的事', projectId: p.id, scheduledFor: '2026-09-01' });
    for (let k = 0; k < 3; k++) {
      const d = h.store.task(t.id)!.scheduledFor!;
      settleDay(h.store, d, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'postponed' }]]));
      h.setToday(h.store.task(t.id)!.scheduledFor!);
    }
    const v = h.store.villages().get(p.id)!;
    expect(h.store.task(t.id)!.postponeCount).toBe(3);
    expect(v.baseStage).toBe(0);
    expect(v.stage).toBe(1);
    restartProject(h.store, p.id);
    expect(h.store.villages().get(p.id)!.stage).toBe(0);
  });

  it('缩小规模回到安静阶段起点，并放下选中的任务', () => {
    const h = makeStore('2026-08-01', '2026-08-01');
    const p = createProject(h.store, 'C');
    const a = createTask(h.store, { title: 'a', projectId: p.id });
    createTask(h.store, { title: 'b', projectId: p.id });
    h.setToday('2026-09-15');
    trimProject(h.store, p.id, [a.id]);
    expect(h.store.task(a.id)!.status).toBe('dropped');
    expect(h.store.villages().get(p.id)!.stage).toBe(1);
  });
});

describe('离开很久再回来', () => {
  it('超过两个月前的未结算日子也会被找到、归档，并且不产生后果', () => {
    const h = makeStore('2026-06-01', '2026-06-01');
    const p = createProject(h.store, '老项目');
    createTask(h.store, { title: '那天的事', projectId: p.id, scheduledFor: '2026-06-02' });
    h.setToday('2026-09-15');
    expect(archiveOldDays(h.store)).toEqual(['2026-06-02']);
    expect(h.store.data.days).toEqual([{ date: '2026-06-02', status: 'unrecorded' }]);
    const v = h.store.villages().get(p.id)!;
    // 6/2 冻结；6/3 到 9/14 共 104 天空白
    expect(v.neglect).toBe(104);
  });
});
