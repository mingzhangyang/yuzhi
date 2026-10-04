import { describe, expect, it } from 'vitest';
import { buildScene } from '../src/ui/scene';
import { makeStore } from './helpers';
import { createProject, settleDay } from '../src/actions';
import { CHORES } from '../src/types';
import { itemKey } from '../src/logic/days';

describe('scene time snapshot', () => {
  it('derives date, light and hour from one clock reading', () => {
    const { store } = makeStore();
    let calls = 0;
    store.clock = () => {
      calls++;
      return calls === 1
        ? new Date(2026, 9, 4, 23, 59, 30)
        : new Date(2026, 9, 5, 0, 0, 30);
    };

    const scene = buildScene(store, null, false);

    expect(calls).toBe(1);
    expect(scene.date).toBe('2026-10-04');
    expect(scene.season).toBe(2);
    expect(scene.light).toBe('night');
    expect(scene.hour).toBeCloseTo(23 + 59 / 60, 6);
  });

  it('uses a supplied snapshot without rereading the clock', () => {
    const { store } = makeStore();
    store.clock = () => { throw new Error('buildScene should use the supplied snapshot'); };
    const now = new Date(2026, 9, 5, 6, 15, 0);

    const scene = buildScene(store, null, false, now);

    expect(scene.date).toBe('2026-10-05');
    expect(scene.light).toBe('day');
    expect(scene.hour).toBe(6.25);
  });
});

describe('scene agenda projection', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 4, h, m).toISOString();

  it('carries the exact timestamp for bell cooldowns', () => {
    const { store } = makeStore('2026-10-04');
    const now = new Date(2026, 9, 4, 14, 0, 59, 250);
    expect(buildScene(store, null, false, now).now).toBe(now.getTime());
  });

  it('counts only done / partial chores toward the woodpile', () => {
    const { store } = makeStore('2026-10-04');
    const e = (id: string, outcome: 'done' | 'partial' | 'skipped') =>
      ({ id: `2026-10-04|event|${id}`, seq: 1, date: '2026-10-04', itemType: 'event' as const, itemId: id, outcome, projectId: CHORES, title: id });
    store.data.entries.push(e('a', 'done'), e('b', 'partial'), e('c', 'skipped'), e('d', 'skipped'), e('f', 'skipped'), e('g', 'skipped'));
    const scene = buildScene(store, null, false, new Date(2026, 9, 4, 20));
    expect(scene.chores.count).toBe(2);
    expect(scene.chores.woodpile).toBe(1);
  });

  it('keeps CHORES ownership through the real settlement action', () => {
    const { store } = makeStore('2026-10-04');
    store.data.events.push({
      id: 'real-chore',
      sourceId: 's',
      uid: 'real-chore',
      title: '取快递',
      start: at(9),
      end: at(10),
      allDay: false,
      projectId: CHORES,
      classified: true,
    });

    settleDay(store, '2026-10-04', new Map([[itemKey('event', 'real-chore'), { outcome: 'done' }]]));

    expect(store.data.entries.find((entry) => entry.itemId === 'real-chore')).toMatchObject({
      projectId: CHORES,
      outcome: 'done',
    });
    const scene = buildScene(store, null, false, new Date(2026, 9, 4, 20));
    expect(scene.chores.count).toBe(1);
    expect(scene.chores.woodpile).toBe(1);
  });

  it('keeps a chore in the soon window visible', () => {
    const { store } = makeStore('2026-10-04');
    store.data.events.push({ id: 'c', sourceId: 's', uid: 'c', title: '买菜', start: at(17), end: at(18), allDay: false, projectId: CHORES, classified: true });
    const scene = buildScene(store, null, false, new Date(2026, 9, 4, 16, 50));
    expect(scene.chores.soon?.title).toBe('买菜');
    expect(scene.chores.later).toBe(0);
  });

  it('gives banner-only villages the allday phase, not a timed one', () => {
    const { store } = makeStore('2026-10-04');
    const p = createProject(store, '出行');
    store.data.events.push({ id: 't', sourceId: 's', uid: 't', title: '出差', start: new Date(2026, 9, 3).toISOString(), end: new Date(2026, 9, 6).toISOString(), allDay: true, projectId: p.id, classified: true });
    const v = buildScene(store, null, false, new Date(2026, 9, 4, 10)).villages.find((x) => x.projectId === p.id)!;
    expect(v.agenda?.phase).toBe('allday');
    expect(v.agenda?.later).toBe(0);
  });
});
