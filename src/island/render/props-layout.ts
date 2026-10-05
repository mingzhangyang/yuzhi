import type { IslandMap, Tile } from '../map';
import { PROP_SPRITES, type PropId } from '../prop-sprites';
import { houseHash, houseVariant } from './style';

/** 一件摆在地上的道具：落地点 (i, j)，绘制宽度 w 以地块宽为单位 */
export interface PlacedProp {
  id: PropId;
  i: number;
  j: number;
  w: number;
}

/** 村落布置只看这几项，场景里的 VillageView 直接满足 */
export interface PropVillage {
  slot: number;
  projectId: string;
  stage: number;
  houses: number;
}

/** 积雪超过这个厚度就不摆道具：现有贴图都是春夏的样子，底下带着青草和花 */
export const PROP_SNOW_LIMIT = 0.18;

/** 各道具的绘制宽度（地块宽的倍数）：按房子（0.42）和小人（约 0.15 宽、0.2 高）的比例定 */
const WIDTH: Partial<Record<PropId, number>> = {
  'crate': 0.18,
  'stacked-crates': 0.23,
  'barrel': 0.15,
  'rope-coil': 0.18,
  'fishing-net': 0.23,
  'lantern-post': 0.14,
  'signpost': 0.15,
  'market-stall': 0.34,
  'bench': 0.26,
  'water-jar': 0.18,
  'handcart': 0.27,
  'clothesline': 0.3,
  'potted-flowers': 0.23,
  'vegetable-planter': 0.27,
  'stump-seating': 0.23,
  'haystack': 0.23,
};

/** 灯笼在贴图里的位置（相对贴图宽、高，从左上角量起），夜里在这里点灯 */
export const PROP_LAMPS: Partial<Record<PropId, [number, number]>> = {
  'lantern-post': [0.7, 0.55],
  'signpost': [0.63, 0.66],
};

/** 道具在屏幕上的外框：以落地点为底边中点，半宽 hw、高 h。绘制、阴影和遮挡轮廓共用 */
export function propBox(id: PropId, width: number): { hw: number; h: number; top: number } {
  const sp = PROP_SPRITES[id];
  const h = width * (sp.h / sp.w);
  return { hw: width * sp.anchorX, h, top: h * sp.anchorY };
}

/**
 * 遮挡轮廓：贴图四角是透明的（底下的草丛、顶上的灯杆都比外框窄），轮廓收成八边形，
 * 不让一块空白挡住后面的小人。
 */
export function propOutline(id: PropId, x: number, y: number, width: number): [number, number][] {
  const { hw, top } = propBox(id, width);
  const w = hw * 0.86;
  const bottom = y - top * 0.02;
  const t = y - top * 0.94;
  return [
    [x - w * 0.8, bottom],
    [x + w * 0.8, bottom],
    [x + w, bottom - top * 0.2],
    [x + w, t + top * 0.2],
    [x + w * 0.7, t],
    [x - w * 0.7, t],
    [x - w, t + top * 0.2],
    [x - w, bottom - top * 0.2],
  ];
}

const prop = (id: PropId, i: number, j: number): PlacedProp => ({ id, i, j, w: WIDTH[id] ?? 0.15 });
const pick = <T>(list: readonly T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))];

/** 码头：岸边地块后侧堆着几件渔具；路牌立在栈桥口 */
function harborProps(m: IslandMap): PlacedProp[] {
  const { i, j } = m.dock;
  return [
    prop('crate', i - 0.32, j - 0.22),
    prop('barrel', i + 0.66, j - 0.06),
    prop('rope-coil', i + 0.14, j + 0.29),
    prop('fishing-net', i + 0.8, j + 0.32),
    prop('stacked-crates', i - 0.7, j - 0.55),
    prop('signpost', i - 0.3, j + 0.5),
  ];
}

/**
 * 一格空地：草地、没有树、没有房子（还没盖房的房屋位也算空地）、不是地标或其他建筑，也还没摆过道具。
 * 村子长大、在这格盖起房子后，道具会让到别处。
 */
interface Ground {
  m: IslandMap;
  built: Set<Tile>;
  taken: Set<Tile>;
}

function freeTile(g: Ground, t: Tile | null): t is Tile {
  return !!t && t.type === 'grass' && !t.edge && !t.trees.length && !g.built.has(t) && t.landmark < 0 && t !== g.m.granary && t !== g.m.chores && !g.taken.has(t);
}

