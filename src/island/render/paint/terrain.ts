import type { Scene } from '../model';
import { tileHash, type Tile } from '../../map';
import { BEACH, pineTiers, roundLobes, SNOW, WARM } from '../style';
import { clamp, hash, mix, shade } from '../utils';
import { IslandPaintBase } from './base';

/** 双线性插值的格点噪声，返回 0–1；scale 越大起伏越缓。 */
export function smoothNoise(i: number, j: number, scale: number, salt = 7): number {
  const u = i / scale;
  const w = j / scale;
  const i0 = Math.floor(u);
  const j0 = Math.floor(w);
  const fu = u - i0;
  const fw = w - j0;
  const su = fu * fu * (3 - 2 * fu);
  const sw = fw * fw * (3 - 2 * fw);
  const a = tileHash(i0, j0, salt);
  const b = tileHash(i0 + 1, j0, salt);
  const c = tileHash(i0, j0 + 1, salt);
  const d = tileHash(i0 + 1, j0 + 1, salt);
  return a + (b - a) * su + (c - a) * sw + (a - b - c + d) * su * sw;
}

/** Ground cache, sea, vegetation, mountains, and water-bound scenery. */
export abstract class IslandTerrainPainter extends IslandPaintBase {
  protected palette() {
    const { season: se, progress: p } = this.amb;
    const grass = [mix('#b6d27c', '#9cc464', p), mix('#8fb855', '#86ad4f', p), mix('#b3b65f', '#c7a85a', p), '#b2ad88'][se];
    const field = [mix('#b9cf7a', '#9fc35e', p), mix('#c2c45a', '#dcbc4c', p), mix('#e3ad45', '#c7a26c', p), '#b5a382'][se];
    return { grass, field };
  }

  protected tileTop(t: Tile, occupied: Set<number>): string {
    const { grass, field } = this.palette();
    const a = this.amb;
    let col: string;
    switch (t.type) {
      case 'grass':
        col = grass;
        break;
      case 'forest':
        col = shade(grass, -0.12);
        break;
      case 'field':
        col = field;
        break;
      case 'water':
        col = a.cover > 0.6 ? '#cfe2ea' : a.season === 3 ? '#9cc4d2' : '#7db3c7';
        break;
      case 'mountain':
        col = '#a3a68f';
        break;
      case 'plaza':
        col = t.village >= 0 && !occupied.has(t.village) ? grass : '#e4d8b8';
        break;
      default:
        col = '#e6d6a8';
    }
    // 低频的明暗起伏代替逐格随机：相邻地块颜色连成一片，不再像棋盘。
    col = shade(col, (smoothNoise(t.i, t.j, 4.5) - 0.5) * (t.type === 'water' ? 0.05 : 0.12));
    if (a.cover > 0 && t.type !== 'water') col = mix(col, SNOW, clamp(a.cover * (0.86 + 0.18 * smoothNoise(t.i, t.j, 3.5, 41)), 0, 0.92));
    if (a.weather === 'rain') col = shade(col, -0.06);
    return col;
  }

