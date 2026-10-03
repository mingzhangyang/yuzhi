import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers';
import { createProject, createTask, settleDay, archiveOldDays, restartProject, trimProject, projectsNeedingPrompt, refreshStages, closeProject, reopenProject, markTaskDone, dropTask } from '../src/actions';
import { recoverOne, stageLifeEntries, stageOfNeglect, stageTransitions } from '../src/logic/decay';
import { itemKey } from '../src/logic/days';
import { lifeEntries } from '../src/logic/operations';
import { emptyData, type Coll, type Persistence } from '../src/db';
import { Store } from '../src/store';

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

  it('重新结算只留下这一天的净阶段变化', () => {
    const h = makeStore('2026-09-01');
    const p = createProject(h.store, '团队');
    h.setToday('2026-09-09');
    refreshStages(h.store);
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    const stageLines = () => stageLifeEntries(h.store.data, h.today).filter((l) => l.id.startsWith('stage|')).map((l) => l.text);
    const settle = (d: Parameters<typeof settleDay>[2] extends Map<string, infer V> ? V : never) => settleDay(h.store, h.today, new Map([[itemKey('task', t.id), d]]));

    settle({ outcome: 'done' });
    expect(h.store.villages().get(p.id)!.stage).toBe(0);
    expect(stageLines()).toHaveLength(1);

    // 改成没精力：这一天不再有阶段变化，上一条撤掉
    settle({ outcome: 'skipped', reason: 'no_energy' });
    expect(h.store.villages().get(p.id)!.stage).toBe(1);
    expect(stageLines()).toEqual([]);

    // 再改回做了：仍然只有一条
    settle({ outcome: 'done' });
    expect(stageLines()).toHaveLength(1);
    expect(h.store.data.chronicle.find((c) => c.id === `day|${h.today}`)!.kind).toBe('recover');
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

describe('阶段历史重放', () => {
  it('关闭期间不生成阶段变化，重开后从重启事实继续', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '暂停的项目');
    h.setToday('2026-09-03');
    closeProject(h.store, p.id, '先停一下');
    h.setToday('2026-10-01');
    reopenProject(h.store, p.id);

    const closedGap = stageLifeEntries(h.store.data, h.today).filter(
      (entry) => entry.projectId === p.id && entry.date > '2026-09-03' && entry.date < '2026-10-01',
    );
    expect(closedGap).toEqual([]);
  });

  it('离线跨过多个阶段后 refreshStages 会从最后记录边界补齐', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    createProject(h.store, '长期项目');
    h.setToday('2026-10-01');

    const changes = refreshStages(h.store);
    expect(changes.map((change) => change.to)).toEqual([1, 2, 3]);
    expect(h.store.data.chronicle.filter((line) => line.id.startsWith('stage|')).map((line) => line.date)).toEqual([
      '2026-09-09',
      '2026-09-16',
      '2026-09-30',
    ]);
  });

  it('迁移阶段边界在多次 refreshStages 后保持稳定，不回填旧阶段', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    createProject(h.store, '迁移项目');
    h.store.data.operations.push({
      id: 'op|v3-stage-replay-boundary',
      seq: Math.max(0, ...h.store.data.operations.map((event) => event.seq)) + 1,
      date: '2026-09-20',
      kind: 'migration-boundary',
    });
    h.setToday('2026-10-01');

    expect(refreshStages(h.store).map((change) => change.to)).toEqual([3]);
    expect(h.store.data.chronicle.filter((line) => line.id.startsWith('stage|')).map((line) => line.date)).toEqual(['2026-09-30']);

    expect(refreshStages(h.store)).toEqual([]);
    expect(h.store.data.chronicle.filter((line) => line.id.startsWith('stage|')).map((line) => line.date)).toEqual(['2026-09-30']);
  });

  it('改判历史结算后 chronicle 保留旧叙述，只追加新的缺失边界', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '会恢复的项目');
    h.setToday('2026-09-08');
    const t = createTask(h.store, { title: '推进一下', projectId: p.id, scheduledFor: h.today });
    const key = itemKey('task', t.id);
    settleDay(h.store, h.today, new Map([[key, { outcome: 'skipped', reason: 'no_energy' }]]));

    h.setToday('2026-10-01');
    refreshStages(h.store);
    const before = h.store.data.chronicle
      .filter((line) => line.id.startsWith('stage|'))
      .map((line) => ({ ...line }));
    expect(before.length).toBeGreaterThan(0);

    h.setToday('2026-09-08');
    settleDay(h.store, h.today, new Map([[key, { outcome: 'done' }]]));
    h.setToday('2026-10-01');
    refreshStages(h.store);

    for (const oldLine of before) {
      expect(h.store.data.chronicle.find((line) => line.id === oldLine.id)).toEqual(oldLine);
    }
    const actualIds = new Set(h.store.data.chronicle.filter((line) => line.id.startsWith('stage|')).map((line) => line.id));
    const currentIds = stageTransitions(h.store.data, h.today)
      .filter((transition) => transition.source === 'time')
      .map((transition) => `stage|${transition.date}|${transition.projectId}`);
    for (const id of currentIds) expect(actualIds.has(id)).toBe(true);
  });

  it('同日 settlement 在 project close 之前时先应用推进，再关闭项目', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '顺序项目');
    h.setToday('2026-09-20');
    expect(h.store.villages().get(p.id)!.stage).toBe(2);
    const t = createTask(h.store, { title: '收尾推进', projectId: p.id, scheduledFor: h.today });
    settleDay(h.store, h.today, new Map([[itemKey('task', t.id), { outcome: 'done' }]]));
    const settlementSeq = h.store.data.entries.find((entry) => entry.itemId === t.id)!.seq;
    closeProject(h.store, p.id, '当天关闭');
    const closeSeq = h.store.data.operations.find((event) => event.kind === 'project-closed' && event.projectId === p.id)!.seq;
    expect(settlementSeq).toBeLessThan(closeSeq);

    const transition = stageTransitions(h.store.data, h.today).find(
      (row) => row.source === 'facts' && row.projectId === p.id && row.date === h.today,
    );
    expect(transition).toMatchObject({ from: 2, to: 1 });
  });

  it('事实触发的阶段行继承 settlement seq，并保持同日因果顺序', () => {
    const h = makeStore('2026-09-20', '2026-09-01');
    const p = createProject(h.store, '顺序村落');
    expect(h.store.villages().get(p.id)!.stage).toBe(2);

    const t = createTask(h.store, { title: '推进', projectId: p.id, scheduledFor: h.today });
    settleDay(h.store, h.today, new Map([[itemKey('task', t.id), { outcome: 'done' }]]));
    const settlement = h.store.data.entries.find((entry) => entry.itemId === t.id)!;
    closeProject(h.store, p.id, '当天收尾');

    const derived = stageLifeEntries(h.store.data, h.today);
    const stage = derived.find((entry) => entry.id === `stage|${h.today}|${p.id}`)!;
    expect(stage.factSeq).toBe(settlement.seq);

    const ordered = lifeEntries(h.store.data, derived).filter(
      (entry) => entry.date === h.today && entry.projectId === p.id,
    );
    const doneIndex = ordered.findIndex((entry) => entry.id === `l|${settlement.id}`);
    const stageIndex = ordered.findIndex((entry) => entry.id === stage.id);
    const closeIndex = ordered.findIndex((entry) => entry.kind === 'close');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(stageIndex).toBeGreaterThan(doneIndex);
    expect(closeIndex).toBeGreaterThan(stageIndex);
  });

  it('同日 trim 与 settlement 按 seq 决定最终衰败状态', () => {
    const beforeTrim = makeStore('2026-09-20', '2026-09-01');
    const p1 = createProject(beforeTrim.store, '先推进');
    const t1 = createTask(beforeTrim.store, { title: '推进', projectId: p1.id, scheduledFor: beforeTrim.today });
    settleDay(beforeTrim.store, beforeTrim.today, new Map([[itemKey('task', t1.id), { outcome: 'done' }]]));
    trimProject(beforeTrim.store, p1.id, []);
    expect(beforeTrim.store.villages().get(p1.id)!.neglect).toBe(7);

    const afterTrim = makeStore('2026-09-20', '2026-09-01');
    const p2 = createProject(afterTrim.store, '先裁剪');
    const t2 = createTask(afterTrim.store, { title: '推进', projectId: p2.id, scheduledFor: afterTrim.today });
    trimProject(afterTrim.store, p2.id, []);
    settleDay(afterTrim.store, afterTrim.today, new Map([[itemKey('task', t2.id), { outcome: 'done' }]]));
    expect(afterTrim.store.villages().get(p2.id)!.neglect).toBe(0);
  });

  it('历史 pending 按当时任务状态重建，不把前一天误算成荒置并制造假恢复', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: '2026-09-08' });
    h.setToday('2026-09-09');
    markTaskDone(h.store, t.id);

    expect(stageLifeEntries(h.store.data, h.today).filter((entry) => entry.id === `stage|2026-09-09|${p.id}`)).toEqual([]);
  });

  it('后来放下逾期任务后，当前村落仍按历史 pending 冻结旧日期', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '历史 pending');
    const t = createTask(h.store, { title: '旧任务', projectId: p.id, scheduledFor: '2026-09-02' });
    h.setToday('2026-09-09');
    dropTask(h.store, t.id);

    // 9/2 当时有未结算任务，应冻结；只累计 9/3..9/8 六个空白日。
    expect(h.store.villages().get(p.id)!.neglect).toBe(6);
    expect(stageTransitions(h.store.data, h.today).filter(
      (row) => row.projectId === p.id && row.source === 'time',
    )).toEqual([]);
  });

  it('第三次推迟触发的阶段行使用该 settlement seq，而不是后续无关事实', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '因果顺序');
    const t = createTask(h.store, { title: '难事', projectId: p.id, scheduledFor: h.today });
    let thirdSeq = 0;
    for (let k = 0; k < 3; k++) {
      const date = h.store.task(t.id)!.scheduledFor!;
      h.setToday(date);
      settleDay(h.store, date, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'postponed' }]]));
      if (k === 2) thirdSeq = h.store.data.entries.find((entry) => entry.itemId === t.id && entry.date === date)!.seq;
    }
    const unrelated = createTask(h.store, { title: '无关新任务', projectId: p.id, scheduledFor: h.today });
    const unrelatedSeq = h.store.data.operations.find(
      (event) => event.kind === 'task-created' && event.taskId === unrelated.id,
    )!.seq;
    expect(thirdSeq).toBeLessThan(unrelatedSeq);

    const transition = stageTransitions(h.store.data, h.today).find(
      (row) => row.projectId === p.id && row.date === h.today && row.source === 'facts',
    );
    expect(transition).toMatchObject({ from: 0, to: 1, factSeq: thirdSeq });
  });

  it('未结算日直接完成会立即移除推迟惩罚并生成恢复阶段史', () => {
    const h = makeStore('2026-09-01', '2026-09-01');
    const p = createProject(h.store, '拖延项目');
    const t = createTask(h.store, { title: '难事', projectId: p.id, scheduledFor: h.today });
    for (let k = 0; k < 3; k++) {
      const date = h.store.task(t.id)!.scheduledFor!;
      settleDay(h.store, date, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'postponed' }]]));
      h.setToday(h.store.task(t.id)!.scheduledFor!);
    }
    expect(h.store.villages().get(p.id)!.stage).toBe(1);

    markTaskDone(h.store, t.id);
    expect(h.store.villages().get(p.id)!.stage).toBe(0);
    expect(stageLifeEntries(h.store.data, h.today).some((entry) => entry.projectId === p.id && entry.date === h.today && entry.text.includes('热闹'))).toBe(true);
  });

  it('阶段时间线对未变化的数据复用缓存结果', () => {
    const h = makeStore('2026-09-01');
    createProject(h.store, '缓存');
    h.setToday('2026-10-01');
    expect(stageTransitions(h.store.data, h.today)).toBe(stageTransitions(h.store.data, h.today));
  });

  it('持久层改写权威 fact seq 后会失效阶段时间线缓存', async () => {
    const data = emptyData();
    data.settings.firstDay = '2026-09-01';
    data.projects.push({ id: 'p1', name: '并发村落', createdAt: '2026-09-01', status: 'active', islandSlot: 0 });
    const persist: Persistence = {
      async load() { return data; },
      async put(coll: Coll) { return coll === 'entries' || coll === 'operations' ? 42 : undefined; },
      async renameFact() { return 42; },
      async del() {},
      async putSettings() {},
      async replaceAll() {},
    };
    const store = new Store(data, persist);
    const entry = {
      id: '2026-09-20|task|t1',
      seq: 1,
      date: '2026-09-20',
      itemType: 'task' as const,
      itemId: 't1',
      outcome: 'done' as const,
      projectId: 'p1',
      title: '推进',
    };
    store.put('entries', entry);

    const provisional = stageTransitions(data, '2026-09-20').find(
      (row) => row.projectId === 'p1' && row.source === 'facts',
    );
    expect(provisional?.factSeq).toBe(1);

    await store.flush();
    expect(entry.seq).toBe(42);
    const authoritative = stageTransitions(data, '2026-09-20').find(
      (row) => row.projectId === 'p1' && row.source === 'facts',
    );
    expect(authoritative?.factSeq).toBe(42);
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