/** 广场周围八格，左后方三格除外：那里是告示牌和条幅（villageAgendaAnchor：中心 −0.72, −0.72） */
const AROUND: [number, number][] = [
  [1, -1],
  [-1, 1],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * 村落广场：井和周围一圈小路都留空（小人在这里聚会），道具摆在广场旁边那格空地的正中，不和两侧的房子挤在一起。
 * 兴旺、房子多的村子摆市集摊位，冷清的只剩一只木桶，荒废的什么也不放。
 */
function plazaProps(g: Ground, v: PropVillage, center: Tile): PlacedProp[] {
  if (v.stage >= 3) return [];
  const r = (salt: number) => houseHash(v.projectId, 90, salt);
  const ids: PropId[] =
    v.stage === 2
      ? [pick(['barrel', 'crate'] as const, r(2))]
      : [v.stage === 0 && v.houses >= 5 ? 'market-stall' : pick(['bench', 'water-jar', 'potted-flowers'] as const, r(3))];
  // 三户以上的村子，另一边再立一盏灯柱或一条长椅
  if (v.stage < 2 && v.houses > 3) ids.push(r(4) < 0.7 ? 'lantern-post' : 'bench');
  const spots = AROUND.map(([di, dj], k) => ({ di, dj, r: r(10 + k) }))
    .sort((a, b) => a.r - b.r)
    .filter(({ di, dj }) => freeTile(g, g.m.at(center.i + di, center.j + dj)));
  const out: PlacedProp[] = [];
  for (let k = 0; k < ids.length && k < spots.length; k++) {
    const { di, dj } = spots[k];
    g.taken.add(g.m.at(center.i + di, center.j + dj)!);
    out.push(prop(ids[k], center.i + di, center.j + dj));
  }
  return out;
}

/** 房子左右两侧（屏幕上的左角、右角）有空地：前面会挡住门，后面会被屋顶盖住 */
const SIDES: [number, number][] = [
  [0.38, -0.38],
  [-0.38, 0.38],
];

/** 院落：每户按种子决定摆不摆、摆什么、摆在哪一侧；旁边那格有房子或别的东西时换一侧或不摆 */
function yardProps(g: Ground, v: PropVillage): PlacedProp[] {
  if (v.stage >= 3) return [];
  const m = g.m;
  const site = m.villages[v.slot];
  const chance = [0.36, 0.26, 0.14][v.stage];
  const pool: readonly PropId[] =
    v.stage < 2 ? ['clothesline', 'potted-flowers', 'vegetable-planter', 'water-jar', 'barrel', 'handcart', 'stump-seating', 'haystack'] : ['stacked-crates', 'handcart', 'barrel'];
  const out: PlacedProp[] = [];
  const n = Math.min(v.houses, site.slots.length);
  for (let k = 0; k < n && out.length < 3; k++) {
    if (houseHash(v.projectId, k, 20) >= chance) continue;
    const t = site.slots[k];
    // 带披屋的房子左侧已经占满
    const sides = houseVariant(v.projectId, k) === 3 ? [SIDES[0]] : houseHash(v.projectId, k, 21) < 0.5 ? SIDES : [SIDES[1], SIDES[0]];
    for (const [di, dj] of sides) {
      // 斜邻的那格要是空地，免得道具挤在两座房子中间
      const nb = m.at(t.i + Math.sign(di), t.j + Math.sign(dj));
      if (!freeTile(g, nb)) continue;
      out.push(prop(pick(pool, houseHash(v.projectId, k, 22)), t.i + di, t.j + dj));
      g.taken.add(nb);
      break;
    }
  }
  return out;
}

/**
 * 岛上所有的环境道具。摆放只由地块和项目 id 决定（不用随机数），同一座村子每次都摆得一样；
 * 冬天积雪时整批不摆。
 */
export function islandProps(m: IslandMap, villages: readonly PropVillage[], cover: number): PlacedProp[] {
  if (cover > PROP_SNOW_LIMIT) return [];
  const out = harborProps(m);
  const sites = villages.filter((v) => m.villages[v.slot]);
  const g: Ground = { m, built: new Set(), taken: new Set() };
  for (const v of sites) for (const t of m.villages[v.slot].slots.slice(0, v.houses)) g.built.add(t);
  // 先排广场，再排院落：广场旁的空地优先给市集和灯柱
  for (const v of sites) out.push(...plazaProps(g, v, m.villages[v.slot].center));
  for (const v of sites) out.push(...yardProps(g, v));
  return out;
}
