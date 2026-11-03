/**
 * 「同样的事实，画面怎么画出来」的映射表（美术优化计划 B 期）。
 *
 * 只是纯数据与纯函数：衰败阶段、培育等级、粮仓余量各自对应哪些可见元素。
 * 规则本身（阶段怎么算、等级怎么算、余量怎么算）仍在 src/logic/，这里一条都不改；
 * 绘制代码只读这里的结果，测试守住「每一档都比上一档多 / 少一样看得见的东西」。
 */
import type { Stage } from '../../logic/config';
import type { CultivationKind, CultivationLevel } from '../../logic/cultivation';
import { houseHash } from './style';
import { clamp, hash } from './utils';

/* ================================================================
 * B1 衰败阶段
 * ================================================================ */

export interface DecayLook {
  /** 屋顶保留的饱和度：1 为村色原样，越小越灰 */
  roofSaturation: number;
  /** 屋顶再混进的灰尘（HOUSE.roofDust） */
  roofDust: number;
  /** 冒炊烟的人家比例 */
  smokeShare: number;
  /** 夜里亮灯的人家比例 */
  litShare: number;
  /** 广场石板边缘被草吃进来的宽度（地块宽的比例，0 为铺地完整） */
  plazaGrass: number;
  /** 广场 3×3 石板里缺掉的块数 */
  plazaMissing: number;
  /** 村落地面褪色区的不透明度（画进地面缓存） */
  groundFade: number;
  /** 褪色区的色调：0 灰褐的落灰，1 枯黄 */
  groundDry: number;
  /** 村里小路被草吃掉的程度（路色混进草色的比例） */
  pathGrass: number;
  /** 每户门前都长杂草 */
  weeds: boolean;
  /** 院落生活道具保留的比例 */
  yardProps: number;
  /** 塌顶的户数 */
  collapsed: number;
  /** 单号户封窗 */
  boarded: boolean;
}

/** 正常 / 安静 / 蒙灰 / 搬离（logic/config.ts 的 STAGE_NAMES） */
export const DECAY_LOOK: readonly DecayLook[] = [
  { roofSaturation: 1, roofDust: 0, smokeShare: 1, litShare: 0.9, plazaGrass: 0, plazaMissing: 0, groundFade: 0, groundDry: 0, pathGrass: 0, weeds: false, yardProps: 1, collapsed: 0, boarded: false },
  { roofSaturation: 0.22, roofDust: 0.1, smokeShare: 0.5, litShare: 0.5, plazaGrass: 0.2, plazaMissing: 0, groundFade: 0, groundDry: 0, pathGrass: 0.35, weeds: false, yardProps: 1, collapsed: 0, boarded: false },
  { roofSaturation: 0.12, roofDust: 0.3, smokeShare: 0, litShare: 0.25, plazaGrass: 0.26, plazaMissing: 3, groundFade: 0.72, groundDry: 0, pathGrass: 0.6, weeds: true, yardProps: 0.5, collapsed: 0, boarded: false },
  { roofSaturation: 0.06, roofDust: 0.42, smokeShare: 0, litShare: 0.12, plazaGrass: 0.32, plazaMissing: 5, groundFade: 0.72, groundDry: 1, pathGrass: 0.8, weeds: true, yardProps: 0, collapsed: 1, boarded: true },
];

export function decayLook(stage: Stage | number): DecayLook {
  return DECAY_LOOK[clamp(Math.round(stage), 0, DECAY_LOOK.length - 1)];
}

/** 这一户冒不冒炊烟：按户的随机数和阶段的比例，比例减半时正好一半人家熄火 */
export function houseSmokes(projectId: string, slot: number, stage: Stage | number): boolean {
  return houseHash(projectId, slot, 3) < decayLook(stage).smokeShare;
}

/** 这一户夜里亮不亮灯 */
export function houseLit(projectId: string, slot: number, stage: Stage | number): boolean {
  return houseHash(projectId, slot, 2) < decayLook(stage).litShare;
}

/** 这一户封不封窗：搬离的村子里单号户封窗 */
export function houseBoarded(slot: number, stage: Stage | number): boolean {
  return decayLook(stage).boarded && slot % 2 === 1;
}

/**
 * 搬离的村子里塌顶的那一户：优先挑封了窗的单号户，只有一户时就是它。
 * 只由项目 id 和房子数决定，同一座村子每次塌的是同一户。
 */
export function collapsedSlot(projectId: string, houses: number, stage: Stage | number): number {
  if (!decayLook(stage).collapsed || houses <= 0) return -1;
  if (houses === 1) return 0;
  let best = -1;
  let score = -1;
  for (let k = 1; k < houses; k += 2) {
    const r = houseHash(projectId, k, 7);
    if (r > score) {
      score = r;
      best = k;
    }
  }
  return best;
}

