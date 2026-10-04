import { describe, expect, it } from 'vitest';
import { diffScene, pickBell, type BellCandidate } from '../src/island/cues';
import type { Scene } from '../src/island/render';

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    season: 2,
    light: 'day',
    date: '2026-10-04',
    hour: 14,
    now: new Date(2026, 9, 4, 14).getTime(),
    villages: [],
    dockShips: 0,
    choresCount: 0,
    chores: { count: 0, woodpile: 0, later: 0, ended: 0 },
    drifting: [],
    lighthouseBanners: [],
    granaryBusy: false,
    granaryRatio: 1,
    granaryLabel: '粮仓 9.0 小时',
    fog: 0,
    selected: null,
    rings: 0,
    landmarks: [],
    ...overrides,
  };
}

describe('场景提示差分', () => {
  it('首次加载和相同场景都不产生提示', () => {
    const s = scene();
    expect(diffScene(null, s)).toEqual([]);
    expect(diffScene(s, s)).toEqual([]);
  });

  it('识别阶段、粮仓、海雾、烧窑和进入 soon', () => {
    const old = scene({
      villages: [{ slot: 0, projectId: 'p', name: '团队', roof: '#a00', stage: 0, houses: 1, walkers: [], extra: 0, openCount: 0, agenda: { phase: 'later', later: 1, ended: 0, banners: [], soon: [] } }],
      granaryRatio: 1,
      fog: 0.8,
    });
    const next = scene({
      villages: [{ slot: 0, projectId: 'p', name: '团队', roof: '#a00', stage: 1, houses: 2, walkers: [], extra: 0, openCount: 0, agenda: { phase: 'soon', later: 0, ended: 0, banners: [], soon: [{ eventId: 'e', title: '周会', start: '2026-10-04T14:10:00.000Z' }] } }],
      granaryRatio: 0.7,
      fog: 0.4,
    });
    expect(diffScene(old, next)).toEqual(expect.arrayContaining([
      { kind: 'house-built', projectId: 'p' },
      { kind: 'stage-changed', projectId: 'p', from: 0, to: 1 },
      { kind: 'granary-changed', from: 1, to: 0.7 },
      { kind: 'fog-changed', from: 0.8, to: 0.4 },
      { kind: 'bell', projectId: 'p', eventId: 'e' },
    ]));
  });

  const village = (o: Partial<Scene['villages'][number]>): Scene['villages'][number] => ({
    slot: 0, projectId: 'p', name: '团队', roof: '#a00', stage: 0, houses: 1, walkers: [], extra: 0, openCount: 0, ...o,
  });

  it('日程结算成做了时产生烧窑提示', () => {
    const old = scene({ villages: [village({ agenda: { phase: 'ended', later: 0, ended: 1, banners: [] }, firedToday: 0 })] });
    const next = scene({ villages: [village({ firedToday: 1 })] });
    expect(diffScene(old, next)).toContainEqual({ kind: 'kiln', projectId: 'p' });
  });

  it('日程结算成没做时砖坯只淡出，不产生烧窑提示', () => {
    const old = scene({ villages: [village({ agenda: { phase: 'ended', later: 0, ended: 1, banners: [] }, firedToday: 0 })] });
    const next = scene({ villages: [village({ firedToday: 0 })] });
    expect(diffScene(old, next).filter((cue) => cue.kind === 'kiln')).toEqual([]);
  });

  it('跨过午夜计数归零时不产生烧窑提示', () => {
    const old = scene({ villages: [village({ firedToday: 0 })] });
    const next = scene({ date: '2026-10-05', villages: [village({ firedToday: 2 })] });
    expect(diffScene(old, next).filter((cue) => cue.kind === 'kiln')).toEqual([]);
  });
});

describe('钟声选择', () => {
  const candidates: BellCandidate[] = [
    { projectId: 'b', eventId: 'b1', start: 100, slot: 1 },
    { projectId: 'a', eventId: 'a1', start: 200, slot: 0 },
  ];

  it('优先选中的村落，再按开始时间和槽位', () => {
    expect(pickBell(candidates, null, 'a', 0)?.eventId).toBe('a1');
    expect(pickBell(candidates, null, null, 0)?.eventId).toBe('b1');
  });

  it('90 秒冷却内不补响', () => {
    expect(pickBell(candidates, 10_000, null, 10_000 + 89_999)).toBeNull();
    expect(pickBell(candidates, 10_000, null, 10_000 + 90_000)?.eventId).toBe('b1');
  });
});
