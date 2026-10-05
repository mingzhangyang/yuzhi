import { describe, expect, it } from 'vitest';
import { buildIsland, MAX_RINGS } from '../src/island/map';
import { islandProps, PROP_SNOW_LIMIT, propOutline, type PropVillage } from '../src/island/render/props-layout';
import { PROP_SPRITES } from '../src/island/prop-sprites';

const villages: PropVillage[] = [
  { slot: 0, projectId: 'p-write', stage: 0, houses: 6 },
  { slot: 1, projectId: 'p-garden', stage: 1, houses: 4 },
  { slot: 2, projectId: 'p-move', stage: 0, houses: 10 },
  { slot: 3, projectId: 'p-piano', stage: 2, houses: 2 },
  { slot: 4, projectId: 'p-old', stage: 3, houses: 5 },
];
/** 只看村落里的道具：码头那几件在沙滩上，排在最前面 */
const villageProps = (m: ReturnType<typeof buildIsland>, vs: PropVillage[]) => islandProps(m, vs, 0).slice(islandProps(m, [], 0).length);
const tileOf = (p: { i: number; j: number }) => `${Math.round(p.i)},${Math.round(p.j)}`;

describe('小岛道具摆放', () => {
  it('同样的地图和村落，每次摆得一样（不用随机数）', () => {
    const m = buildIsland(0);
    const a = islandProps(m, villages, 0);
    const random = Math.random;
    Math.random = () => 0.999;
    try {
      expect(islandProps(m, villages, 0)).toEqual(a);
    } finally {
      Math.random = random;
    }
  });

  it('积雪时整批不摆：现有贴图都是春夏的样子', () => {
    const m = buildIsland(0);
    expect(islandProps(m, villages, PROP_SNOW_LIMIT + 0.01)).toEqual([]);
    expect(islandProps(m, villages, PROP_SNOW_LIMIT).length).toBeGreaterThan(0);
  });

  it('不压在房子、地标、树上，也不占告示牌所在的广场左后方', () => {
    for (const rings of [0, MAX_RINGS]) {
      const m = buildIsland(rings);
      const built = new Set<string>();
      for (const v of villages) for (const t of m.villages[v.slot].slots.slice(0, v.houses)) built.add(`${t.i},${t.j}`);
      const props = villageProps(m, villages);
      for (const p of props) {
        const t = m.at(Math.round(p.i), Math.round(p.j))!;
        expect(t).toBeTruthy();
        expect(t.type === 'grass' || t.type === 'plaza').toBe(true);
        expect(t.landmark).toBe(-1);
        expect(t.trees.length).toBe(0);
        // 院落道具落在自家地块的一角；广场道具落在旁边空地的正中，都不和别家房子同格
        if (Math.abs(p.i - t.i) < 0.01) expect(built.has(tileOf(p))).toBe(false);
      }
      for (const v of villages) {
        const c = m.villages[v.slot].center;
        for (const p of props) {
          const di = p.i - c.i;
          const dj = p.j - c.j;
          expect(di < -0.3 && dj < -0.3 && di > -1.5 && dj > -1.5).toBe(false);
        }
      }
    }
  });

  it('保留开阔空间：每座村落最多两件广场道具、三件院落道具，荒废的村子不摆', () => {
    const m = buildIsland(0);
    const props = villageProps(m, villages);
    expect(props.length).toBeGreaterThan(0);
    expect(props.length).toBeLessThanOrEqual(villages.length * 5);
    expect(villageProps(m, [villages[4]])).toEqual([]);
    expect(new Set(props.map((p) => `${p.i},${p.j}`)).size).toBe(props.length);
  });

  it('遮挡轮廓落在贴图外框之内', () => {
    for (const id of Object.keys(PROP_SPRITES) as (keyof typeof PROP_SPRITES)[]) {
      const w = 40;
      const h = w * (PROP_SPRITES[id].h / PROP_SPRITES[id].w);
      for (const [x, y] of propOutline(id, 100, 200, w)) {
        expect(Math.abs(x - 100)).toBeLessThanOrEqual(w / 2);
        expect(y).toBeLessThanOrEqual(200);
        expect(y).toBeGreaterThanOrEqual(200 - h);
      }
    }
  });
});