/**
 * 广场 3×3 石板里缺掉的那几块（0–8，行优先），只由广场位置决定。
 * 正中那块（4）压在井底下，缺了也看不见，不在候选里。
 */
export function missingSlabs(i: number, j: number, stage: Stage | number): number[] {
  const n = decayLook(stage).plazaMissing;
  if (!n) return [];
  return [0, 1, 2, 3, 5, 6, 7, 8]
    .map((k) => ({ k, r: hash(`slab:${i},${j}:${k}`) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map(({ k }) => k)
    .sort((a, b) => a - b);
}

/* ================================================================
 * B4 村落识别：墙面材质
 * ================================================================ */

export const WALL_MATERIALS = ['plaster', 'timber', 'stone'] as const;
export type WallMaterial = (typeof WALL_MATERIALS)[number];

/** 按项目 id 哈希分配：白灰、木板、石砌三种，同一座村子的房子用同一种 */
export function wallMaterial(projectId: string): WallMaterial {
  return WALL_MATERIALS[Math.min(WALL_MATERIALS.length - 1, Math.floor(hash(`wall:${projectId}`) * WALL_MATERIALS.length))];
}

/* ================================================================
 * B2 培育区等级
 * ================================================================ */

/**
 * 每一级在全景下多出来的那样东西（计划 5.2 节 B2 表）。0 级的元素是「在等待」的样子，不是没画完。
 * 绘制按这里的列表画，测试检查每一级都包含上一级没有的元素。
 */
export const CULTIVATION_STEPS: Record<CultivationKind, readonly (readonly string[])[]> = {
  /** 农田：翻好的空垄和田埂 → 嫩芽 → 半高作物 → 成熟立稻草人 → 金黄、地头堆草垛 */
  field: [['ridges', 'bund'], ['sprouts'], ['crop-half'], ['crop-ripe', 'scarecrow'], ['crop-gold', 'haystack']],
  /** 果园：树苗加支架 → 小树 → 成树 → 开花 → 结果、树下放果篮 */
  orchard: [['saplings', 'stakes'], ['young-trees'], ['grown-trees'], ['blossom'], ['fruit', 'basket']],
  /** 鱼塘：石头岸边、芦苇、静水 → 睡莲 → 鱼影 → 鸭子与涟漪 → 小栈桥和钓竿 */
  pond: [['stone-bank', 'reeds', 'still-water'], ['lilies'], ['fish'], ['ducks', 'ripples'], ['jetty', 'rod']],
  /** 花园：篱笆围起的空花床 → 嫩芽 → 零星开花 → 成片开花 → 花拱门、蝴蝶 */
  garden: [['fence', 'bed'], ['sprouts'], ['sparse-bloom'], ['full-bloom'], ['arch', 'butterflies']],
};

/**
 * 某一级画面上有哪些元素。作物、树、花这类「同一样东西长大」的元素，到下一级会被替换（嫩芽长成半高作物），
 * 其余元素（田埂、稻草人、睡莲、篱笆……）一直保留。
 */
const REPLACED: Record<CultivationKind, readonly string[][]> = {
  field: [['sprouts', 'crop-half', 'crop-ripe', 'crop-gold']],
  orchard: [['saplings', 'young-trees', 'grown-trees'], ['stakes', 'grown-trees'], ['blossom', 'fruit']],
  pond: [],
  garden: [['sprouts', 'sparse-bloom', 'full-bloom']],
};

export function cultivationElements(kind: CultivationKind, level: CultivationLevel | number): Set<string> {
  const top = clamp(Math.round(level), 0, 4);
  const out = new Set<string>();
  for (let k = 0; k <= top; k++) for (const e of CULTIVATION_STEPS[kind][k]) out.add(e);
  for (const chain of REPLACED[kind]) {
    const present = chain.filter((e) => out.has(e));
    for (const e of present.slice(0, -1)) out.delete(e);
  }
  return out;
}

/* ================================================================
 * B3 粮仓
 * ================================================================ */

/** 门口麻袋的最多个数 */
export const GRANARY_SACKS = 5;
/** 余量低于这个比例时仓门敞开、里面是空的 */
export const GRANARY_EMPTY = 0.2;

/**
 * 门口堆几只麻袋（0–5）：余量比例按五等分向上取，有一点就至少一袋；
 * 低于 GRANARY_EMPTY 时仓里见底，一袋也不剩。
 */
export function granarySacks(ratio: number): number {
  if (!(ratio >= GRANARY_EMPTY)) return 0;
  return clamp(Math.ceil(ratio * GRANARY_SACKS - 1e-9), 1, GRANARY_SACKS);
}

export function granaryEmpty(ratio: number): boolean {
  return !(ratio >= GRANARY_EMPTY);
}
