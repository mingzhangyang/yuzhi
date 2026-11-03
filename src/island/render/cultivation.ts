/**
 * 四个公共培育区（美术优化计划 B2）。等级规则不变（src/logic/cultivation.ts），
 * 每一级画什么由 visual-state.ts 的 cultivationElements 决定：每升一级，全景下都多出一样看得见的东西，
 * 0 级是「在等待」的样子（翻好的空垄、扶着支架的树苗、静水、篱笆围起的空花床），不是没画完。
 * 积雪时各级都有雪里的样子：农田留茬、鱼塘结冰但岸边的石头和芦苇还在、果园光秃但支架和果篮还在。
 */
import type { CultivationAreaState, CultivationKind } from '../../logic/cultivation';
import { CULTIVATION, SNOW, SNOW_SHADE, withAlpha } from './palette';
import { shade } from './utils';
import { cultivationElements } from './visual-state';

type Pt = [number, number];
/** 培育区局部的等距坐标：pi、pj 以地块宽为单位（地块中心为原点），z 为向上的屏幕像素 */
type Iso = (pi: number, pj: number, z?: number) => Pt;

interface Area {
  c: CanvasRenderingContext2D;
  P: Iso;
  x: number;
  y: number;
  tw: number;
  has: Set<string>;
  snow: boolean;
  /** 动画时钟；减弱动态效果时恒为 0，鱼、鸭子、蝴蝶都停在原处 */
  t: number;
}

const F = CULTIVATION.field;
const O = CULTIVATION.orchard;
const W = CULTIVATION.pond;
const G = CULTIVATION.garden;

function fillPoly(c: CanvasRenderingContext2D, fill: string, pts: readonly Pt[]) {
  c.fillStyle = fill;
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) c.lineTo(pts[k][0], pts[k][1]);
  c.closePath();
  c.fill();
}

function dot(c: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

/** 同一种颜色的一批圆点合成一条路径、一次填充 */
function dots(c: CanvasRenderingContext2D, pts: readonly [number, number, number][], fill: string) {
  if (!pts.length) return;
  c.fillStyle = fill;
  c.beginPath();
  for (const [x, y, r] of pts) {
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, Math.PI * 2);
  }
  c.fill();
}

/** 以 (pi, pj) 为中心、半对角线 r 的菱形 */
const diamond = (P: Iso, r: number, ci = 0, cj = 0): Pt[] => [P(ci - r, cj - r), P(ci + r, cj - r), P(ci + r, cj + r), P(ci - r, cj + r)];

