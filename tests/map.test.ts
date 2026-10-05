import { describe, expect, it } from 'vitest';
import { buildIsland, ringCapacity, ringOfLandmark, MAX_RINGS } from '../src/island/map';

const key = (t: { i: number; j: number }) => `${t.i},${t.j}`;

describe('小岛地形', () => {
  it('每圈年轮都放得下规定数量的地标', () => {
    for (let k = 0; k <= MAX_RINGS; k++) {
      const m = buildIsland(k);
      let need = 0;
      for (let r = 0; r <= k; r++) need += ringCapacity(r);
      expect(m.landmarks.length).toBe(need);
      expect(new Set(m.landmarks.map(key)).size).toBe(need);
    }
  });
  it('岛长出新年轮时，村落、灯塔、粮仓和已有地标的位置不变', () => {
    const a = buildIsland(0);
    for (let k = 1; k <= MAX_RINGS; k++) {
      const b = buildIsland(k);
      expect(b.villages.map((v) => [key(v.center), v.slots.map(key)])).toEqual(a.villages.map((v) => [key(v.center), v.slots.map(key)]));
      expect(key(b.lighthouse)).toBe(key(a.lighthouse));
      expect(key(b.granary)).toBe(key(a.granary));
      expect(key(b.chores)).toBe(key(a.chores));
      expect(Object.fromEntries(Object.entries(b.cultivation).map(([name, site]) => [name, key(site)])))
        .toEqual(Object.fromEntries(Object.entries(a.cultivation).map(([name, site]) => [name, key(site)])));
      expect(b.landmarks.slice(0, a.landmarks.length).map(key)).toEqual(a.landmarks.map(key));
      expect(b.radius).toBeGreaterThan(a.radius);
    }
  });
  it('每个村落都有足够的房屋位，码头在海岸上', () => {
    for (const k of [0, MAX_RINGS]) {
      const m = buildIsland(k);
      for (const v of m.villages) expect(v.slots.length).toBeGreaterThanOrEqual(8);
      expect(m.dock.edge).toBe(true);
      expect(m.at(m.dock.i, m.dock.j + 1)).toBeNull();
    }
  });
  it('四个培育区互不重叠，也不占村落或地标位', () => {
    const m = buildIsland(0);
    const sites = Object.values(m.cultivation);
    expect(new Set(sites.map(key)).size).toBe(4);
    for (const site of sites) {
      expect(site.village).toBe(-1);
      expect(site.landmark).toBe(-1);
    }
  });

  it('地标编号对应年轮', () => {
    expect([0, 7, 8, 19, 20].map(ringOfLandmark)).toEqual([0, 0, 1, 1, 2]);
  });
});
