/**
 * 小岛的地形：沿用禾境的等距地块生成方式。
 * 每个地块的随机数都由坐标哈希得到，所以岛向外长出新陆地（年轮）时，
 * 原有的地形、村落位置和地标位置都不会变。
 * 中心一圈是村落槽位，山顶是灯塔（档案馆），南岸是码头，海岸一圈圈是地标。
 */
import { MAX_VILLAGES } from '../logic/config';

export type TileType = 'grass' | 'forest' | 'field' | 'water' | 'mountain' | 'plaza' | 'sand';

export interface Tree {
  dx: number;
  dy: number;
  s: number;
  kind: 'pine' | 'round';
}

export interface Tile {
  i: number;
  j: number;
  type: TileType;
  /** 0–1 的随机明暗 */
  v: number;
  trees: Tree[];
  /** 属于第几个村落的房屋位（-1 表示不是） */
  village: number;
  /** 在村落房屋位里的序号 */
  slotIdx: number;
  /** 在当前海岸线上 */
  edge: boolean;
  /** 属于第几圈年轮（0 是最初的岛） */
  ring: number;
  /** 第几号地标位（-1 表示不是） */
  landmark: number;
}

export interface VillageSite {
  index: number;
  center: Tile;
  /** 由近到远的房屋位 */
  slots: Tile[];
}