/** A narrow stroked path as a four-point opaque silhouette (width in CSS pixels). */
function strokeOutline(a: Pt, b: Pt, width: number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * width / 2, ny = (dx / len) * width / 2;
  return [
    [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
  ];
}

/** 稳定的小随机数：同一区域、同一序号每帧都一样 */
const rnd = (k: number, salt: number) => {
  const v = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/* ---------------- 农田 ---------------- */

/** 垄的位置（沿 pi 方向的一行行），由后往前 */
const FIELD_ROWS = [-0.28, -0.14, 0, 0.14, 0.28];

function drawField(A: Area) {
  const { c, P, tw, has, snow } = A;
  // 田埂：一圈略高的土边，里面是翻好的土
  fillPoly(c, snow ? F.bundSnow : F.bund, diamond(P, 0.47));
  fillPoly(c, snow ? F.soilSnow : F.soil, diamond(P, 0.4));
  c.lineCap = 'round';
  // 垄背（亮）与垄沟（暗）
  c.strokeStyle = snow ? F.ridgeSnow : F.ridge;
  c.lineWidth = Math.max(0.9, tw * 0.04);
  c.beginPath();
  for (const pj of FIELD_ROWS) {
    c.moveTo(...P(-0.33, pj));
    c.lineTo(...P(0.33, pj));
  }
  c.stroke();
  c.strokeStyle = snow ? F.furrowSnow : F.furrow;
  c.lineWidth = Math.max(0.6, tw * 0.014);
  c.beginPath();
  for (const pj of FIELD_ROWS.slice(0, -1)) {
    c.moveTo(...P(-0.33, pj + 0.07));
    c.lineTo(...P(0.33, pj + 0.07));
  }
  c.stroke();

  const crop = fieldCrop(has);
  if (crop) drawCropRows(A, crop);
  if (has.has('scarecrow')) drawScarecrow(A, ...P(0.06, -0.12));
  if (has.has('haystack')) drawHaystack(A, ...P(0.43, 0.12), tw * 0.11);
}

type Crop = 'sprout' | 'half' | 'ripe' | 'gold';
const CROP_HEIGHT: Record<Crop, number> = { sprout: 0.035, half: 0.08, ripe: 0.12, gold: 0.13 };
const CROP_BAND: Record<Crop, number> = { sprout: 0.022, half: 0.065, ripe: 0.075, gold: 0.08 };

function fieldCrop(has: ReadonlySet<string>): Crop | null {
  return has.has('crop-gold') ? 'gold' : has.has('crop-ripe') ? 'ripe'
    : has.has('crop-half') ? 'half' : has.has('sprouts') ? 'sprout' : null;
}

/** Exact crop height and band thickness shared by painting and hit occlusion. */
function cropMetrics(crop: Crop, tw: number, snow: boolean) {
  return {
    height: CROP_HEIGHT[crop] * tw * (snow ? 0.55 : 1),
    band: CROP_BAND[crop] * tw * (snow ? 0.5 : 1),
  };
}

/**
 * 一行行作物：先画一条从上面看到的作物带（全景下就是这一条条的颜色在变），再画一株株的茎和穗。
 * 积雪时只剩冒出雪面的麦苗或茬。
 */
function drawCropRows(A: Area, crop: Crop) {
  const { c, P, tw, snow } = A;
  const { height: H, band } = cropMetrics(crop, tw, snow);
  const top = snow ? (crop === 'sprout' ? F.sproutSnow : crop === 'gold' ? F.stubbleGold : F.stubble) : F[crop];
  const stalk = snow ? shade(top, -0.2) : crop === 'gold' ? F.stalkGold : crop === 'ripe' ? F.stalkRipe : F.stalk;
  // 三遍各合成一条路径：先是一条条作物带，再是一株株的茎，最后是穗；后排的茎往上长，不会压到前排的作物带
  c.strokeStyle = top;
  c.lineWidth = Math.max(0.8, band);
  c.beginPath();
  for (const pj of FIELD_ROWS) {
    c.moveTo(...P(-0.31, pj, H * 0.55));
    c.lineTo(...P(0.31, pj, H * 0.55));
  }
  c.stroke();
  if (crop === 'sprout' && !snow) return;
  // 一株株：三根茎（嫩芽只有两片叶），成熟以后顶上一粒穗
  c.strokeStyle = stalk;
  c.lineWidth = Math.max(0.6, tw * 0.014);
  c.beginPath();
  for (const pj of FIELD_ROWS) {
    for (let pi = -0.3; pi <= 0.31; pi += 0.075) {
      const [px, py] = P(pi, pj);
      for (const d of [-1, 0, 1]) {
        c.moveTo(px, py);
        c.lineTo(px + d * tw * 0.018, py - H * (d ? 0.82 : 1));
      }
    }
  }
  c.stroke();
  if (snow || (crop !== 'ripe' && crop !== 'gold')) return;
  // 熟透的穗往一边垂
  const lean = crop === 'gold' ? tw * 0.016 : 0;
  c.fillStyle = crop === 'gold' ? F.earGold : F.ear;
  c.beginPath();
  for (const pj of FIELD_ROWS) {
    for (let pi = -0.3; pi <= 0.31; pi += 0.075) {
      const [px, py] = P(pi, pj);
      c.moveTo(px + lean + tw * 0.018, py - H);
      c.ellipse(px + lean, py - H, tw * 0.018, tw * 0.011, crop === 'gold' ? 0.7 : -0.4, 0, Math.PI * 2);
    }
  }
  c.fill();
}

/** 稻草人：一根杆、一根横担，旧衣服、草扎的头、宽边草帽。不动，和走动的小人（任务）一眼分开。 */
function drawScarecrow(A: Area, x: number, y: number) {
  const { c, tw, snow } = A;
  const h = tw * 0.34;
  c.strokeStyle = F.scarecrowPole;
  c.lineCap = 'round';
  c.lineWidth = Math.max(0.8, tw * 0.02);
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y - h);
  c.moveTo(x - tw * 0.1, y - h * 0.68);
  c.lineTo(x + tw * 0.1, y - h * 0.62);
  c.stroke();
  // 衣服：一块挂在横担上的梯形布
  fillPoly(c, F.scarecrowShirt, [
    [x - tw * 0.075, y - h * 0.7],
    [x + tw * 0.075, y - h * 0.66],
    [x + tw * 0.05, y - h * 0.36],
    [x - tw * 0.05, y - h * 0.38],
  ]);
  // 袖口露出的稻草
  dot(c, x - tw * 0.1, y - h * 0.68, tw * 0.016, F.scarecrowStraw);
  dot(c, x + tw * 0.1, y - h * 0.62, tw * 0.016, F.scarecrowStraw);
  dot(c, x, y - h * 0.84, tw * 0.035, F.scarecrowStraw);
  // 草帽
  c.fillStyle = F.scarecrowHat;
  c.beginPath();
  c.ellipse(x, y - h * 0.93, tw * 0.07, tw * 0.02, 0, 0, Math.PI * 2);
  c.fill();
  fillPoly(c, F.scarecrowHat, [
    [x - tw * 0.035, y - h * 0.93],
    [x - tw * 0.025, y - h * 1.04],
    [x + tw * 0.025, y - h * 1.04],
    [x + tw * 0.035, y - h * 0.93],
  ]);
  if (snow) {
    c.fillStyle = SNOW;
    c.beginPath();
    c.ellipse(x, y - h * 1.03, tw * 0.035, tw * 0.012, 0, 0, Math.PI * 2);
    c.fill();
  }
}

/** 草垛：圆鼓鼓的一垛，中间一道草绳；积雪时顶上一层雪 */
function drawHaystack(A: Area, x: number, y: number, r: number) {
  const { c, snow } = A;
  c.fillStyle = withAlpha(F.hayBand, 0.25);
  c.beginPath();
  c.ellipse(x + r * 0.2, y + r * 0.05, r * 1.1, r * 0.38, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = F.hay;
  c.beginPath();
  c.moveTo(x - r, y);
  c.bezierCurveTo(x - r * 1.05, y - r * 1.2, x - r * 0.3, y - r * 1.65, x, y - r * 1.65);
  c.bezierCurveTo(x + r * 0.3, y - r * 1.65, x + r * 1.05, y - r * 1.2, x + r, y);
  c.closePath();
  c.fill();
  c.fillStyle = F.hayShade;
  c.beginPath();
  c.moveTo(x + r * 0.15, y + r * 0.02);
  c.bezierCurveTo(x + r * 0.35, y - r * 0.9, x + r * 0.2, y - r * 1.5, x, y - r * 1.65);
  c.bezierCurveTo(x + r * 0.3, y - r * 1.65, x + r * 1.05, y - r * 1.2, x + r, y);
  c.closePath();
  c.fill();
  c.strokeStyle = F.hayBand;
  c.lineWidth = Math.max(0.6, r * 0.12);
  c.beginPath();
  c.ellipse(x, y - r * 0.75, r * 0.93, r * 0.22, 0, 0.1, Math.PI - 0.1);
  c.stroke();
  if (snow) {
    c.fillStyle = SNOW;
    c.beginPath();
    c.ellipse(x, y - r * 1.45, r * 0.62, r * 0.28, 0, 0, Math.PI * 2);
    c.fill();
  }
}

/* ---------------- 果园 ---------------- */

/** 四棵树的位置，由后往前画 */
const ORCHARD_TREES: readonly [number, number][] = [
  [-0.2, -0.2],
  [0.2, -0.2],
  [-0.2, 0.2],
  [0.2, 0.2],
];

function drawOrchard(A: Area) {
  const { c, P, tw, has, snow } = A;
  fillPoly(c, snow ? O.grassSnow : O.grass, diamond(P, 0.46));
  c.strokeStyle = O.edge;
  c.lineWidth = Math.max(0.7, tw * 0.014);
  c.beginPath();
  const edge = diamond(P, 0.46);
  c.moveTo(...edge[0]);
  for (const p of edge.slice(1)) c.lineTo(...p);
  c.closePath();
  c.stroke();
  const size = has.has('grown-trees') ? 2 : has.has('young-trees') ? 1 : 0;
  ORCHARD_TREES.forEach(([pi, pj], k) => {
    const [x, y] = P(pi, pj);
    // 树坑：刚种下、还小的时候看得见一圈土
    if (size < 2) {
      c.fillStyle = snow ? O.wellSnow : O.well;
      c.beginPath();
      c.ellipse(x, y, tw * 0.065, tw * 0.03, 0, 0, Math.PI * 2);
      c.fill();
    }
    drawFruitTree(A, x, y, size, k);
  });
  if (has.has('basket')) drawBasket(A, ...P(0.38, -0.02));
}

function drawFruitTree(A: Area, x: number, y: number, size: 0 | 1 | 2, k: number) {
  const { c, tw, has, snow } = A;
  const trunkH = tw * [0.13, 0.12, 0.15][size];
  c.lineCap = 'round';
  // 支架：树苗旁一根直的木杆，中间绑一道绳
  if (has.has('stakes')) {
    c.strokeStyle = O.stake;
    c.lineWidth = Math.max(0.6, tw * 0.014);
    c.beginPath();
    c.moveTo(x + tw * 0.03, y + tw * 0.005);
    c.lineTo(x + tw * 0.03, y - tw * 0.2);
    c.stroke();
    c.strokeStyle = O.tie;
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    c.moveTo(x - tw * 0.004, y - trunkH * 0.6);
    c.lineTo(x + tw * 0.034, y - trunkH * 0.62);
    c.stroke();
  }
  // 树干；冬天达到开花那一级的果园给树干刷了白
  const whitewash = snow && has.has('grown-trees') && (has.has('blossom') || has.has('fruit'));
  c.strokeStyle = O.trunk;
  c.lineWidth = Math.max(0.7, tw * [0.016, 0.024, 0.032][size]);
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y - trunkH);
  c.stroke();
  if (whitewash) {
    c.strokeStyle = O.whitewash;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x, y - trunkH * 0.45);
    c.stroke();
  }
  const cy = y - trunkH - tw * [0.02, 0.05, 0.08][size];
  if (size === 0) {
    // 树苗顶上两三片嫩叶；冬天光秃
    if (!snow) {
      c.fillStyle = O.leaf;
      c.beginPath();
      c.ellipse(x - tw * 0.02, y - trunkH, tw * 0.024, tw * 0.011, -0.5, 0, Math.PI * 2);
      c.ellipse(x + tw * 0.02, y - trunkH - tw * 0.01, tw * 0.024, tw * 0.011, 0.5, 0, Math.PI * 2);
      c.fill();
    }
    return;
  }
  const R = tw * [0, 0.07, 0.115][size];
  if (snow) {
    // 光秃的枝条，枝头压一点雪；结果那一级挂着几颗没摘的果子
    c.strokeStyle = O.branch;
    c.lineWidth = Math.max(0.5, tw * 0.012);
    c.beginPath();
    for (const [dx, dy] of [[-0.8, -0.7], [0.75, -0.8], [0, -1.05], [-0.4, -0.25], [0.45, -0.3]]) {
      c.moveTo(x, y - trunkH);
      c.lineTo(x + dx * R, cy + dy * R * 0.55);
    }
    c.stroke();
    dots(c, ([[-0.8, -0.7], [0.75, -0.8], [0, -1.05]] as const).map(([dx, dy]) => [x + dx * R, cy + dy * R * 0.55 - tw * 0.006, tw * 0.014]), SNOW);
    if (has.has('fruit')) dots(c, [0, 1, 2, 3].map((f) => [x + (rnd(k * 7 + f, 3) - 0.5) * R * 1.4, cy + (rnd(k * 7 + f, 4) - 0.6) * R * 0.8, tw * 0.016]), O.fruit);
    return;
  }
  // 树冠：几团叶子，受光的一团亮一些
  c.fillStyle = size === 1 ? O.young : O.crown;
  c.beginPath();
  const lobes: [number, number, number][] = size === 1 ? [[0, 0, 1]] : [[-0.5, 0.1, 0.72], [0.5, 0.05, 0.72], [0, -0.32, 0.8], [0, 0.15, 0.85]];
  for (const [dx, dy, r] of lobes) {
    c.moveTo(x + dx * R + r * R, cy + dy * R);
    c.arc(x + dx * R, cy + dy * R, r * R, 0, Math.PI * 2);
  }
  c.fill();
  if (size === 2) dot(c, x - R * 0.25, cy - R * 0.35, R * 0.45, O.crownLit);
  if (has.has('blossom')) {
    const pale: [number, number, number][] = [];
    const deep: [number, number, number][] = [];
    for (let f = 0; f < 9; f++) {
      const a = rnd(k * 11 + f, 1) * Math.PI * 2;
      const d = Math.sqrt(rnd(k * 11 + f, 2)) * R * 0.95;
      (f % 3 ? pale : deep).push([x + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, tw * 0.02]);
    }
    dots(c, pale, O.blossom);
    dots(c, deep, O.blossomDeep);
  }
  if (has.has('fruit')) {
    const fruit: [number, number, number][] = [];
    for (let f = 0; f < 6; f++) {
      const a = rnd(k * 13 + f, 5) * Math.PI * 2;
      const d = (0.35 + rnd(k * 13 + f, 6) * 0.55) * R;
      fruit.push([x + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8 + R * 0.1, tw * 0.019]);
    }
    dots(c, fruit, O.fruit);
  }
}

