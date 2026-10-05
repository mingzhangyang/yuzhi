import { tileHash } from '../map';
import { hash } from './utils';

export const SKIN = ['#f1c9a5', '#e6b48c', '#d9a074', '#c98d62'];
export const HAIR = ['#2f2620', '#4a3426', '#1f1c1a', '#6b4a2e', '#3b2f2a'];
export const SNOW = '#f3f6f8';
export const BEACH = '#e9d9ae';
export const SNOW_SHADE = '#d6e0e8';
export const WARM = '255,206,110';
export const LANTERN = '255,120,70';
export const FIREWORK = ['#ffd36b', '#ff7a6b', '#8fd3ff', '#c99bff', '#9dff9b', '#ffffff', '#ffb3d9'];

/** 村落房屋相对地块宽度的比例。 */
export const HOUSE_SCALE = 0.42;

/** 小人的绘制尺寸：约为地块宽的 0.15，手机上不小于 4px，身高大致与屋檐齐平。 */
export function personSize(tw: number): number {
  return Math.max(4, tw * 0.15);
}

/** 0 四坡顶 · 1 双坡顶 · 2 两层 · 3 带披屋 */
export type HouseVariant = 0 | 1 | 2 | 3;

/**
 * 同一村落里逐户取值。hash(projectId + slotIdx) 只改了末位字符，FNV 的结果几乎不变，
 * 一个村子的房子会全是同一种样式、同时亮灯或同时熄灯；这里再用地块哈希把户号充分打散。
 */
export function houseHash(projectId: string, slot: number, salt: number): number {
  return tileHash(slot, Math.floor(hash(projectId) * 1e6), 200 + salt);
}

/** 房屋样式：四坡顶居多，夹几座双坡顶、两层和带披屋的 */
export function houseVariant(projectId: string, slot: number): HouseVariant {
  const r = houseHash(projectId, slot, 1);
  return r < 0.42 ? 0 : r < 0.72 ? 1 : r < 0.87 ? 2 : 3;
}

/**
 * 松树的分层：[底边高, 顶点高, 半宽]，单位是树的尺寸 s。层数、宽窄和高矮随树而变：有的瘦高，有的矮胖。
 * drawTree 和 treeOutline 共用，画出来的和挡人的轮廓一致。
 */
export function pineTiers(seed: number): [number, number, number][] {
  const r1 = (seed * 7.13) % 1;
  const r2 = (seed * 3.71) % 1;
  const fat = 0.85 + r1 * 0.35;
  const tall = 0.9 + r2 * 0.25;
  if (r2 < 0.3) {
    return [
      [0.2, 0.72 * tall, 0.38 * fat],
      [0.55, 1.18 * tall, 0.25 * fat],
    ];
  }
  if (r2 > 0.8) {
    return [
      [0.16, 0.52 * tall, 0.36 * fat],
      [0.38, 0.78 * tall, 0.3 * fat],
      [0.6, 1.04 * tall, 0.23 * fat],
      [0.84, 1.36 * tall, 0.15 * fat],
    ];
  }
  return [
    [0.18, 0.62 * tall, 0.36 * fat],
    [0.46, 0.92 * tall, 0.28 * fat],
    [0.72, 1.28 * tall, 0.2 * fat],
  ];
}

/** 阔叶树冠的叶团：[横向偏移, 纵向偏移, 半径]，相对树冠中心、单位 s；数量、位置和大小随树而变，轮廓不对称 */
export function roundLobes(seed: number): [number, number, number][] {
  const lobes: [number, number, number][] = [];
  const n = 3 + Math.floor(((seed * 5.3) % 1) * 3);
  const lean = (((seed * 9.7) % 1) - 0.5) * 0.12;
  for (let k = 0; k < n; k++) {
    const q = (seed * (13.1 + k * 7.7)) % 1;
    const ang = (k / n) * Math.PI * 2 + q * 1.1;
    const d = 0.1 + q * 0.08;
    lobes.push([Math.cos(ang) * d * 1.25 + lean, Math.sin(ang) * d * 0.9 - 0.02, 0.19 + ((seed * (5.9 + k * 3.3)) % 1) * 0.1]);
  }
  lobes.push([lean * 0.5, -0.1, 0.24]);
  return lobes;
}

/**
 * 树在屏幕上的外框（单位：树的尺寸 s）：半宽 w、树冠顶高 top。与 drawTree / treeOutline 同一份几何，
 * 点树看说明和键盘浏览的落点都用它，高瘦的四层松树树尖也能点到。
 */
export function treeBounds(kind: 'pine' | 'round', seed: number): { w: number; top: number } {
  if (kind === 'pine') {
    const tiers = pineTiers(seed);
    return { w: Math.max(...tiers.map(([, , w]) => w)), top: Math.max(...tiers.map(([, top]) => top)) };
  }
  const lobes = roundLobes(seed);
  return { w: Math.max(...lobes.map(([dx, , r]) => Math.abs(dx) + r)), top: 0.66 + Math.max(...lobes.map(([, dy, r]) => r - dy)) };
}

/** 地标样式，顺序与 docs/art/landmark-concepts.webp 一致；前三种是最早的钟楼、藏书阁、风车 */
export const LANDMARK_KINDS = ['clock', 'library', 'windmill', 'observatory', 'greenhouse', 'harbor', 'memorial', 'pavilion'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

/**
 * 按地标位轮换：前八座地标一定各不相同。0–2 号仍是钟楼、藏书阁、风车，
 * 已经建成的前三座地标外观不变。
 */
export function landmarkKind(index: number): LandmarkKind {
  const n = LANDMARK_KINDS.length;
  return LANDMARK_KINDS[((index % n) + n) % n];
}

/**
 * 各样式楼体的最高点（地块宽的倍数，再乘规模 sc），绘制和遮挡 / 点击轮廓共用：
 * 钟楼到攒尖顶尖，风车到尖顶，观星台到望远镜口，纪念塔到火焰顶。
 */
export const LANDMARK_HEIGHT: Record<LandmarkKind, number> = {
  clock: 1.33,
  library: 0.86,
  windmill: 0.98,
  observatory: 0.68,
  greenhouse: 0.6,
  harbor: 0.56,
  memorial: 1.0,
  pavilion: 0.66,
};
