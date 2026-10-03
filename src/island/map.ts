/**
 * 小岛的地形：沿用禾境的等距地块生成方式，固定随机种子，每次打开都是同一座岛。
 * 中心一圈是村落槽位，山顶是灯塔（档案馆），南岸是码头。
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
  edge: boolean;
}

export interface VillageSite {
  index: number;
  center: Tile;
  /** 由近到远的房屋位 */
  slots: Tile[];
}

export interface IslandMap {
  N: number;
  all: Tile[];
  at(i: number, j: number): Tile | null;
  villages: VillageSite[];
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

/** 村落槽位的大致位置：0 号在正中，往外一圈 */
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

export function buildIsland(seed = 20261003): IslandMap {
  const N = 22;
  const r = mulberry32(seed);
  const c = (N - 1) / 2;
  const g: (Tile | null)[][] = [];
  for (let i = 0; i < N; i++) {
    g[i] = [];
    for (let j = 0; j < N; j++) {
      const dx = i - c;
      const dy = j - c;
      const ang = Math.atan2(dy, dx);
      const d = Math.hypot(dx, dy);
      const rm = 9.7 + 0.75 * Math.sin(3 * ang + 1.3) + 0.45 * Math.sin(5 * ang + 0.4) + (r() - 0.5) * 0.7;
      g[i][j] = d < rm ? { i, j, type: 'grass', v: r(), trees: [], village: -1, slotIdx: -1, edge: false } : null;
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
  for (const t of all) t.edge = !at(t.i + 1, t.j) || !at(t.i, t.j + 1) || !at(t.i - 1, t.j) || !at(t.i, t.j - 1);

  // 东北角的山，山顶是灯塔
  for (const t of all) if (dist(t, 17.2, 4.6) < 2.5 + r() * 0.4) t.type = 'mountain';
  const lighthouse = nearest(17.2, 4.6, (t) => t.type === 'mountain');

  // 从山脚流向西南的小溪
  const water: Tile[] = [];
  let ci = 15;
  let cj = 7;
  for (let s = 0; s < 40; s++) {
    const t = at(ci, cj);
    if (!t) break;
    if (t.type !== 'mountain' && t.type !== 'water') {
      t.type = 'water';
      water.push(t);
    }
    const x = r();
    if (x < 0.55) cj++;
    else if (x < 0.85) ci--;
    else ci++;
    if (Math.hypot(ci - 10, cj - 10) < 2.6) ci--; // 绕开正中的村落
  }

  // 南岸码头：离 (13, 21) 最近的岸边地块，栈桥朝 +j 方向伸进海里
  const dock = nearest(13, 21, (t) => t.edge && t.type !== 'water' && t.type !== 'mountain' && !at(t.i, t.j + 1));
  dock.type = 'sand';
  const pierDir: [number, number] = [0, 1];
  const chores = nearest(dock.i - 0.5, dock.j - 2.4, (t) => t.type === 'grass' && !t.edge);
  chores.type = 'plaza';

  // 村落
  const reserved = new Set<Tile>([dock, chores]);
  const villages: VillageSite[] = [];
  for (let k = 0; k < MAX_VILLAGES; k++) {
    const [ti, tj] = VILLAGE_TARGETS[k];
    const center = nearest(ti, tj, (t) => (t.type === 'grass' || t.type === 'field') && !reserved.has(t) && t.village < 0);
    center.type = 'plaza';
    center.village = k;
    reserved.add(center);
    const slots = all
      .filter((t) => (t.type === 'grass' || t.type === 'sand') && !reserved.has(t) && t.village < 0 && !t.edge && dist(t, center.i, center.j) <= 2.3)
      .sort((a, b) => dist(a, center.i, center.j) - dist(b, center.i, center.j) || a.v - b.v)
      .slice(0, 10);
    slots.forEach((t, idx) => {
      t.village = k;
      t.slotIdx = idx;
      reserved.add(t);
    });
    villages.push({ index: k, center, slots });
  }

  const granary = nearest(12.6, 13.2, (t) => t.type === 'grass' && !reserved.has(t) && !t.edge);
  reserved.add(granary);

  // 码头附近一圈沙滩
  for (const t of all) if (t.edge && t.type === 'grass' && dist(t, dock.i, dock.j) < 3.2 && !reserved.has(t)) t.type = 'sand';

  // 树林：离村落远一些
  const FS: [number, number, number, 'pine' | 'round'][] = [
    [3, 10.5, 2, 'pine'],
    [13, 2.6, 1.8, 'pine'],
    [18.5, 9.5, 1.8, 'round'],
    [16.5, 17, 1.6, 'round'],
    [7.5, 18.5, 1.5, 'pine'],
    [2.8, 4.2, 1.3, 'round'],
  ];
  const nearVillage = (t: Tile) => villages.some((v) => dist(t, v.center.i, v.center.j) < 2.6);
  for (const t of all) {
    if (t.type !== 'grass' || reserved.has(t) || nearVillage(t)) continue;
    for (const f of FS) {
      if (dist(t, f[0], f[1]) < f[2] && r() < 0.85) {
        t.type = 'forest';
        const n = 2 + (r() < 0.5 ? 1 : 0);
        for (let k = 0; k < n; k++) t.trees.push({ dx: (r() - 0.5) * 0.55, dy: (r() - 0.5) * 0.55, s: 0.75 + r() * 0.45, kind: f[3] });
        break;
      }
    }
    if (t.type === 'grass' && r() < 0.07) t.trees.push({ dx: (r() - 0.5) * 0.4, dy: (r() - 0.5) * 0.4, s: 0.7 + r() * 0.4, kind: r() < 0.5 ? 'pine' : 'round' });
  }
  // 小溪边几块田
  for (const t of all) if (t.type === 'grass' && !reserved.has(t) && !nearVillage(t) && water.some((w) => dist(t, w.i, w.j) < 1.2) && r() < 0.45) t.type = 'field';
  for (const t of all) t.trees.sort((a, b) => a.dx + a.dy - (b.dx + b.dy));

  all.sort((a, b) => a.i + a.j - (b.i + b.j) || a.i - b.i);
  return { N, all, at, villages, dock, pierDir, pierLen: 3, chores, granary, lighthouse, water };
}