/** 树下的果篮：一只编筐，装满了果子；冬天是空筐盖着雪 */
function drawBasket(A: Area, x: number, y: number) {
  const { c, tw, snow } = A;
  const w = tw * 0.07;
  const h = tw * 0.055;
  fillPoly(c, O.basket, [
    [x - w, y - h],
    [x + w, y - h],
    [x + w * 0.75, y],
    [x - w * 0.75, y],
  ]);
  c.strokeStyle = O.basketWeave;
  c.lineWidth = Math.max(0.5, tw * 0.008);
  c.beginPath();
  c.moveTo(x - w * 0.88, y - h * 0.5);
  c.lineTo(x + w * 0.88, y - h * 0.5);
  c.stroke();
  if (snow) {
    c.fillStyle = SNOW;
    c.beginPath();
    c.ellipse(x, y - h, w, w * 0.3, 0, 0, Math.PI * 2);
    c.fill();
    return;
  }
  for (const [dx, dy] of [[-0.5, -1.05], [0, -1.15], [0.5, -1.05], [-0.25, -1.35], [0.25, -1.35]]) dot(c, x + dx * w, y + dy * h, tw * 0.021, O.fruit);
}

/* ---------------- 鱼塘 ---------------- */

const POND_RX = 0.42;
const POND_RY = 0.21;