export interface IslandMap {
  N: number;
  rings: number;
  /** 岛的大致半径（格），用于缩放 */
  radius: number;
  all: Tile[];
  at(i: number, j: number): Tile | null;
  villages: VillageSite[];
  /** 地标位：按编号排列，跨越所有已长出的年轮 */
  landmarks: Tile[];
  /** 码头所在的岸边地块，以及栈桥伸出的方向 */
  dock: Tile;
  pierDir: [number, number];
  pierLen: number;
  chores: Tile;
  granary: Tile;
  lighthouse: Tile;
  water: Tile[];
}

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 坐标 + 用途 → 0–1 的稳定随机数 */
export function tileHash(i: number, j: number, salt: number): number {
  let h = Math.imul(i + 1013, 73856093) ^ Math.imul(j + 7919, 19349663) ^ Math.imul(salt + 31, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 网格足够大，容得下最多 MAX_RINGS 圈年轮 */
export const N = 34;
const C = (N - 1) / 2;
/** 旧坐标系（禾境式 22 格的岛，中心 10.5）到现在网格的偏移 */
const O = C - 10.5;
export const BASE_RADIUS = 10.5;
export const RING_WIDTH = 1.5;
export const MAX_RINGS = 4;

/** 每圈年轮能容纳的地标数 */
export const ringCapacity = (k: number) => 8 + 4 * k;

/** 第 idx 号地标位在第几圈 */
export function ringOfLandmark(idx: number): number {
  let k = 0;
  let acc = ringCapacity(0);
  while (idx >= acc && k < MAX_RINGS) {
    k++;
    acc += ringCapacity(k);
  }
  return k;
}

export function totalLandmarkCapacity(): number {
  let n = 0;
  for (let k = 0; k <= MAX_RINGS; k++) n += ringCapacity(k);
  return n;
}

function inside(i: number, j: number, k: number): boolean {
  const dx = i - C;
  const dy = j - C;
  const ang = Math.atan2(dy, dx);
  const rm = 9.7 + 0.75 * Math.sin(3 * ang + 1.3) + 0.45 * Math.sin(5 * ang + 0.4) + (tileHash(i, j, 1) - 0.5) * 0.7 + k * RING_WIDTH;
  return Math.hypot(dx, dy) < rm;
}

/** 村落槽位的大致位置（旧坐标系）：0 号在正中，往外一圈 */
const VILLAGE_TARGETS: [number, number][] = [
  [10, 10],
  [6.2, 12.6],
  [12.6, 6.2],
  [14.6, 11.6],
  [10.4, 15.2],
  [5.6, 7.4],
  [8.6, 4.4],
  [4.6, 16],
];

const cache = new Map<number, IslandMap>();

export function buildIsland(rings = 0): IslandMap {
  rings = Math.max(0, Math.min(MAX_RINGS, Math.floor(rings)));
  const hit = cache.get(rings);
  if (hit) return hit;

  const g: (Tile | null)[][] = [];
  for (let i = 0; i < N; i++) {
    g[i] = [];
    for (let j = 0; j < N; j++) {
      if (!inside(i, j, rings)) {
        g[i][j] = null;
        continue;
      }
      let ring = 0;
      while (ring < rings && !inside(i, j, ring)) ring++;
      g[i][j] = { i, j, type: 'grass', v: tileHash(i, j, 2), trees: [], village: -1, slotIdx: -1, edge: false, ring, landmark: -1 };
    }
  }
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < N && j < N ? g[i][j] : null);
  const all: Tile[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (g[i][j]) all.push(g[i][j]!);
  const dist = (t: Tile, i: number, j: number) => Math.hypot(t.i - i, t.j - j);
  const nearest = (i: number, j: number, ok: (t: Tile) => boolean) => {
    let best: Tile | null = null;
    let bd = 1e9;
    for (const t of all) {
      if (!ok(t)) continue;
      const dd = dist(t, i, j);
      if (dd < bd) {
        bd = dd;
        best = t;
      }
    }
    return best!;
  };
  const coastOf = (t: Tile, k: number) => inside(t.i, t.j, k) && (!inside(t.i + 1, t.j, k) || !inside(t.i, t.j + 1, k) || !inside(t.i - 1, t.j, k) || !inside(t.i, t.j - 1, k));
  for (const t of all) t.edge = !at(t.i + 1, t.j) || !at(t.i, t.j + 1) || !at(t.i - 1, t.j) || !at(t.i, t.j - 1);
  const base = (t: Tile) => t.ring === 0;
  const edge0 = (t: Tile) => base(t) && coastOf(t, 0);

  // 东北角的山，山顶是灯塔（只在最初的岛上）
  for (const t of all) if (base(t) && dist(t, 17.2 + O, 4.6 + O) < 2.5 + tileHash(t.i, t.j, 3) * 0.4) t.type = 'mountain';
  const lighthouse = nearest(17.2 + O, 4.6 + O, (t) => t.type === 'mountain');

  // 从山脚流向西南的小溪（只在最初的岛上）
  const water: Tile[] = [];
  {
    const r = mulberry32(20261003);
    let ci = 15 + O;
    let cj = 7 + O;
    for (let s = 0; s < 40; s++) {
      const t = at(ci, cj);
      if (!t || !base(t)) break;
      if (t.type !== 'mountain' && t.type !== 'water') {
        t.type = 'water';
        water.push(t);
      }
      const x = r();
      if (x < 0.55) cj++;
      else if (x < 0.85) ci--;
      else ci++;
      if (Math.hypot(ci - (10 + O), cj - (10 + O)) < 2.6) ci--; // 绕开正中的村落
    }
  }

  // 最初的码头位置决定杂务小屋；之后码头随海岸外移
  const dockOk = (k: number) => (t: Tile) => coastOf(t, k) && !inside(t.i, t.j + 1, k) && t.type !== 'water' && t.type !== 'mountain';
  const dock0 = nearest(13 + O, 21 + O, (t) => base(t) && dockOk(0)(t));
  const chores = nearest(dock0.i - 0.5, dock0.j - 2.4, (t) => base(t) && t.type === 'grass' && !edge0(t));
  chores.type = 'plaza';
  const dockAng = Math.atan2(dock0.j - C, dock0.i - C);

  // 村落
  const reserved = new Set<Tile>([dock0, chores]);
  const villages: VillageSite[] = [];
  for (let k = 0; k < MAX_VILLAGES; k++) {
    const [ti, tj] = VILLAGE_TARGETS[k];
    const center = nearest(ti + O, tj + O, (t) => base(t) && t.type === 'grass' && !reserved.has(t) && t.village < 0);
    center.type = 'plaza';
    center.village = k;
    reserved.add(center);
    const slots = all
      .filter((t) => base(t) && t.type === 'grass' && !reserved.has(t) && t.village < 0 && !edge0(t) && dist(t, center.i, center.j) <= 2.3)
      .sort((a, b) => dist(a, center.i, center.j) - dist(b, center.i, center.j) || a.v - b.v)
      .slice(0, 10);
    slots.forEach((t, idx) => {
      t.village = k;
      t.slotIdx = idx;
      reserved.add(t);
    });
    villages.push({ index: k, center, slots });
  }
  const granary = nearest(12.6 + O, 13.2 + O, (t) => base(t) && t.type === 'grass' && !reserved.has(t) && !edge0(t));
  reserved.add(granary);

  // 地标位：每圈年轮的海岸上均匀分布，从正对观者的南岸开始，避开码头航道和山
  const landmarks: Tile[] = [];
  const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (let k = 0; k <= rings; k++) {
    const cands = all.filter(
      (t) =>
        t.ring <= k &&
        coastOf(t, k) &&
        t.type !== 'mountain' &&
        t.type !== 'water' &&
        !reserved.has(t) &&
        dist(t, 17.2 + O, 4.6 + O) > 4.2 &&
        angDiff(Math.atan2(t.j - C, t.i - C), dockAng) > 0.32,
    );
    const cap = ringCapacity(k);
    const taken = new Set<Tile>();
    const a0 = Math.PI / 4 + (k % 2 ? Math.PI / cap : 0);
    for (let s = 0; s < cap; s++) {
      // 0、1、2… 依次落在 南、北、东、西… 交错展开，让前几座地标就分散开
      const step = s % 2 === 0 ? s / 2 : cap - (s + 1) / 2;
      const target = a0 + (2 * Math.PI * step) / cap;
      let best: Tile | null = null;
      let bd = 1e9;
      for (const t of cands) {
        if (taken.has(t)) continue;
        const d = angDiff(Math.atan2(t.j - C, t.i - C), target);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (!best) break;
      taken.add(best);
      best.landmark = landmarks.length;
      reserved.add(best);
      landmarks.push(best);
    }
  }

  // 现在的码头
  const dock = rings === 0 ? dock0 : nearest(13 + O, 21 + O + rings * RING_WIDTH, (t) => dockOk(rings)(t) && t.landmark < 0);
  dock.type = 'sand';
  reserved.add(dock);

  // 码头附近一圈沙滩
  for (const t of all) if (t.edge && t.type === 'grass' && dist(t, dock.i, dock.j) < 3.2 && !reserved.has(t)) t.type = 'sand';

  // 树林：离村落远一些；新长出的年轮上零星有树
  const FS: [number, number, number, 'pine' | 'round'][] = [
    [3, 10.5, 2, 'pine'],
    [13, 2.6, 1.8, 'pine'],
    [18.5, 9.5, 1.8, 'round'],
    [16.5, 17, 1.6, 'round'],
    [7.5, 18.5, 1.5, 'pine'],
    [2.8, 4.2, 1.3, 'round'],
  ];
  const nearVillage = (t: Tile) => villages.some((v) => dist(t, v.center.i, v.center.j) < 2.6);
  const addTrees = (t: Tile, n: number, kind: 'pine' | 'round', spread: number) => {
    for (let k = 0; k < n; k++)
      t.trees.push({ dx: (tileHash(t.i, t.j, 10 + k) - 0.5) * spread, dy: (tileHash(t.i, t.j, 20 + k) - 0.5) * spread, s: 0.75 + tileHash(t.i, t.j, 30 + k) * 0.45, kind });
  };
  for (const t of all) {
    if (t.type !== 'grass' || reserved.has(t) || nearVillage(t)) continue;
    if (base(t)) {
      for (const f of FS) {
        if (dist(t, f[0] + O, f[1] + O) < f[2] && tileHash(t.i, t.j, 4) < 0.85) {
          t.type = 'forest';
          addTrees(t, 2 + (tileHash(t.i, t.j, 5) < 0.5 ? 1 : 0), f[3], 0.55);
          break;
        }
      }
      if (t.type === 'grass' && tileHash(t.i, t.j, 6) < 0.07) addTrees(t, 1, tileHash(t.i, t.j, 7) < 0.5 ? 'pine' : 'round', 0.4);
    } else if (!t.edge && tileHash(t.i, t.j, 8) < 0.12) addTrees(t, 1, tileHash(t.i, t.j, 7) < 0.5 ? 'pine' : 'round', 0.4);
  }
  // 小溪边几块田
  for (const t of all) if (base(t) && t.type === 'grass' && !reserved.has(t) && !nearVillage(t) && water.some((w) => dist(t, w.i, w.j) < 1.2) && tileHash(t.i, t.j, 9) < 0.45) t.type = 'field';
  for (const t of all) t.trees.sort((a, b) => a.dx + a.dy - (b.dx + b.dy));

  all.sort((a, b) => a.i + a.j - (b.i + b.j) || a.i - b.i);
  const m: IslandMap = { N, rings, radius: BASE_RADIUS + rings * RING_WIDTH, all, at, villages, landmarks, dock, pierDir: [0, 1], pierLen: 3, chores, granary, lighthouse, water };
  cache.set(rings, m);
  return m;
}
