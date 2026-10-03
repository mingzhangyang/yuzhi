import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers';
import { createProject, createTask, settleDay, markTaskDone, closeProject, classifyEvents, mergeEvents, arrangeTask, recordBacklogSnapshot } from '../src/actions';
import { itemKey, itemsForDay, pendingDays } from '../src/logic/days';
import { backlog, backlogSeries, condition, granary, progress } from '../src/logic/metrics';
import { CHORES } from '../src/types';

describe('晚间结算', () => {
  it('四种结果改变任务、写进一生之书和编年史', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const d = h.today;
    const [a, b, c, e, f] = ['写周报', '改 bug', '读论文', '整理桌面', '回邮件'].map((title) => createTask(h.store, { title, projectId: p.id, scheduledFor: d }));
    const text = settleDay(
      h.store,
      d,
      new Map([
        [itemKey('task', a.id), { outcome: 'done' }],
        [itemKey('task', b.id), { outcome: 'partial' }],
        [itemKey('task', c.id), { outcome: 'skipped', reason: 'postponed' }],
        [itemKey('task', e.id), { outcome: 'skipped', reason: 'not_important' }],
        [itemKey('task', f.id), { outcome: 'skipped', reason: 'interrupted' }],
      ]),
    );
    expect(h.store.task(a.id)!.status).toBe('done');
    expect(h.store.task(b.id)!.scheduledFor).toBe('2026-10-02');
    expect(h.store.task(c.id)).toMatchObject({ scheduledFor: '2026-10-02', postponeCount: 1 });
    expect(h.store.task(e.id)!.status).toBe('dropped');
    expect(h.store.task(f.id)).toMatchObject({ status: 'open', scheduledFor: d });
    expect(h.store.data.interruptions.map((i) => i.title)).toEqual(['回邮件']);
    expect(h.store.project(p.id)!.lastProgressAt).toBe(d);
    expect(text).toContain('推进了 1 件事');
    expect(text).toContain('放下了 1 件不重要的事');
    expect(h.store.data.chronicle.find((c) => c.id === `day|${d}`)!.text).toBe(text);
    expect(h.store.data.life.filter((l) => l.projectId === p.id).map((l) => l.text)).toContain('「回邮件」没做：被打断');
  });

  it('没有日期的任务不进结算列表；码头任务不进', () => {
    const h = makeStore();
    const p = createProject(h.store, 'P');
    createTask(h.store, { title: '无日期', projectId: p.id });
    createTask(h.store, { title: '码头', scheduledFor: h.today });
    expect(itemsForDay(h.store.data, h.today)).toEqual([]);
  });

  it('昨天未结算的日子排在最前，补上就散雾', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, 'P');
    createTask(h.store, { title: 'x', projectId: p.id, scheduledFor: '2026-10-01' });
    createTask(h.store, { title: 'y', projectId: p.id, scheduledFor: '2026-10-02' });
    h.setToday('2026-10-03');
    expect(pendingDays(h.store.data, h.today)).toEqual(['2026-10-01', '2026-10-02']);
    settleDay(h.store, '2026-10-01', new Map());
    expect(pendingDays(h.store.data, h.today)).toEqual(['2026-10-02']);
  });

  it('结算之外直接记下做完', () => {
    const h = makeStore();
    const p = createProject(h.store, 'P');
    const t = createTask(h.store, { title: '随手做完', projectId: p.id });
    markTaskDone(h.store, t.id);
    expect(h.store.task(t.id)!.status).toBe('done');
    expect(itemsForDay(h.store.data, h.today).map((i) => i.title)).toEqual(['随手做完']);
  });

  it('关闭项目时放下未完成的任务', () => {
    const h = makeStore();
    const p = createProject(h.store, 'P');
    const t = createTask(h.store, { title: 't', projectId: p.id });
    closeProject(h.store, p.id, '方向变了');
    expect(h.store.task(t.id)!.status).toBe('dropped');
    expect(h.store.project(p.id)).toMatchObject({ status: 'closed', closeReason: '方向变了' });
  });
});