function drawPond(A: Area) {
  const { c, x, y, tw, has, snow, t } = A;
  const rx = tw * POND_RX;
  const ry = tw * POND_RY;
  // 水面：中间深一点；结冰时是灰白的冰
  c.fillStyle = snow ? W.ice : W.water;
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = snow ? W.iceShade : W.waterDeep;
  c.beginPath();
  c.ellipse(x + rx * 0.08, y + ry * 0.12, rx * 0.62, ry * 0.55, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = W.bank;
  c.lineWidth = Math.max(0.8, tw * 0.022);
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.stroke();
  // 静水：一道水光；冰面上是两道裂纹
  c.strokeStyle = snow ? withAlpha(W.crack, 0.5) : withAlpha(W.ripple, 0.45);
  c.lineWidth = Math.max(0.6, tw * 0.012);
  c.beginPath();
  if (snow) {
    c.moveTo(x - rx * 0.5, y - ry * 0.1);
    c.lineTo(x - rx * 0.2, y + ry * 0.15);
    c.lineTo(x + rx * 0.1, y + ry * 0.05);
  } else {
    c.moveTo(x - rx * 0.45, y - ry * 0.35);
    c.lineTo(x - rx * 0.12, y - ry * 0.42);
  }
  c.stroke();

  if (has.has('lilies')) {
    // 睡莲：几片圆叶，一朵粉花；结冰时冻在冰下，颜色发灰
    const pads: [number, number, number][] = [[-0.55, 0.2, 1], [-0.3, 0.45, 0.8], [0.35, -0.35, 0.9], [0.55, 0.15, 0.75]];
    c.fillStyle = snow ? withAlpha(W.lilyIce, 0.7) : W.lily;
    c.beginPath();
    for (const [dx, dy, s] of pads) {
      c.moveTo(x + dx * rx + tw * 0.045 * s, y + dy * ry);
      c.ellipse(x + dx * rx, y + dy * ry, tw * 0.045 * s, tw * 0.022 * s, 0, 0.35, Math.PI * 2);
      c.lineTo(x + dx * rx, y + dy * ry);
    }
    c.fill();
    if (!snow) dot(c, x - 0.55 * rx, y + 0.2 * ry - tw * 0.008, tw * 0.018, W.lilyFlower);
  }

  if (has.has('fish')) {
    // 鱼影：几尾橙色的鱼慢慢绕圈；结冰时是冰下不动的暗影
    for (let k = 0; k < 3; k++) {
      const a = (snow ? 0 : t * 0.25) + k * 2.1;
      const fx = x + Math.cos(a) * rx * 0.48;
      const fy = y + Math.sin(a) * ry * 0.42;
      const dir = snow ? 1 : -Math.sin(a) >= 0 ? 1 : -1;
      drawFish(c, fx, fy, tw, dir, snow);
    }
  }

  if (has.has('ducks')) {
    if (snow) {
      // 冰面上凿开一个冰洞，鸭子在洞边
      c.fillStyle = W.hole;
      c.beginPath();
      c.ellipse(x + rx * 0.25, y + ry * 0.1, tw * 0.07, tw * 0.03, 0, 0, Math.PI * 2);
      c.fill();
    }
    for (let k = 0; k < 2; k++) {
      const drift = snow ? 0 : Math.sin(t * 0.2 + k * 2) * rx * 0.12;
      const dx = x + (k ? 0.05 : -0.35) * rx + drift;
      const dy = y + (k ? -0.3 : 0.25) * ry;
      if (has.has('ripples') && !snow) {
        // 鸭子身后的涟漪
        for (let r = 0; r < 2; r++) {
          const ph = (t * 0.45 + r * 0.5 + k * 0.3) % 1;
          c.strokeStyle = withAlpha(W.ripple, 0.55 * (1 - ph));
          c.lineWidth = Math.max(0.5, tw * 0.01);
          c.beginPath();
          c.ellipse(dx + tw * 0.02, dy + tw * 0.008, tw * (0.05 + ph * 0.06), tw * (0.018 + ph * 0.024), 0, 0, Math.PI * 2);
          c.stroke();
        }
      }
      drawDuck(c, dx, dy, tw, k ? -1 : 1);
    }
    if (has.has('ripples') && snow) {
      c.strokeStyle = withAlpha(W.ripple, 0.5);
      c.lineWidth = Math.max(0.5, tw * 0.01);
      c.beginPath();
      c.ellipse(x + rx * 0.25, y + ry * 0.1, tw * 0.045, tw * 0.018, 0, 0, Math.PI * 2);
      c.stroke();
    }
  }

  // 岸边的石头：一圈大小不一，前面的压在水边
  drawPondStones(A, rx, ry);
  // 芦苇丛：左后方
  drawReeds(A, x - rx * 0.78, y - ry * 0.35);
  if (has.has('jetty')) drawJetty(A, rx, ry);
}

function drawFish(c: CanvasRenderingContext2D, x: number, y: number, tw: number, dir: number, ice: boolean) {
  const body = ice ? withAlpha(W.fishIce, 0.65) : W.koi;
  c.fillStyle = body;
  c.beginPath();
  c.ellipse(x, y, tw * 0.045, tw * 0.018, 0, 0, Math.PI * 2);
  c.moveTo(x - dir * tw * 0.04, y);
  c.lineTo(x - dir * tw * 0.075, y - tw * 0.02);
  c.lineTo(x - dir * tw * 0.075, y + tw * 0.02);
  c.closePath();
  c.fill();
  if (!ice) dot(c, x + dir * tw * 0.01, y - tw * 0.004, tw * 0.009, W.koiSpot);
}

function drawDuck(c: CanvasRenderingContext2D, x: number, y: number, tw: number, dir: number) {
  c.fillStyle = W.duck;
  c.beginPath();
  c.ellipse(x, y, tw * 0.045, tw * 0.026, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = W.duckShade;
  c.beginPath();
  c.ellipse(x - dir * tw * 0.012, y + tw * 0.008, tw * 0.03, tw * 0.014, 0, 0, Math.PI * 2);
  c.fill();
  dot(c, x + dir * tw * 0.035, y - tw * 0.03, tw * 0.018, W.duckHead);
  c.fillStyle = W.beak;
  c.beginPath();
  c.moveTo(x + dir * tw * 0.05, y - tw * 0.034);
  c.lineTo(x + dir * tw * 0.072, y - tw * 0.028);
  c.lineTo(x + dir * tw * 0.05, y - tw * 0.024);
  c.closePath();
  c.fill();
}

const STONES = 11;

function drawPondStones(A: Area, rx: number, ry: number) {
  const { c, x, y, tw, snow } = A;
  // 石头彼此隔开，受光面、背光面、积雪各合成一条路径
  const lit = new Path2D();
  const dark = new Path2D();
  const cap = new Path2D();
  for (let k = 0; k < STONES; k++) {
    const a = (k / STONES) * Math.PI * 2 + 0.2;
    // 左后方是芦苇丛，空出来
    if (a > 3.3 && a < 3.95) continue;
    const s = 0.75 + rnd(k, 9) * 0.6;
    const sx = x + Math.cos(a) * rx * 1.02;
    const sy = y + Math.sin(a) * ry * 1.05;
    const w = tw * 0.04 * s;
    const h = tw * 0.026 * s;
    lit.moveTo(sx + w, sy);
    lit.ellipse(sx, sy, w, h, 0, 0, Math.PI * 2);
    dark.moveTo(sx + w * 0.3 + w * 0.62, sy + h * 0.25);
    dark.ellipse(sx + w * 0.3, sy + h * 0.25, w * 0.62, h * 0.6, 0, 0, Math.PI * 2);
    cap.moveTo(sx - w * 0.15 + w * 0.7, sy - h * 0.4);
    cap.ellipse(sx - w * 0.15, sy - h * 0.4, w * 0.7, h * 0.45, 0, 0, Math.PI * 2);
  }
  c.fillStyle = W.stone;
  c.fill(lit);
  c.fillStyle = W.stoneShade;
  c.fill(dark);
  if (snow) {
    c.fillStyle = SNOW;
    c.fill(cap);
  }
}

function drawReeds(A: Area, x: number, y: number) {
  const { c, tw, snow, t } = A;
  const sway = (k: number) => Math.sin(t * 1.2 + k) * tw * 0.006;
  c.strokeStyle = snow ? W.reedSnow : W.reed;
  c.lineCap = 'round';
  c.lineWidth = Math.max(0.6, tw * 0.013);
  c.beginPath();
  const stems: [number, number, number][] = [[-0.05, 0.16, -0.03], [-0.02, 0.21, -0.01], [0.01, 0.18, 0.015], [0.04, 0.14, 0.035], [0.07, 0.11, 0.05]];
  for (const [dx, h, lean] of stems) {
    c.moveTo(x + dx * tw, y);
    c.lineTo(x + (dx + lean) * tw + sway(dx * 50), y - h * tw);
  }
  c.stroke();
  // 两根香蒲
  c.fillStyle = W.cattail;
  for (const k of [1, 3]) {
    const [dx, h, lean] = stems[k];
    c.beginPath();
    c.ellipse(x + (dx + lean) * tw + sway(dx * 50), y - h * tw * 0.86, tw * 0.011, tw * 0.03, lean * 4, 0, Math.PI * 2);
    c.fill();
  }
  if (snow) for (const k of [1, 2]) dot(c, x + (stems[k][0] + stems[k][2]) * tw, y - stems[k][1] * tw, tw * 0.012, SNOW);
}

/** 小栈桥伸进水里，桥头斜插一根钓竿；结冰时桥面积雪，钓竿伸向冰洞 */
function drawJetty(A: Area, rx: number, ry: number) {
  const { c, x, y, tw, snow } = A;
  // 从右前方的岸边沿 -i 方向（屏幕左上）伸进水里
  const bx = x + rx * 0.62;
  const by = y + ry * 0.8;
  const ux = -tw * 0.21;
  const uy = -tw * 0.105;
  const wx = -tw * 0.035;
  const wy = tw * 0.0175;
  const deck: Pt[] = [
    [bx - wx, by - wy],
    [bx + ux - wx, by + uy - wy],
    [bx + ux + wx, by + uy + wy],
    [bx + wx, by + wy],
  ];
  // 桩
  c.fillStyle = W.post;
  for (const [px, py] of [deck[1], deck[2]]) c.fillRect(px - tw * 0.007, py, tw * 0.014, tw * 0.04);
  fillPoly(c, W.deckShade, deck.map(([px, py]) => [px, py + tw * 0.014] as Pt));
  fillPoly(c, snow ? SNOW : W.deck, deck);
  if (!snow) {
    c.strokeStyle = withAlpha(W.post, 0.45);
    c.lineWidth = Math.max(0.5, tw * 0.008);
    c.beginPath();
    for (const f of [0.33, 0.66]) {
      c.moveTo(bx + ux * f - wx, by + uy * f - wy);
      c.lineTo(bx + ux * f + wx, by + uy * f + wy);
    }
    c.stroke();
  }
  // 钓竿：桥头往外斜，一根线垂到浮漂
  const ex = bx + ux * 0.9;
  const ey = by + uy * 0.9;
  const tipX = ex - tw * 0.12;
  const tipY = ey - tw * 0.16;
  c.strokeStyle = W.rod;
  c.lineWidth = Math.max(0.6, tw * 0.011);
  c.beginPath();
  c.moveTo(ex, ey);
  c.lineTo(tipX, tipY);
  c.stroke();
  c.strokeStyle = withAlpha(W.line, 0.8);
  c.lineWidth = Math.max(0.4, tw * 0.005);
  c.beginPath();
  c.moveTo(tipX, tipY);
  c.lineTo(tipX - tw * 0.01, ey - tw * 0.005);
  c.stroke();
  dot(c, tipX - tw * 0.01, ey - tw * 0.005, tw * 0.012, W.bobber);
}

/* ---------------- 花园 ---------------- */

/** 花床里的格点（由后往前）：嫩芽 3×3，零星开花取其中几格，成片开花 4×4 */
const GRID3: readonly [number, number][] = [-0.15, 0, 0.15].flatMap((pj) => [-0.15, 0, 0.15].map((pi) => [pi, pj] as [number, number])).sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
const GRID4: readonly [number, number][] = [-0.18, -0.06, 0.06, 0.18].flatMap((pj) => [-0.18, -0.06, 0.06, 0.18].map((pi) => [pi, pj] as [number, number])).sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
/** 零星开花的那几格（GRID3 的序号） */
const SPARSE = new Set([1, 4, 6]);

function drawGarden(A: Area) {
  const { c, P, tw, has, snow } = A;
  fillPoly(c, snow ? G.grassSnow : G.grass, diamond(P, 0.46));
  // 后面两道篱笆先画，前面两道压在花床前面；花拱门立在正后方的门口，高出花床，衬着草地看得清
  drawFence(A, 'back');
  if (has.has('arch')) drawArch(A);
  // 抬高的花床：前沿露出一道床沿
  const bed = diamond(P, 0.27);
  fillPoly(c, G.bedEdge, bed.map(([px, py]) => [px, py + tw * 0.02] as Pt));
  fillPoly(c, snow ? G.bedSnow : G.bed, bed);
  if (!snow) {
    c.strokeStyle = withAlpha(G.bedEdge, 0.6);
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    for (const pj of [-0.09, 0.09]) {
      c.moveTo(...P(-0.24, pj));
      c.lineTo(...P(0.24, pj));
    }
    c.stroke();
  }
  if (has.has('sprouts')) drawGardenSprouts(A);
  if (has.has('sparse-bloom')) drawBlooms(A, GRID3.filter((_, k) => SPARSE.has(k)), GRID3.filter((_, k) => !SPARSE.has(k)));
  if (has.has('full-bloom')) drawBlooms(A, GRID4, []);
  drawFence(A, 'front');
  if (has.has('butterflies') && !snow) drawButterflies(A);
}

/** 篱笆：沿 0.41 的菱形一圈矮木桩加两道横杆，正后方的角留出门口 */
const FENCE_R = 0.41;
/** 后面两道篱笆从这里画起，正后方的角留作门口 */
const FENCE_GATE = 0.36;

type FenceSide = [Pt, Pt, number, number];
/** Share post/rail endpoints between drawFence() and the walker opaque masks. */
function gardenFenceSides(part: 'back' | 'front'): FenceSide[] {
  const r = FENCE_R;
  return part === 'back'
    ? [[[-r, -r], [r, -r], FENCE_GATE, 1], [[-r, -r], [-r, r], FENCE_GATE, 1]]
    : [[[r, -r], [r, r], 0, 1], [[-r, r], [r, r], 0, 1]];
}

function drawFence(A: Area, part: 'back' | 'front') {
  const { c, P, tw, snow } = A;
  const h = tw * 0.07;
  const sides = gardenFenceSides(part);
  c.lineCap = 'round';
  // 两道边的横杆、木桩、积雪各合成一条路径
  const rails = new Path2D();
  const posts = new Path2D();
  const snowTop = new Path2D();
  for (const [[ai, aj], [bi, bj], u0, u1] of sides) {
    const at = (u: number, z = 0) => P(ai + (bi - ai) * u, aj + (bj - aj) * u, z);
    for (const z of [h * 0.45, h * 0.85]) {
      rails.moveTo(...at(u0, z));
      rails.lineTo(...at(u1, z));
    }
    for (let k = 0; k <= 5; k++) {
      const u = u0 + ((u1 - u0) * k) / 5;
      posts.moveTo(...at(u));
      posts.lineTo(...at(u, h));
    }
    snowTop.moveTo(...at(u0, h * 0.85 + tw * 0.006));
    snowTop.lineTo(...at(u1, h * 0.85 + tw * 0.006));
  }
  c.strokeStyle = G.fenceShade;
  c.lineWidth = Math.max(0.6, tw * 0.012);
  c.stroke(rails);
  c.strokeStyle = G.fence;
  c.lineWidth = Math.max(0.7, tw * 0.016);
  c.stroke(posts);
  if (snow) {
    c.strokeStyle = SNOW;
    c.lineWidth = Math.max(0.6, tw * 0.012);
    c.stroke(snowTop);
  }
}

function drawGardenSprouts(A: Area) {
  const { c, P, tw, snow } = A;
  // 嫩芽要在手机全景下也看得出一点点绿：叶子画粗一些
  c.strokeStyle = snow ? G.dry : G.sprout;
  c.lineWidth = Math.max(0.8, tw * 0.022);
  c.lineCap = 'round';
  c.beginPath();
  for (const [pi, pj] of GRID3) {
    const [px, py] = P(pi, pj);
    c.moveTo(px, py);
    c.lineTo(px - tw * 0.022, py - tw * 0.045);
    c.moveTo(px, py);
    c.lineTo(px + tw * 0.022, py - tw * 0.045);
  }
  c.stroke();
}

/**
 * 花：bloom 里的格子开花，leaf 里的格子只有一丛叶子。冬天花都谢了，只剩枯茎和籽头，
 * 但疏密还在，看得出这里本来开着几朵还是一大片。
 */
function drawBlooms(A: Area, bloom: readonly [number, number][], leaf: readonly [number, number][]) {
  const { c, P, tw, snow } = A;
  const all = [...bloom.map((p) => [p, true] as const), ...leaf.map((p) => [p, false] as const)];
  const stemH = tw * 0.06;
  // 茎、叶、各色花瓣、花心各合成一条路径：花彼此隔开，不需要逐朵排前后
  const stems = new Path2D();
  const leaves = new Path2D();
  const heads: [number, number, number][] = [];
  const petals = new Map<string, Path2D>();
  const rr = tw * 0.022;
  for (const [[pi, pj], open] of all) {
    const [px, py] = P(pi, pj);
    for (const d of [-1, 0, 1]) {
      stems.moveTo(px, py);
      stems.lineTo(px + d * tw * 0.02, py - stemH * (d ? 0.8 : 1));
    }
    if (snow) {
      if (open) heads.push([px, py - stemH, tw * 0.014]);
      continue;
    }
    if (!open) {
      leaves.moveTo(px + tw * 0.03, py - stemH * 0.55);
      leaves.ellipse(px, py - stemH * 0.55, tw * 0.03, tw * 0.016, 0, 0, Math.PI * 2);
      continue;
    }
    const k = Math.round((pi + 0.2) * 31 + (pj + 0.2) * 17);
    const col = G.petals[k % G.petals.length];
    let path = petals.get(col);
    if (!path) petals.set(col, (path = new Path2D()));
    for (let p = 0; p < 4; p++) {
      const a = (Math.PI * 2 * p) / 4 + 0.4;
      path.moveTo(px + Math.cos(a) * rr + rr * 0.7, py - stemH + Math.sin(a) * rr * 0.7);
      path.arc(px + Math.cos(a) * rr, py - stemH + Math.sin(a) * rr * 0.7, rr * 0.7, 0, Math.PI * 2);
    }
    heads.push([px, py - stemH, rr * 0.45]);
  }
  c.strokeStyle = snow ? G.dry : G.stem;
  c.lineWidth = Math.max(0.6, tw * 0.012);
  c.stroke(stems);
  if (snow) {
    dots(c, heads, G.dryHead);
    return;
  }
  c.fillStyle = G.leaf;
  c.fill(leaves);
  for (const [col, path] of petals) {
    c.fillStyle = col;
    c.fill(path);
  }
  dots(c, heads, G.heart);
}

/** 花拱门：门口两根柱子撑起一道拱，爬满叶子和花 */
function drawArch(A: Area) {
  const { c, P, tw, snow } = A;
  // 门口在正后方的角：两道后篱笆从 36% 画起，柱子立在缺口两端
  const gate = -FENCE_R + 2 * FENCE_R * FENCE_GATE;
  const [lx, ly] = P(-FENCE_R, gate);
  const [rx, ry] = P(gate, -FENCE_R);
  const h = tw * 0.24;
  const mx = (lx + rx) / 2;
  const my = (ly + ry) / 2;
  const span = Math.hypot(rx - lx, ry - ly) / 2;
  c.strokeStyle = G.arch;
  c.lineCap = 'round';
  c.lineWidth = Math.max(0.8, tw * 0.016);
  c.beginPath();
  c.moveTo(lx, ly);
  c.lineTo(lx, ly - h);
  c.moveTo(rx, ry);
  c.lineTo(rx, ry - h);
  c.moveTo(lx, ly - h);
  c.quadraticCurveTo(mx, my - h - span * 1.1, rx, ry - h);
  c.stroke();
  // 叶子和花沿着拱
  const along = (u: number): Pt => {
    // 二次贝塞尔上的点
    const ax = lx;
    const ay = ly - h;
    const cx = mx;
    const cy = my - h - span * 1.1;
    const bx = rx;
    const by = ry - h;
    const v = 1 - u;
    return [v * v * ax + 2 * v * u * cx + u * u * bx, v * v * ay + 2 * v * u * cy + u * u * by];
  };
  const leaves: Pt[] = [];
  for (let k = 0; k <= 8; k++) leaves.push(along(k / 8));
  for (let k = 0; k < 3; k++) {
    leaves.push([lx, ly - h * (0.3 + k * 0.25)]);
    leaves.push([rx, ry - h * (0.3 + k * 0.25)]);
  }
  c.fillStyle = snow ? SNOW_SHADE : G.archLeaf;
  c.beginPath();
  for (const [px, py] of leaves) {
    c.moveTo(px + tw * 0.022, py);
    c.arc(px, py, tw * 0.022, 0, Math.PI * 2);
  }
  c.fill();
  if (snow) {
    c.fillStyle = SNOW;
    c.beginPath();
    for (let k = 1; k < 8; k++) {
      const [px, py] = along(k / 8);
      c.moveTo(px + tw * 0.02, py - tw * 0.01);
      c.arc(px, py - tw * 0.01, tw * 0.02, 0, Math.PI * 2);
    }
    c.fill();
    return;
  }
  leaves.forEach(([px, py], k) => {
    if (k % 2 === 0) dot(c, px + tw * 0.006, py - tw * 0.008, tw * 0.017, G.archBloom[(k / 2) % G.archBloom.length]);
  });
}

/** 两只蝴蝶在花床上方绕着飞；减弱动态效果时停在花上 */
function drawButterflies(A: Area) {
  const { c, P, tw, t } = A;
  for (let k = 0; k < 2; k++) {
    const a = t * 0.7 + k * Math.PI;
    const [bx, by] = P(Math.cos(a) * 0.16, Math.sin(a) * 0.16, tw * (0.13 + 0.03 * Math.sin(t * 1.3 + k)));
    const flap = t ? 0.45 + 0.55 * Math.abs(Math.sin(t * 9 + k * 1.7)) : 1;
    const col = G.butterfly[k ? 2 : 0];
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(bx - tw * 0.014 * flap, by, tw * 0.016 * flap, tw * 0.012, -0.4, 0, Math.PI * 2);
    c.ellipse(bx + tw * 0.014 * flap, by, tw * 0.016 * flap, tw * 0.012, 0.4, 0, Math.PI * 2);
    c.fill();
    dot(c, bx, by, tw * 0.005, G.butterfly[1]);
  }
}

/* ---------------- 入口 ---------------- */

export function drawCultivationArea(
  c: CanvasRenderingContext2D,
  area: CultivationAreaState,
  x: number,
  y: number,
  tw: number,
  cover: number,
  t: number,
  calm = false,
) {
  c.save();
  const P: Iso = (pi, pj, z = 0) => [x + ((pi - pj) * tw) / 2, y + ((pi + pj) * tw) / 4 - z];
  const A: Area = { c, P, x, y, tw, has: cultivationElements(area.kind, area.level), snow: cover > 0.6, t: calm ? 0 : t };
  if (area.kind === 'field') drawField(A);
  else if (area.kind === 'orchard') drawOrchard(A);
  else if (area.kind === 'pond') drawPond(A);
  else drawGarden(A);
  c.restore();
}

/**
 * 遮挡与点击用的外框（地块宽的倍数）：half 半宽，above 落地点以上的高度，below 以下。
 * 与上面的绘制同一组尺寸：果园看树冠、农田看稻草人、花园看拱门、鱼塘看芦苇和钓竿。
 */
export function cultivationExtent(kind: CultivationKind, level: number): { half: number; above: number; below: number } {
  const has = cultivationElements(kind, level);
  if (kind === 'field') return { half: 0.5, above: has.has('scarecrow') ? 0.4 : has.has('crop-half') || has.has('crop-gold') ? 0.3 : 0.26, below: 0.24 };
  if (kind === 'orchard') return { half: 0.47, above: has.has('grown-trees') ? 0.47 : 0.4, below: 0.24 };
  if (kind === 'pond') return { half: 0.49, above: 0.3, below: 0.25 };
  return { half: 0.47, above: has.has('arch') ? 0.56 : 0.28, below: 0.24 };
}

/** Broad, backwards-compatible click and inspection target; NOT a solid occlusion mask. */
export function cultivationOutline(
  area: CultivationAreaState,
  x: number,
  y: number,
  tw: number,
): [number, number][] {
  const { half, above, below } = cultivationExtent(area.kind, area.level);
  return [
    [x - tw * half, y + tw * below],
    [x + tw * half, y + tw * below],
    [x + tw * half, y - tw * above],
    [x - tw * half, y - tw * above],
  ];
}


/**
 * 真实物体的不透明轮廓（只供小人遮挡判断）。
 * 点击/检查继续使用 cultivationOutline() 的宽松矩形，包括旧版本能点到的边缘。
 * 地块本体按画出来的菱形/椭圆；高出地面的装饰只挡住实际茎、树冠、芦苇或花拱门附近。
 */
export function cultivationOcclusionOutlines(
  area: CultivationAreaState,
  x: number,
  y: number,
  tw: number,
  snow = false,
): Pt[][] {
  const P: Iso = (pi, pj, z = 0) => [x + ((pi - pj) * tw) / 2, y + ((pi + pj) * tw) / 4 - z];
  const box = (cx: number, cy: number, half: number, above: number, below = 0): Pt[] => [
    [cx - half, cy + below], [cx + half, cy + below],
    [cx + half, cy - above], [cx - half, cy - above],
  ];
  const has = cultivationElements(area.kind, area.level);

  if (area.kind === 'pond') {
    // 水面和岸石的圆形外框；左后方高出的芦苇单独保留。
    const water: Pt[] = Array.from({ length: 16 }, (_, k): Pt => {
      const a = (k * Math.PI * 2) / 16;
      return [x + Math.cos(a) * tw * (POND_RX + 0.05), y + Math.sin(a) * tw * (POND_RY + 0.04)];
    });
    return [
      water,
      box(x - tw * POND_RX * 0.78, y - tw * POND_RY * 0.35, tw * 0.09, tw * 0.24, tw * 0.02),
    ];
  }

  const outlines: Pt[][] = [diamond(P, area.kind === 'field' ? 0.47 : 0.46)];
  if (area.kind === 'field') {
    const crop = fieldCrop(has);
    if (crop) {
      const { height, band } = cropMetrics(crop, tw, snow);
      const withStalks = crop !== 'sprout' || snow;
      // Painted rows use a continuous colour band, with narrow individual stems/ears above it.
      // An entire raised rectangle would block walkers visible in the gaps between rows.
      for (const pj of FIELD_ROWS) {
        outlines.push(strokeOutline(
          P(-0.31, pj, height * 0.55),
          P(0.31, pj, height * 0.55),
          Math.max(0.8, band) + tw * 0.006,
        ));
        if (!withStalks) continue;
        for (let pi = -0.3; pi <= 0.31; pi += 0.075) {
          const [px, py] = P(pi, pj);
          const ear = !snow && (crop === 'ripe' || crop === 'gold');
          const lean = ear && crop === 'gold' ? tw * 0.016 : 0;
          outlines.push(strokeOutline(
            [px, py],
            [px + lean, py - height - (ear ? tw * 0.014 : 0)],
            tw * (ear ? 0.05 : 0.047),
          ));
        }
      }
    }
    if (has.has('scarecrow')) {
      const [sx, sy] = P(0.06, -0.12);
      outlines.push(box(sx, sy, tw * 0.115, tw * 0.38));
    }
  } else if (area.kind === 'orchard') {
    // 四棵树与 drawOrchard() 使用相同落点；树冠长高，但树与树间仍可点到可见小人。
    const size = has.has('grown-trees') ? 2 : has.has('young-trees') ? 1 : 0;
    const half = tw * [0.05, 0.08, 0.135][size];
    const above = tw * [0.23, 0.27, 0.38][size];
    for (const [pi, pj] of ORCHARD_TREES) {
      const [tx, ty] = P(pi, pj);
      outlines.push(box(tx, ty, half, above, tw * 0.015));
    }
  } else if (has.has('arch')) {
    // 与 drawArch() 的柱子及二次贝塞尔拱顶共享 FENCE_R、FENCE_GATE 和 0.24 高度。
    // 拱顶是窄曲线，不是宽 0.94 格的实心墙；两侧高处的空白不能挡住行人。
    const gate = -FENCE_R + 2 * FENCE_R * FENCE_GATE;
    const [lx, ly] = P(-FENCE_R, gate);
    const [rx, ry] = P(gate, -FENCE_R);
    const h = tw * 0.24;
    const midX = (lx + rx) / 2;
    const midY = (ly + ry) / 2;
    const span = Math.hypot(rx - lx, ry - ly) / 2;
    const pad = tw * 0.03;
    outlines.push(box(lx, ly, pad, h + pad, tw * 0.015));
    outlines.push(box(rx, ry, pad, h + pad, tw * 0.015));
    const archPoint = (u: number): Pt => {
      const v = 1 - u;
      return [
        v * v * lx + 2 * v * u * midX + u * u * rx,
        v * v * (ly - h) + 2 * v * u * (midY - h - span * 1.1) + u * u * (ry - h),
      ];
    };
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = archPoint(k / 4);
      const [bx, by] = archPoint((k + 1) / 4);
      outlines.push([
        [Math.min(ax, bx) - pad, Math.max(ay, by) + pad],
        [Math.max(ax, bx) + pad, Math.max(ay, by) + pad],
        [Math.max(ax, bx) + pad, Math.min(ay, by) - pad],
        [Math.min(ax, bx) - pad, Math.min(ay, by) - pad],
      ]);
    }
  }

  if (area.kind === 'garden') {
    // Fence exists at EVERY level (not just level 4 with an arch).
    // Match the four painted sides, each pair of rails and each of six posts,
    // rather than marking the empty air above the whole garden as opaque.
    const h = tw * 0.07;
    for (const part of ['back', 'front'] as const) {
      for (const [[ai, aj], [bi, bj], u0, u1] of gardenFenceSides(part)) {
        const at = (u: number, z = 0): Pt =>
          P(ai + (bi - ai) * u, aj + (bj - aj) * u, z);
        for (const z of [h * 0.45, h * 0.85]) {
          outlines.push(strokeOutline(
            at(u0, z), at(u1, z),
            Math.max(0.6, tw * 0.012) + tw * 0.004,
          ));
        }
        for (let k = 0; k <= 5; k++) {
          const u = u0 + ((u1 - u0) * k) / 5;
          outlines.push(strokeOutline(
            at(u), at(u, h),
            Math.max(0.7, tw * 0.016) + tw * 0.004,
          ));
        }
      }
    }
  }
  return outlines;
}
