import { describe, expect, it } from 'vitest';
import { agendaAt, woodpileStep } from '../src/logic/agenda';
import { createProject } from '../src/actions';
import { CHORES } from '../src/types';
import { makeStore } from './helpers';

const stamp = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();

describe('此刻层 agendaAt', () => {
  it('按进行中、即将开始、稍后和待结算划分已归类日程', () => {
    const h = makeStore('2026-10-04');
    const p = createProject(h.store, '团队');
    h.store.data.events.push(
      { id: 'live', sourceId: 's', uid: 'live', title: '周会', start: stamp('2026-10-04', 14), end: stamp('2026-10-04', 15), allDay: false, projectId: p.id, classified: true },
      { id: 'soon', sourceId: 's', uid: 'soon', title: '评审', start: stamp('2026-10-04', 14, 40), end: stamp('2026-10-04', 15, 30), allDay: false, projectId: p.id, classified: true },
      { id: 'later', sourceId: 's', uid: 'later', title: '回顾', start: stamp('2026-10-04', 17), end: stamp('2026-10-04', 18), allDay: false, projectId: p.id, classified: true },
      { id: 'ended', sourceId: 's', uid: 'ended', title: '站会', start: stamp('2026-10-04', 9), end: stamp('2026-10-04', 10), allDay: false, projectId: p.id, classified: true },
    );

    const result = agendaAt(h.store.data, new Date('2026-10-04T14:30:00'));
    const slot = result.slots.get(p.id)!;
    expect(slot.live.map((x) => x.title)).toEqual(['周会']);
    expect(slot.soon.map((x) => x.title)).toEqual(['评审']);
    expect(slot.later).toBe(1);
    expect(slot.ended).toBe(1);
    expect(result.nextChange?.getTime()).toBe(new Date('2026-10-04T14:40:00').getTime());
  });

  it('跨午夜按真实区间显示进行中，全天事件只进入条幅层', () => {
    const h = makeStore('2026-10-04');
    const p = createProject(h.store, '夜航');
    h.store.data.events.push(
      { id: 'overnight', sourceId: 's', uid: 'overnight', title: '跨夜值守', start: stamp('2026-10-03', 23), end: stamp('2026-10-04', 1), allDay: false, projectId: p.id, classified: true },
      { id: 'trip', sourceId: 's', uid: 'trip', title: '出差', start: stamp('2026-10-03', 0), end: stamp('2026-10-06', 0), allDay: true, projectId: p.id, classified: true },
      { id: 'chores-day', sourceId: 's', uid: 'chores-day', title: '生日', start: stamp('2026-10-04', 0), end: stamp('2026-10-05', 0), allDay: true, projectId: CHORES, classified: true },
      { id: 'unknown', sourceId: 's', uid: 'unknown', title: '未命名会面', start: stamp('2026-10-05', 10), end: stamp('2026-10-05', 11), allDay: false, classified: false },
    );

    const result = agendaAt(h.store.data, new Date('2026-10-04T00:30:00'));
    expect(result.slots.get(p.id)?.live[0].title).toBe('跨夜值守');
    expect(result.slots.get(p.id)?.banners).toEqual(['出差']);
    expect(result.lighthouseBanners).toEqual(['生日']);
    expect(result.drifting).toEqual(['未命名会面']);
  });

  it('结算后的事件不再出现在此刻层，且不会改变输入', () => {
    const h = makeStore('2026-10-04');
    const p = createProject(h.store, '已确认');
    h.store.data.events.push({ id: 'done', sourceId: 's', uid: 'done', title: '已确认会议', start: stamp('2026-10-04', 9), end: stamp('2026-10-04', 10), allDay: false, projectId: p.id, classified: true });
    h.store.data.entries.push({ id: '2026-10-04|event|done', seq: 1, date: '2026-10-04', itemType: 'event', itemId: 'done', outcome: 'done', projectId: p.id, title: '已确认会议' });
    const before = JSON.stringify(h.store.data);
    const result = agendaAt(h.store.data, new Date('2026-10-04T10:30:00'));
    expect(result.slots.get(p.id)?.ended ?? 0).toBe(0);
    expect(JSON.stringify(h.store.data)).toBe(before);
  });

  it('只把今天结算成做了 / 做了一部分的日程计入 fired', () => {
    const h = makeStore('2026-10-04');
    const p = createProject(h.store, '烧窑');
    const entry = (id: string, outcome: 'done' | 'partial' | 'skipped', date = '2026-10-04') =>
      ({ id: `${date}|event|${id}`, seq: 1, date, itemType: 'event' as const, itemId: id, outcome, projectId: p.id, title: id });
    h.store.data.entries.push(entry('a', 'done'), entry('b', 'partial'), entry('c', 'skipped'), entry('d', 'done', '2026-10-03'));
    const result = agendaAt(h.store.data, new Date('2026-10-04T20:00:00'));
    expect(result.fired.get(p.id)).toBe(2);
  });
});

describe('漂流瓶范围', () => {
  it('已归档或已结算的过去日子不再漂瓶子，等结算的过去日子和今天以后照常漂', () => {
    const h = makeStore('2026-10-04');
    const ev = (id: string, title: string, day: string) =>
      ({ id, sourceId: 's', uid: id, title, start: stamp(day, 10), end: stamp(day, 11), allDay: false, classified: false });
    h.store.data.events.push(ev('a', '归档那天', '2026-09-20'), ev('b', '结算那天', '2026-10-02'), ev('c', '还没结算', '2026-10-03'), ev('d', '明天', '2026-10-05'));
    h.store.data.days.push({ date: '2026-09-20', status: 'unrecorded' }, { date: '2026-10-02', status: 'settled' });
    const result = agendaAt(h.store.data, new Date('2026-10-04T10:00:00'));
    expect(result.drifting.sort()).toEqual(['明天', '还没结算'].sort());
  });
});

describe('柴堆档位', () => {
  it('按 0 / 1–3 / 4–8 / 9+ 分档', () => {
    expect([0, 1, 3, 4, 8, 9, 20].map(woodpileStep)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});