describe('指标', () => {
  it('粮仓 = 工作时段 − 已排时间，没精力会下调', () => {
    const h = makeStore('2026-10-01');
    const at = (hh: number, mm = 0) => new Date(2026, 9, 1, hh, mm).toISOString();
    mergeEvents(h.store, 's', [
      { id: 's|1', sourceId: 's', uid: '1', title: '周会', start: at(10), end: at(11), allDay: false, classified: false },
      { id: 's|2', sourceId: 's', uid: '2', title: '评审', start: at(10, 30), end: at(12), allDay: false, classified: false },
      { id: 's|3', sourceId: 's', uid: '3', title: '晚饭', start: at(19), end: at(20), allDay: false, classified: false },
    ], '2026-09-01');
    let g = granary(h.store.data, h.today);
    expect(g.workHours).toBe(9);
    expect(g.scheduledHours).toBe(2);
    expect(g.available).toBe(7);
    const p = createProject(h.store, 'P');
    const t = createTask(h.store, { title: 't', projectId: p.id, scheduledFor: h.today });
    settleDay(h.store, h.today, new Map([[itemKey('task', t.id), { outcome: 'skipped', reason: 'no_energy' }]]));
    g = granary(h.store.data, h.today);
    expect(g.noEnergy).toBe(1);
    expect(g.available).toBeCloseTo(6.3);
  });

  it('推进度、积压、状态', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, 'P');
    const a = createTask(h.store, { title: 'a', projectId: p.id, scheduledFor: h.today });
    const b = createTask(h.store, { title: 'b', projectId: p.id, scheduledFor: h.today });
    const c = createTask(h.store, { title: 'c', projectId: p.id, scheduledFor: h.today });
    createTask(h.store, { title: '码头' });
    settleDay(h.store, h.today, new Map([
      [itemKey('task', a.id), { outcome: 'done' }],
      [itemKey('task', b.id), { outcome: 'partial' }],
      [itemKey('task', c.id), { outcome: 'skipped' }],
    ]));
    expect(progress(h.store.data, h.today).week).toBe(1.5);
    expect(condition(h.store.data, h.today).ratio).toBeCloseTo(2 / 3);
    h.advance(1);
    // c 没做且没改期 → 过期；码头 1 件
    expect(backlog(h.store.data, h.today)).toEqual({ dock: 1, overdue: 1, total: 2 });
  });
});

describe('日历归类', () => {
  it('第一次手动指定并记下规则，之后同类自动归位', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const ev = (id: string, title: string) => ({ id, sourceId: 's', uid: id, title, start: new Date(2026, 9, 1, 10).toISOString(), end: new Date(2026, 9, 1, 11).toISOString(), allDay: false, classified: false });
    mergeEvents(h.store, 's', [ev('1', '产品周会'), ev('2', '牙医')], '2026-09-01');
    classifyEvents(h.store, '产品周会', p.id, '周会');
    classifyEvents(h.store, '牙医', '');
    expect(h.store.data.events.find((e) => e.id === '1')).toMatchObject({ projectId: p.id, classified: true });
    expect(h.store.data.events.find((e) => e.id === '2')).toMatchObject({ projectId: CHORES, classified: true });
    mergeEvents(h.store, 's', [ev('1', '产品周会'), ev('2', '牙医'), ev('3', '设计周会')], '2026-09-01');
    expect(h.store.data.events.find((e) => e.id === '3')).toMatchObject({ projectId: p.id, classified: true });
  });
});

describe('改判', () => {
  it('重新结算时撤销上一次的后果：打断记录、推迟次数、一生之书、最近推进日', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    const k = itemKey('task', t.id);
    const lifeOf = () => h.store.data.life.filter((l) => l.taskId === t.id && ['done', 'partial', 'skip'].includes(l.kind)).map((l) => l.text);

    settleDay(h.store, h.today, new Map([[k, { outcome: 'skipped', reason: 'interrupted' }]]));
    expect(h.store.data.interruptions.length).toBe(1);

    settleDay(h.store, h.today, new Map([[k, { outcome: 'skipped', reason: 'postponed' }]]));
    expect(h.store.data.interruptions.length).toBe(0);
    expect(h.store.task(t.id)).toMatchObject({ postponeCount: 1, scheduledFor: '2026-10-02' });
    expect(lifeOf()).toEqual(['「写周报」没做：推到明天']);

    settleDay(h.store, h.today, new Map([[k, { outcome: 'done' }]]));
    expect(h.store.task(t.id)).toMatchObject({ status: 'done', postponeCount: 0 });
    expect(h.store.project(p.id)!.lastProgressAt).toBe(h.today);
    expect(lifeOf()).toEqual(['完成了「写周报」']);

    settleDay(h.store, h.today, new Map([[k, { outcome: 'skipped', reason: 'no_energy' }]]));
    expect(h.store.project(p.id)!.lastProgressAt).toBeUndefined();
    expect(h.store.task(t.id)).toMatchObject({ status: 'open', scheduledFor: h.today });

    // 取消决定：记录和后果一起撤掉
    settleDay(h.store, h.today, new Map());
    expect(h.store.data.entries).toEqual([]);
    expect(lifeOf()).toEqual([]);
    expect(h.store.task(t.id)).toMatchObject({ status: 'open', scheduledFor: h.today, postponeCount: 0 });
  });
});

describe('积压走势', () => {
  it('来自每天的快照：今天安排了码头的船，不会改写过去几天的点', () => {
    const h = makeStore('2026-10-01');
    const p = createProject(h.store, 'P');
    const ships = [createTask(h.store, { title: 'a' }), createTask(h.store, { title: 'b' }), createTask(h.store, { title: 'c' })];
    recordBacklogSnapshot(h.store);
    h.advance();
    recordBacklogSnapshot(h.store);
    h.advance();
    for (const t of ships) arrangeTask(h.store, t.id, p.id);
    recordBacklogSnapshot(h.store);
    expect(backlogSeries(h.store.data, h.today)).toEqual([3, 3, 0]);
    // 中间缺了快照的日子沿用前一天
    h.advance(2);
    createTask(h.store, { title: 'd' });
    expect(backlogSeries(h.store.data, h.today)).toEqual([3, 3, 0, 0, 1]);
  });
});