  protected drawGround(s: Scene) {
    const v = this.view;
    const m = this.map;
    const a = this.amb;
    const occupied = new Set(s.villages.map((x) => x.slot));
    const key = [v.w, v.h, v.dpr, v.tw, v.ox, v.oy, m.rings, a.season, a.progress.toFixed(2), a.cover.toFixed(2), a.weather, s.villages.map((x) => `${x.slot}:${x.houses}`).join(','), this.theme.sea].join('|');
    if (key === this.groundKey) return;
    this.groundKey = key;
    const g = this.ground;
    g.width = this.canvas.width;
    g.height = this.canvas.height;
    const gc = g.getContext('2d')!;
    const main = this.ctx;
    this.ctx = gc;
    gc.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    gc.clearRect(0, 0, v.w, v.h);
    const { tw } = v;
    const hw = tw / 2;
    const hh = tw / 4;
    const D = tw * 0.32;
    const lw = Math.max(0.6, tw * 0.025);
    // 岛背后的礁石先画，会被崖壁挡住一部分
    this.drawShoreRocks(true);
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      const col = this.tileTop(t, occupied);
      const wat = t.type === 'water';
      const beach = this.isBeach(t);
      // 崖壁：灰色岩石，几道横向岩层和竖向裂缝，顶上一圈草皮（沙滩处是沙，冬天是雪）
      const lip = a.cover > 0.3 ? SNOW : beach ? BEACH : shade(col, -0.08);
      const rock = shade('#a39b8b', (smoothNoise(t.i, t.j, 3, 21) - 0.5) * 0.16);
      const front = !m.at(t.i, t.j + 1);
      const right = !m.at(t.i + 1, t.j);
      if (front) {
        this.poly(wat ? '#5f93a8' : rock, x - hw, y, x, y + hh, x, y + hh + D, x - hw, y + D);
        if (!wat) this.cliffDetail(t, x - hw, y, x, y + hh, D, rock, lip, 0);
      }
      if (right) {
        this.poly(wat ? '#4f8197' : shade(rock, -0.16), x, y + hh, x + hw, y, x + hw, y + D, x, y + hh + D);
        if (!wat) this.cliffDetail(t, x, y + hh, x + hw, y, D, shade(rock, -0.16), shade(lip, -0.12), 1);
      }
      // 地块顶面：北角略亮、南角略暗
      const grd = gc.createLinearGradient(x, y - hh, x, y + hh);
      grd.addColorStop(0, shade(col, 0.015));
      grd.addColorStop(1, shade(col, -0.015));
      this.poly(col, x, y - hh - 0.4, x + hw + 0.5, y, x, y + hh + 0.4, x - hw - 0.5, y);
      gc.fillStyle = grd;
      gc.fill();
      this.tileDetail(t, t.type === 'plaza' && t.village >= 0 && !occupied.has(t.village) ? 'grass' : t.type, x, y, col, lw);
      if (beach || (t.type === 'grass' && this.sandNeighbour(t))) this.drawBeach(t, x, y, beach);
    }
    // 岛前面的礁石压在崖脚的水线上
    this.drawShoreRocks(false);
    // 村里的小路：广场通向每座房子
    gc.lineCap = 'round';
    gc.lineJoin = 'round';
    const path = mix(this.palette().grass, '#d9c79c', 0.7);
    for (const vv of s.villages) {
      const site = m.villages[vv.slot];
      const [cx, cy] = this.iso(site.center.i, site.center.j);
      gc.strokeStyle = a.cover > 0.3 ? mix(path, SNOW, 0.45) : path;
      gc.lineWidth = tw * 0.09;
      gc.beginPath();
      for (const sl of site.slots.slice(0, vv.houses)) {
        const [x, y] = this.iso(sl.i, sl.j);
        gc.moveTo(cx, cy);
        gc.quadraticCurveTo((cx + x) / 2 + (sl.v - 0.5) * tw * 0.3, (cy + y) / 2, x, y + hh * 0.35);
      }
      gc.stroke();
    }
    this.ctx = main;
  }

  /** 沙滩：外圈的草地里，低频噪声挑出几段连续的岸线铺沙，避开村落、地标和码头 */
  protected isBeach(t: Tile): boolean {
    if (!t.edge || t.type !== 'grass' || t.village >= 0 || t.landmark >= 0) return false;
    const m = this.map;
    if (t === m.dock || t === m.granary || t === m.chores || t === m.lighthouse) return false;
    // 紧挨码头沙地的岸边也铺沙，让沙滩连成一段
    return this.sandNeighbour(t) || smoothNoise(t.i, t.j, 4, 13) > 0.58;
  }

  protected sandNeighbour(t: Tile): boolean {
    const m = this.map;
    return [m.at(t.i + 1, t.j), m.at(t.i - 1, t.j), m.at(t.i, t.j + 1), m.at(t.i, t.j - 1)].some((n) => n?.type === 'sand');
  }

  /**
   * 沿露出海面的边铺一条宽窄不一的沙带，内侧边缘是波浪形的。
   * 挨着整块沙地的边也铺一窄条，让沙地和草地的交界不再是一道直角台阶。
   */
  protected drawBeach(t: Tile, x: number, y: number, shore: boolean) {
    const m = this.map;
    const { tw } = this.view;
    const hw = tw / 2;
    const hh = tw / 4;
    const c = this.ctx;
    const a = this.amb;
    const sand = a.cover > 0.3 ? mix(BEACH, SNOW, clamp(a.cover, 0, 0.85)) : BEACH;
    // 四条边：两端点 + 指向地块内部的单位位移（屏幕坐标）
    const L: [number, number] = [x - hw, y];
    const B: [number, number] = [x, y + hh];
    const R: [number, number] = [x + hw, y];
    const T: [number, number] = [x, y - hh];
    const edges: [Tile | null, [number, number], [number, number], [number, number], number][] = [
      [m.at(t.i, t.j + 1), L, B, [hw, -hh], 0],
      [m.at(t.i + 1, t.j), B, R, [-hw, -hh], 1],
      [m.at(t.i - 1, t.j), L, T, [hw, hh], 2],
      [m.at(t.i, t.j - 1), T, R, [-hw, hh], 3],
    ];
    for (const [n, p0, p1, [ix, iy], k] of edges) {
      const sea = !n;
      if (sea ? !shore : n.type !== 'sand') continue;
      const base = sea ? 0.22 : 0.1;
      const w0 = base + tileHash(t.i, t.j, 80 + k) * 0.22;
      const w1 = base + tileHash(t.i + (k % 2 ? 1 : 0), t.j + (k % 2 ? 0 : 1), 80 + k) * 0.22;
      const mid = (w0 + w1) / 2 + 0.08;
      c.fillStyle = sand;
      c.beginPath();
      c.moveTo(p0[0], p0[1]);
      c.lineTo(p1[0], p1[1]);
      c.lineTo(p1[0] + ix * w1, p1[1] + iy * w1);
      c.quadraticCurveTo((p0[0] + p1[0]) / 2 + ix * mid, (p0[1] + p1[1]) / 2 + iy * mid, p0[0] + ix * w0, p0[1] + iy * w0);
      c.closePath();
      c.fill();
      if (!sea) continue;
      // 湿沙：靠水的一窄条略深
      c.strokeStyle = shade(sand, -0.1);
      c.lineWidth = Math.max(0.6, tw * 0.03);
      c.beginPath();
      c.moveTo(p0[0] + ix * 0.04, p0[1] + iy * 0.04);
      c.lineTo(p1[0] + ix * 0.04, p1[1] + iy * 0.04);
      c.stroke();
      if (a.cover < 0.3 && tileHash(t.i, t.j, 90 + k) < 0.4) {
        const u = 0.3 + tileHash(t.i, t.j, 94 + k) * 0.4;
        this.dot(p0[0] + (p1[0] - p0[0]) * u + ix * 0.15, p0[1] + (p1[1] - p0[1]) * u + iy * 0.15, tw * 0.022, '#f6efe2');
      }
    }
  }

  /** 崖壁细节：两道岩层、几道竖向裂缝、顶上的草皮 / 沙 / 雪 */
  protected cliffDetail(t: Tile, x0: number, y0: number, x1: number, y1: number, D: number, rock: string, lip: string, side: number) {
    const c = this.ctx;
    const { tw } = this.view;
    const at = (u: number, d: number): [number, number] => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + d];
    // 岩层：深浅两道，位置随地块略有起伏
    const b0 = 0.42 + tileHash(t.i, t.j, 100 + side) * 0.12;
    const b1 = b0 + 0.14;
    const [s0x, s0y] = at(0, D * b0);
    const [s1x, s1y] = at(1, D * (b0 + (tileHash(t.i, t.j, 102 + side) - 0.5) * 0.12));
    this.poly(shade(rock, -0.1), s0x, s0y, s1x, s1y, s1x, s1y + D * (b1 - b0), s0x, s0y + D * (b1 - b0));
    // 竖向裂缝：把崖壁分成不等宽的岩块
    c.strokeStyle = shade(rock, -0.24);
    c.lineWidth = Math.max(0.5, tw * 0.012);
    c.beginPath();
    const n = 1 + Math.floor(tileHash(t.i, t.j, 104 + side) * 2);
    for (let k = 0; k < n; k++) {
      const u = 0.2 + tileHash(t.i, t.j, 106 + side * 4 + k) * 0.6;
      const [cx, cy] = at(u, D * 0.22);
      c.moveTo(cx, cy);
      c.lineTo(cx + tw * 0.015, cy + D * 0.35);
      c.lineTo(cx - tw * 0.005, cy + D * 0.7);
    }
    c.stroke();
    // 顶边：草皮略微垂下崖口，厚度不一
    const d0 = D * (0.12 + tileHash(t.i, t.j, 110 + side) * 0.1);
    const d1 = D * (0.12 + tileHash(t.i, t.j, 111 + side) * 0.1);
    const [mx, my] = at(0.5, D * 0.26);
    c.fillStyle = lip;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.lineTo(x1, y1 + d1);
    c.quadraticCurveTo(mx, my, x0, y0 + d0);
    c.closePath();
    c.fill();
  }

  /**
   * 水里的礁石：只在部分露出的海岸边放一两块，大小不一。
   * back = true 画岛背后（上方两条边）的，会被随后画的崖壁挡住。
   */
  protected drawShoreRocks(back: boolean) {
    const m = this.map;
    const { tw } = this.view;
    const hw = tw / 2;
    const hh = tw / 4;
    const D = tw * 0.32;
    const a = this.amb;
    for (const t of m.all) {
      if (!t.edge || t.type === 'water' || t === m.dock) continue;
      const [x, y] = this.iso(t.i, t.j);
      const sides: [boolean, number, number, number][] = back
        ? [
            [!m.at(t.i - 1, t.j), -1, 0, 2],
            [!m.at(t.i, t.j - 1), 0, -1, 3],
          ]
        : [
            [!m.at(t.i, t.j + 1), 0, 1, 0],
            [!m.at(t.i + 1, t.j), 1, 0, 1],
          ];
      for (const [open, di, dj, k] of sides) {
        if (!open || tileHash(t.i, t.j, 120 + k) > 0.3) continue;
        const u = tileHash(t.i, t.j, 124 + k) - 0.5;
        const out = 0.72 + tileHash(t.i, t.j, 128 + k) * 0.35;
        // 沿边偏移 u，向外 out；落在水线（崖脚）高度
        const ri = di ? di * out : u * 0.8;
        const rj = dj ? dj * out : u * 0.8;
        const rx = x + (ri - rj) * hw;
        // 岛前面的崖壁露在外面，水线在崖脚（+D）；岛背后看不到崖壁，水线就是顶面的边（浪花也这样画）
        const ry = y + (ri + rj) * hh + (back ? 0 : D);
        const r = tw * (0.12 + tileHash(t.i, t.j, 132 + k) * 0.13);
        this.drawRock(rx, ry, r, tileHash(t.i, t.j, 136 + k), a.cover);
        if (tileHash(t.i, t.j, 140 + k) < 0.5) this.drawRock(rx + r * 1.2, ry + r * 0.25, r * 0.55, tileHash(t.i, t.j, 144 + k), a.cover);
      }
    }
  }

  /** 一簇圆润的礁石：两三块高矮不一的石头，左上受光、右侧背光 */
  protected drawRock(x: number, y: number, r: number, seed: number, cover: number) {
    const c = this.ctx;
    // 水线上一圈白沫
    c.fillStyle = 'rgba(255,255,255,.45)';
    c.beginPath();
    c.ellipse(x + r * 0.2, y, r * 1.45, r * 0.42, 0, 0, Math.PI * 2);
    c.fill();
    const stones: [number, number, number][] = [
      [-0.45, -0.05, 0.6 + seed * 0.25],
      [0.35, 0.05, 0.8 + (1 - seed) * 0.35],
      [0.95, 0.12, 0.45],
    ];
    if (seed < 0.4) stones.pop();
    stones.sort((a, b) => a[1] - b[1]);
    for (const [ox, oy, k] of stones) {
      const sx = x + ox * r;
      const sy = y + oy * r;
      const w = r * 0.62 * k;
      const h = r * 0.95 * k;
      // 底宽顶窄的圆角块：受光面
      c.fillStyle = cover > 0.3 ? '#9b968c' : '#8f887b';
      c.beginPath();
      c.moveTo(sx - w, sy);
      c.quadraticCurveTo(sx - w * 1.05, sy - h * 0.7, sx - w * 0.35, sy - h);
      c.quadraticCurveTo(sx + w * 0.3, sy - h * 1.08, sx + w * 0.7, sy - h * 0.62);
      c.quadraticCurveTo(sx + w * 1.05, sy - h * 0.25, sx + w, sy);
      c.closePath();
      c.fill();
      // 背光面
      c.fillStyle = '#6f695f';
      c.beginPath();
      c.moveTo(sx + w * 0.05, sy);
      c.quadraticCurveTo(sx + w * 0.2, sy - h * 0.6, sx + w * 0.7, sy - h * 0.62);
      c.quadraticCurveTo(sx + w * 1.05, sy - h * 0.25, sx + w, sy);
      c.closePath();
      c.fill();
      // 顶上的高光或积雪
      c.fillStyle = cover > 0.3 ? SNOW : '#a9a294';
      c.beginPath();
      c.ellipse(sx - w * 0.3, sy - h * 0.82, w * 0.38, h * 0.14, -0.2, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 地块上的小细节：草丛、野花、落叶、田垄、石板、沙粒 */

  protected tileDetail(t: Tile, kind: Tile['type'], x: number, y: number, col: string, lw: number) {
    const c = this.ctx;
    const { tw } = this.view;
    const hw = tw / 2;
    const hh = tw / 4;
    const a = this.amb;
    const h = (k: number) => tileHash(t.i, t.j, 50 + k);
    // 菱形内的一个随机点
    const pt = (k: number): [number, number] => {
      const u = h(k * 2) - 0.5;
      const w = h(k * 2 + 1) - 0.5;
      return [x + (u - w) * hw * 0.85, y + (u + w) * hh * 0.85];
    };
    const snowy = a.cover > 0.5;
    if (kind === 'grass' || kind === 'forest') {
      // 草丛：积雪厚的时候只在少数地方露出来
      // 草丛成簇出现：低频噪声决定一片地的茂密程度，有的地块光秃，有的长一丛
      const lush = smoothNoise(t.i, t.j, 3, 9) + (kind === 'forest' ? 0.25 : 0);
      const n = Math.floor(lush * (a.season === 1 ? 4 : 3) + h(31) * 0.9 - 0.6);
      if (n > 0 && (!snowy || h(30) > a.cover)) {
        c.strokeStyle = shade(col, a.season === 1 ? -0.18 : -0.12);
        c.lineWidth = lw;
        c.beginPath();
        for (let k = 0; k < n; k++) {
          const [px, py] = pt(k);
          const ht = tw * (a.season === 1 ? 0.09 : 0.06) * (0.65 + h(32 + k) * 0.6);
          for (const d of [-1, 0, 1]) {
            c.moveTo(px, py);
            c.lineTo(px + d * tw * 0.035, py - ht * (d ? 0.75 : 1));
          }
        }
        c.stroke();
      }
      if (a.season === 0 && h(40) < 0.32) {
        const cols = ['#f7c6d4', '#ffffff', '#f6dc6b', '#c9b3f0'];
        for (let k = 0; k < 1 + Math.floor(h(41) * 3); k++) {
          const [px, py] = pt(5 + k);
          this.dot(px, py, tw * 0.022, cols[Math.floor(h(42 + k) * cols.length)]);
        }
      } else if (a.season === 1 && h(40) < 0.18) {
        const [px, py] = pt(5);
        this.dot(px, py, tw * 0.025, h(43) < 0.5 ? '#f6dc6b' : '#ffffff');
      } else if (a.season === 2 && (kind === 'forest' || h(40) < 0.4)) {
        const cols = ['#d9782a', '#c4532e', '#e2b13c', '#a8432a'];
        const n = (kind === 'forest' ? 3 : 1) + Math.floor(a.progress * 3);
        for (let k = 0; k < n; k++) {
          const [px, py] = pt(5 + k);
          c.fillStyle = cols[Math.floor(h(44 + k) * cols.length)];
          c.beginPath();
          c.ellipse(px, py, tw * 0.035, tw * 0.018, h(46 + k) * 3, 0, Math.PI * 2);
          c.fill();
        }
      } else if (snowy && h(40) < 0.3) {
        const [px, py] = pt(5);
        this.dot(px, py, tw * 0.02, '#ffffff');
      }
    } else if (kind === 'field') {
      // 田垄：春天是一行行小苗，夏天是长高的庄稼，秋天是金黄的穗子或收割后的茬，冬天被雪盖住
      const rows = 4;
      for (let k = 1; k < rows; k++) {
        const f = k / rows;
        const x0 = x - hw * f;
        const y0 = y - hh + hh * f;
        const x1 = x + hw - hw * f;
        const y1 = y + hh * f;
        c.strokeStyle = shade(col, -0.16);
        c.lineWidth = lw;
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
        c.stroke();
        if (snowy) continue;
        const crop = a.season === 0 ? '#6f9c3f' : a.season === 1 ? '#5f8f34' : a.season === 2 && a.progress < 0.5 ? '#d8a332' : '#a88a5a';
        const tall = a.season === 1 ? 0.12 : a.season === 2 && a.progress < 0.5 ? 0.1 : 0.05;
        c.strokeStyle = crop;
        c.lineWidth = Math.max(0.8, tw * (a.season === 1 ? 0.035 : 0.028));
        c.beginPath();
        for (let q = 1; q < 5; q++) {
          const px = x0 + ((x1 - x0) * q) / 5;
          const py = y0 + ((y1 - y0) * q) / 5;
          c.moveTo(px, py);
          c.lineTo(px, py - tw * tall);
        }
        c.stroke();
      }
      // 秋天收割后堆着草垛
      if (a.season === 2 && a.progress >= 0.5 && h(47) < 0.6) {
        const [px, py] = pt(6);
        this.shadow(px + tw * 0.02, py, tw * 0.08, tw * 0.03, 0.18);
        this.poly('#d8b25a', px - tw * 0.07, py, px, py - tw * 0.13, px + tw * 0.07, py);
        this.poly('#b8913f', px, py - tw * 0.13, px + tw * 0.07, py, px, py + tw * 0.015);
      }
    } else if (kind === 'plaza') {
      // 石板
      c.strokeStyle = shade(col, -0.1);
      c.lineWidth = Math.max(0.5, tw * 0.015);
      c.beginPath();
      for (let k = 1; k < 3; k++) {
        const f = k / 3;
        c.moveTo(x - hw * f, y - hh + hh * f);
        c.lineTo(x + hw - hw * f, y + hh * f);
        c.moveTo(x + hw * f, y - hh + hh * f);
        c.lineTo(x - hw + hw * f, y + hh * f);
      }
      c.stroke();
    } else if (kind === 'sand') {
      for (let k = 0; k < 4; k++) {
        const [px, py] = pt(k);
        this.dot(px, py, tw * 0.015, shade(col, k % 2 ? -0.12 : 0.15));
      }
      if (h(48) < 0.35) {
        const [px, py] = pt(5);
        this.dot(px, py, tw * 0.03, '#f4ead8');
      }
    } else if (kind === 'mountain') {
      for (let k = 0; k < 3; k++) {
        const [px, py] = pt(k);
        this.dot(px, py, tw * 0.03, shade(col, -0.15));
      }
    }
  }

  /* ---------------- 海 ---------------- */

  protected drawSea() {
    const v = this.view;
    const c = this.ctx;
    const m = this.map;
    const { tw } = v;
    const hw = tw / 2;
    const hh = tw / 4;
    const D = tw * 0.32;
    const a = this.amb;
    const g = c.createLinearGradient(0, 0, 0, v.h);
    g.addColorStop(0, shade(this.theme.seaDeep, 0.02));
    g.addColorStop(0.5, this.theme.sea);
    g.addColorStop(1, shade(this.theme.sea, 0.06));
    c.fillStyle = g;
    c.fillRect(0, 0, v.w, v.h);
    // 远处的波纹
    c.strokeStyle = `rgba(255,255,255,${a.weather === 'rain' ? 0.22 : 0.35})`;
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 0; k < 40; k++) {
      const bx = hash('wx' + k) * v.w;
      const by = hash('wy' + k) * v.h;
      const len = 8 + hash('wl' + k) * 14;
      const off = Math.sin(this.t * 0.6 + k) * 6;
      c.moveTo(bx + off, by);
      c.quadraticCurveTo(bx + off + len / 2, by - 3, bx + off + len, by);
    }
    c.stroke();
    // 岛周围的浅水：合成一个路径，避免半透明叠加出斑块
    c.fillStyle = this.theme.seaDeep;
    c.globalAlpha = 0.18;
    c.beginPath();
    for (const t of m.all) {
      if (!t.edge) continue;
      const [x, y] = this.iso(t.i, t.j);
      c.moveTo(x + hw * 2.3, y + hh * 1.3);
      c.ellipse(x, y + hh * 1.3, hw * 2.3, hh * 2.4, 0, 0, Math.PI * 2);
    }
    c.fill();
    c.fillStyle = shade(this.theme.sea, 0.25);
    c.globalAlpha = 0.45;
    c.beginPath();
    for (const t of m.all) {
      if (!t.edge) continue;
      const [x, y] = this.iso(t.i, t.j);
      c.moveTo(x + hw * 1.4, y + hh * 1.2);
      c.ellipse(x, y + hh * 1.2, hw * 1.4, hh * 1.5, 0, 0, Math.PI * 2);
    }
    c.fill();
    c.globalAlpha = 1;
    // 拍岸的浪花：沿着露出的海岸线，一涨一落。每条边只取其中一段，分三组错开节奏，
    // 浪线断断续续，不再是一圈整齐的白边。
    c.lineCap = 'round';
    c.lineWidth = Math.max(1, tw * 0.035);
    for (let group = 0; group < 3; group++) {
      for (const pass of [0, 1]) {
        const ph = this.t * 0.9 + pass * Math.PI + group * 2.1;
        const out = (0.5 + 0.5 * Math.sin(ph)) * tw * 0.09 + tw * 0.03;
        c.strokeStyle = `rgba(255,255,255,${0.3 + 0.38 * (0.5 - 0.5 * Math.sin(ph))})`;
        c.beginPath();
        for (const t of m.all) {
          if (!t.edge) continue;
          const [x, y] = this.iso(t.i, t.j);
          const yb = y + D;
          const seg = (k: number, x0: number, y0: number, x1: number, y1: number) => {
            if (Math.floor(tileHash(t.i, t.j, 150 + k) * 3) !== group) return;
            const len = 0.35 + tileHash(t.i, t.j, 154 + k) * 0.55;
            if (tileHash(t.i, t.j, 158 + k) < 0.15) return;
            const u0 = tileHash(t.i, t.j, 162 + k) * (1 - len);
            c.moveTo(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0);
            c.lineTo(x0 + (x1 - x0) * (u0 + len), y0 + (y1 - y0) * (u0 + len));
          };
          if (!m.at(t.i, t.j + 1)) seg(0, x - hw - out * 0.9, yb + out * 0.4, x - out * 0.2, yb + hh + out);
          if (!m.at(t.i + 1, t.j)) seg(1, x + out * 0.2, yb + hh + out, x + hw + out * 0.9, yb + out * 0.4);
          if (!m.at(t.i - 1, t.j)) seg(2, x - hw - out, y - out * 0.4, x - out * 0.2, y - hh - out * 0.9);
          if (!m.at(t.i, t.j - 1)) seg(3, x + out * 0.2, y - hh - out * 0.9, x + hw + out, y - out * 0.4);
        }
        c.stroke();
      }
    }
    // 晴天白日的波光
    if (a.weather === 'clear' && this.day.night < 0.3) {
      c.fillStyle = '#ffffff';
      for (let k = 0; k < 34; k++) {
        const x = hash('gx' + k) * v.w;
        const y = hash('gy' + k) * v.h;
        const tw2 = Math.sin(this.t * (1.5 + hash('gs' + k) * 2) + k * 2.1);
        if (tw2 < 0.55 || !this.onSea(x, y)) continue;
        const r = (tw2 - 0.55) * 5 * (1 - this.day.night);
        c.globalAlpha = 0.8;
        c.fillRect(x - r, y - 0.5, r * 2, 1);
        c.fillRect(x - 0.5, y - r * 0.6, 1, r * 1.2);
      }
      c.globalAlpha = 1;
    }
    // 端午：龙舟在岛背后的一段航程
    if (a.fest.has('duanwu') && this.day.night < 0.6) this.drawDragonBoat(true);
  }

  /* ---------------- 物件 ---------------- */

  /** 树冠的屏幕轮廓：松树每层一个三角，阔叶树每团叶子一个八边形，与 drawTree 用同一份分层和叶团；落叶后只剩枝条，不算遮挡 */
  protected treeOutline(x: number, y: number, s: number, kind: 'pine' | 'round', seed: number): [number, number][][] {
    const a = this.amb;
    if (kind === 'pine') {
      return pineTiers(seed).map(([b, top, w]): [number, number][] => [
        [x - s * w, y - s * b],
        [x, y - s * top],
        [x + s * w, y - s * b],
      ]);
    }
    if (a.season === 3 || (a.season === 2 && a.progress > 0.85)) return [];
    const thin = a.season === 2 ? 1 - a.progress * 0.25 : 1;
    const ty = y - s * 0.66;
    return roundLobes(seed).map(([dx, dy, r]) => {
      const cx = x + dx * s;
      const cy = ty + dy * s;
      const rr = r * s * thin;
      return Array.from({ length: 8 }, (_, k): [number, number] => [cx + Math.cos((k / 8) * Math.PI * 2) * rr, cy + Math.sin((k / 8) * Math.PI * 2) * rr]);
    });
  }

  /** 山的屏幕轮廓：与点击判定用的三角形外框一致 */
  protected mountainOutline(x: number, y: number, t: Tile, tw: number): [number, number][] {
    const s = tw * (0.75 + t.v * 0.55);
    return [
      [x - tw * 0.48, y + tw * 0.05],
      [x + tw * 0.08 * (t.v - 0.5), y - s],
      [x + tw * 0.48, y + tw * 0.05],
      [x, y + tw * 0.12],
    ];
  }

  protected drawTree(x: number, y: number, s: number, kind: 'pine' | 'round', seed: number) {
    const c = this.ctx;
    const a = this.amb;
    const se = a.season;
    const wind = (a.weather === 'rain' ? 1.6 : 1) * (0.6 + 0.4 * Math.sin(this.t * 0.4));
    const sway = Math.sin(this.t * 1.4 + seed * 9) * s * 0.025 * wind;
    this.shadow(x + s * 0.06, y, s * 0.34, s * 0.13, 0.16);
    c.fillStyle = '#6e5034';
    c.beginPath();
    c.moveTo(x - s * 0.055, y);
    c.lineTo(x + s * 0.055, y);
    c.lineTo(x + s * 0.035 + sway * 0.4, y - s * 0.4);
    c.lineTo(x - s * 0.035 + sway * 0.4, y - s * 0.4);
    c.fill();
    if (kind === 'pine') {
      // 三层松枝：左侧受光、右侧背光，冬天每层顶上压着雪
      const col = se === 3 ? '#4f6f4f' : se === 0 ? '#55874a' : '#45743f';
      const tiers = pineTiers(seed);
      for (let k = 0; k < tiers.length; k++) {
        const [b, top, w] = tiers[k];
        const ox = sway * (0.5 + k * 0.4);
        const bx = x + ox * 0.6;
        this.poly(col, x + ox, y - s * top, bx - s * w, y - s * b, bx, y - s * (b - 0.06));
        this.poly(shade(col, -0.2), x + ox, y - s * top, bx + s * w, y - s * b, bx, y - s * (b - 0.06));
        if (a.cover > 0.2) {
          const f = 0.45;
          this.poly(SNOW, x + ox, y - s * top, bx - s * w * f, y - s * (top - (top - b) * f), bx + s * w * f * 0.6, y - s * (top - (top - b) * f * 0.8));
        }
      }
      // 圣诞：松树上挂彩灯
      if (a.fest.has('christmas') && seed % 1 < 0.6) {
        const cols = ['#ff5a5a', '#ffd84a', '#5ab4ff', '#7cff7a'];
        for (let k = 0; k < 6; k++) {
          const ly = y - s * (0.3 + k * 0.14);
          const lx = x + sway + (k % 2 ? 1 : -1) * s * (0.24 - k * 0.03);
          const on = Math.sin(this.t * 3 + k + seed * 7) > -0.3;
          this.dot(lx, ly, Math.max(0.8, s * 0.035), on ? cols[k % cols.length] : '#5a4a3a');
          if (on && this.lit) this.lights.push([lx, ly, s * 0.18, cols[k % cols.length] === '#ffd84a' ? WARM : '255,140,140']);
        }
      }
      return;
    }
    // 阔叶树
    const cherry = se === 0 && seed % 1 < 0.35;
    const tx = x + sway;
    const ty = y - s * 0.66;
    if (se === 3 || (se === 2 && a.progress > 0.85)) {
      // 光秃的枝条
      c.strokeStyle = '#6e5034';
      c.lineWidth = Math.max(0.7, s * 0.04);
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x, y - s * 0.38);
      c.lineTo(tx, y - s * 0.95);
      for (const [dx, dy, ex, ey] of [
        [0, 0.5, -0.24, 0.82],
        [0, 0.55, 0.26, 0.86],
        [0, 0.72, -0.14, 0.98],
        [0, 0.75, 0.16, 1.02],
      ]) {
        c.moveTo(x + (tx - x) * ((dy - 0.38) / 0.57) + dx, y - s * dy);
        c.lineTo(tx + s * ex, y - s * ey);
      }
      c.stroke();
      if (a.cover > 0.3) {
        c.strokeStyle = SNOW;
        c.lineWidth = Math.max(0.6, s * 0.03);
        c.beginPath();
        c.moveTo(tx - s * 0.22, y - s * 0.84);
        c.lineTo(tx - s * 0.08, y - s * 0.78);
        c.moveTo(tx + s * 0.1, y - s * 0.82);
        c.lineTo(tx + s * 0.24, y - s * 0.88);
        c.stroke();
      }
      if (se === 2) {
        // 最后几片叶子
        this.dot(tx - s * 0.2, y - s * 0.84, s * 0.05, '#c4532e');
        this.dot(tx + s * 0.14, y - s * 0.96, s * 0.045, '#d9782a');
      }
      return;
    }
    let col: string;
    if (cherry) col = a.progress < 0.55 ? '#f2b8c8' : '#a8cf78';
    else if (se === 0) col = '#86b54e';
    else if (se === 1) col = '#5c8f3c';
    else {
      const autumn = ['#d99a2b', '#c8642c', '#b84a2e', '#d6b23a'];
      col = mix('#a7a43c', autumn[Math.floor((seed * 7.3) % 1 * autumn.length)], clamp(a.progress * 1.6, 0.25, 1));
    }
    // 三四团叶子叠出树冠：暗底、中间、受光的高光
    const thin = se === 2 ? 1 - a.progress * 0.25 : 1;
    const lobes = roundLobes(seed);
    for (const [dx, dy, r] of lobes) this.dot(tx + dx * s, ty + dy * s, r * s * thin, shade(col, -0.2));
    for (const [dx, dy, r] of lobes) this.dot(tx + dx * s - s * 0.03, ty + dy * s - s * 0.04, r * s * 0.82 * thin, col);
    this.dot(tx - s * 0.1, ty - s * 0.16, s * 0.12 * thin, shade(col, 0.2));
    if (cherry && a.progress < 0.55) {
      for (let k = 0; k < 5; k++) this.dot(tx + (((seed * 13 + k * 0.37) % 1) - 0.5) * s * 0.5, ty + (((seed * 29 + k * 0.53) % 1) - 0.5) * s * 0.4, s * 0.035, '#fff1f5');
    } else if (se === 1 && (seed * 11) % 1 < 0.3) {
      // 夏天的果子
      for (let k = 0; k < 3; k++) this.dot(tx + (k - 1) * s * 0.14, ty + s * (0.05 + (k % 2) * 0.08), s * 0.035, '#d9483a');
    }
  }

  /** 在等距面上画平行四边形：左墙面沿 (+1,+0.5) 方向，右墙面沿 (+1,-0.5) */

  /**
   * 山：每块山地是一组高矮宽窄不同的岩块，主峰在后，矮岩在前。
   * 主峰高度沿用原来的 0.75–1.3 倍地块宽，点击判定的外框不变。
   */
  protected drawMountain(x: number, y: number, t: Tile, tw: number) {
    const a = this.amb;
    const s = tw * (0.75 + t.v * 0.55);
    const h = (k: number) => tileHash(t.i, t.j, 170 + k);
    const snow = clamp([0.3, 0.16, 0.24, 0.42][a.season] + a.cover * 0.35, 0, 0.85);
    // [横向偏移（地块宽）, 底边下移（地块宽）, 半宽（地块宽）, 高（主峰高）]
    const blocks: [number, number, number, number][] = [[(h(0) - 0.5) * 0.1, 0, 0.36 + h(1) * 0.1, 0.92]];
    if (h(5) < 0.45) blocks.push([h(2) < 0.5 ? -0.26 : 0.26, 0.07, 0.18 + h(3) * 0.08, 0.32 + h(4) * 0.2]);
    for (let k = 0; k < blocks.length; k++) {
      const [dx, dy, w, hk] = blocks[k];
      this.drawRockMass(x + dx * tw, y + dy * tw, w * tw, s * hk, h(10 + k), hk > 0.6 ? snow : snow * 0.4);
    }
  }

  /** 一块岩体：宽底、斜削的平顶、左侧受光右侧背光，山脚一圈草坡 */
  protected drawRockMass(bx: number, by: number, w: number, h: number, r: number, snow: number) {
    const c = this.ctx;
    const a = this.amb;
    const green = a.season === 1 ? 0.3 : a.season === 0 ? 0.2 : a.season === 2 ? 0.08 : 0;
    const BL: [number, number] = [bx - w, by];
    const BR: [number, number] = [bx + w, by];
    const BM: [number, number] = [bx + w * 0.1, by + w * 0.3];
    const SL: [number, number] = [bx - w * 0.86, by - h * (0.5 + r * 0.15)];
    const SR: [number, number] = [bx + w * 0.82, by - h * (0.4 + (1 - r) * 0.15)];
    // 顶部：一条斜削的岩脊，左高右低或反之
    const TL: [number, number] = [bx - w * (0.45 - r * 0.2), by - h * (0.9 + r * 0.1)];
    const TR: [number, number] = [bx + w * (0.25 + r * 0.15), by - h * (1 - r * 0.12)];
    const RM: [number, number] = [bx + w * 0.02, by - h * 0.78];
    this.shadow(bx + w * 0.2, by + w * 0.14, w * 1.15, w * 0.42, 0.14);
    const lit = '#aaa496';
    const dark = '#7c776c';
    this.poly(lit, BL[0], BL[1], SL[0], SL[1], TL[0], TL[1], RM[0], RM[1], BM[0], BM[1]);
    this.poly(dark, RM[0], RM[1], TR[0], TR[1], SR[0], SR[1], BR[0], BR[1], BM[0], BM[1]);
    // 顶面最亮
    this.poly(snow > 0.2 ? SNOW : shade(lit, 0.16), TL[0], TL[1], TR[0], TR[1], RM[0], RM[1]);
    // 受光面上一块略亮的岩面
    this.poly(shade(lit, 0.07), SL[0], SL[1], TL[0], TL[1], RM[0], RM[1], bx - w * 0.4, by - h * 0.35);
    // 山脚的草坡（冬天被雪盖住）
    const foot = a.cover > 0.3 ? SNOW : mix('#8d927c', '#7fa25a', green);
    const fy = h * 0.18;
    this.poly(foot, BL[0], BL[1], BL[0] + w * 0.12, BL[1] - fy, BM[0], BM[1] - fy * 0.7, BM[0], BM[1]);
    this.poly(shade(foot, -0.14), BM[0], BM[1], BM[0], BM[1] - fy * 0.7, BR[0] - w * 0.12, BR[1] - fy * 0.6, BR[0], BR[1]);
    // 横向的岩层缝，几道短线
    c.strokeStyle = 'rgba(60,58,50,.28)';
    c.lineWidth = Math.max(0.6, w * 0.035);
    c.beginPath();
    c.moveTo(bx - w * 0.7, by - h * 0.42);
    c.lineTo(bx - w * 0.25, by - h * 0.36);
    c.moveTo(bx + w * 0.25, by - h * 0.55);
    c.lineTo(bx + w * 0.6, by - h * 0.32);
    c.moveTo(bx - w * 0.35, by - h * 0.66);
    c.lineTo(bx - w * 0.05, by - h * 0.6);
    c.stroke();
    if (snow > 0.2) {
      // 雪从岩脊顺两面往下挂一截，锯齿收边
      const k = clamp(snow, 0, 0.8);
      const down = (q: [number, number], f: number): [number, number] => [q[0], q[1] + (by - q[1]) * f];
      const l = down(TL, k * 0.4);
      const m = down(RM, k * 0.3);
      const rr = down(TR, k * 0.35);
      this.poly(SNOW, TL[0], TL[1], RM[0], RM[1], m[0], m[1], (l[0] + m[0]) / 2, (l[1] + m[1]) / 2 - h * 0.05, l[0], l[1]);
      this.poly('#dcdcd2', RM[0], RM[1], TR[0], TR[1], rr[0], rr[1], (rr[0] + m[0]) / 2, (rr[1] + m[1]) / 2 - h * 0.05, m[0], m[1]);
    }
  }

  protected drawDragonBoat(back: boolean) {
    const m = this.map;
    const C = (m.N - 1) / 2;
    const R = m.radius + 2.6;
    const ang = this.t * 0.05;
    const i = C + Math.cos(ang) * R;
    const j = C + Math.sin(ang) * R;
    if (i + j < 2 * C !== back) return;
    const [x, y] = this.iso(i, j);
    const { tw } = this.view;
    const c = this.ctx;
    const s = tw * 0.9;
    const dir = Math.cos(ang) - Math.sin(ang) > 0 ? -1 : 1;
    c.strokeStyle = 'rgba(255,255,255,.5)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x - dir * s * 0.6, y + s * 0.08);
    c.lineTo(x - dir * s * 1.1, y + s * 0.02);
    c.stroke();
    this.poly('#c8473a', x - s * 0.55, y - s * 0.05, x + s * 0.55, y - s * 0.05, x + s * 0.45, y + s * 0.06, x - s * 0.45, y + s * 0.06);
    this.poly('#e2ad2f', x - s * 0.55, y - s * 0.05, x + s * 0.55, y - s * 0.05, x + s * 0.5, y - s * 0.01, x - s * 0.5, y - s * 0.01);
    // 龙头与龙尾
    const hx0 = x + dir * s * 0.55;
    this.poly('#2f7a4a', hx0, y - s * 0.05, hx0 + dir * s * 0.12, y - s * 0.2, hx0 + dir * s * 0.2, y - s * 0.16, hx0 + dir * s * 0.06, y - s * 0.02);
    this.dot(hx0 + dir * s * 0.13, y - s * 0.18, s * 0.015, '#ffd84a');
    this.poly('#2f7a4a', x - dir * s * 0.55, y - s * 0.05, x - dir * s * 0.66, y - s * 0.22, x - dir * s * 0.5, y - s * 0.06);
    // 划手
    for (let k = 0; k < 6; k++) {
      const px = x + (k - 2.5) * s * 0.15;
      const row = Math.sin(this.t * 6 + k * 0.3);
      this.dot(px, y - s * 0.1, s * 0.035, ['#c8473a', '#e0b84a', '#4c6a84'][k % 3]);
      this.dot(px, y - s * 0.16, s * 0.025, '#e6b48c');
      c.strokeStyle = '#6b4a30';
      c.beginPath();
      c.moveTo(px, y - s * 0.08);
      c.lineTo(px - dir * row * s * 0.06, y + s * 0.08);
      c.stroke();
    }
  }

  /** 被点中的景物：一圈呼吸的高亮 */
}
