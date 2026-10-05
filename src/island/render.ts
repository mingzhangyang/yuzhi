/**
 * 小岛 Canvas 的绘制层。
 *
 * viewport / interaction / simulation 分别负责坐标、命中与动画状态；
 * 本文件只保留绘制工具、具体美术和每帧编排。
 */
import { dayLight } from './ambience';
import { tileHash, type Tile } from './map';
import { IslandPropArt } from './props';
import type { AgendaView, Glow, LandmarkView, Scene, VillageView, Walker } from './render/model';
import { IslandSimulation } from './render/simulation';
import { LANTERN, SNOW, SNOW_SHADE, WARM } from './render/style';
import { clamp, hash, mix, rgb, shade } from './render/utils';

export type { AgendaView, ChoresView, Hit, LandmarkView, Light, Scene, SceneryInspection, Selection, VillageView, WalkerView } from './render/model';
export { mix, shade } from './render/utils';

export class IslandRenderer extends IslandSimulation {
  private raf = 0;
  private last = 0;
  private lights: Glow[] = [];
  private propArt = new IslandPropArt();
  private ground = document.createElement('canvas');
  private groundKey = '';

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement) {
    super(canvas, wrap);
    this.readTheme();
    this.bindInteraction();
    this.resize();
  }

  protected override onThemeChanged() {
    this.groundKey = '';
  }

  start() {
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
      this.last = now;
      this.t += dt;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private poly(fill: string, ...pts: number[]) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) c.lineTo(pts[k], pts[k + 1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  private rrect(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  private dot(x: number, y: number, r: number, fill: string) {
    const c = this.ctx;
    c.fillStyle = fill;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  private shadow(x: number, y: number, rx: number, ry: number, a = 0.15) {
    const c = this.ctx;
    c.fillStyle = `rgba(30,40,20,${a})`;
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  }

  /** 夜里是否点灯 */
  private get lit() {
    return this.scene?.light !== 'day' || this.day.night > 0.35;
  }

  /* ---------------- 地面（缓存） ---------------- */

  /** 当季的草地、田地底色 */
  private palette() {
    const { season: se, progress: p } = this.amb;
    const grass = [mix('#b6d27c', '#9cc464', p), mix('#8fb855', '#86ad4f', p), mix('#b3b65f', '#c7a85a', p), '#b2ad88'][se];
    const field = [mix('#b9cf7a', '#9fc35e', p), mix('#c2c45a', '#dcbc4c', p), mix('#e3ad45', '#c7a26c', p), '#b5a382'][se];
    return { grass, field };
  }

  private tileTop(t: Tile, occupied: Set<number>): string {
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
    col = shade(col, (t.v - 0.5) * 0.1);
    if (a.cover > 0 && t.type !== 'water') col = mix(col, SNOW, clamp(a.cover * (0.86 + 0.18 * tileHash(t.i, t.j, 41)), 0, 0.92));
    if (a.weather === 'rain') col = shade(col, -0.06);
    return col;
  }

  private drawGround(s: Scene) {
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
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      const col = this.tileTop(t, occupied);
      const wat = t.type === 'water';
      // 崖壁：泥土、一道深色的岩层、顶上一圈草皮（冬天是雪）
      const lip = a.cover > 0.3 ? SNOW : shade(col, -0.08);
      const front = !m.at(t.i, t.j + 1);
      const right = !m.at(t.i + 1, t.j);
      if (front) {
        this.poly(wat ? '#5f93a8' : '#b38957', x - hw, y, x, y + hh, x, y + hh + D, x - hw, y + D);
        if (!wat) {
          this.poly('#a07a4c', x - hw, y + D * 0.55, x, y + hh + D * 0.55, x, y + hh + D * 0.7, x - hw, y + D * 0.7);
          this.poly(lip, x - hw, y, x, y + hh, x, y + hh + D * 0.18, x - hw, y + D * 0.18);
        }
      }
      if (right) {
        this.poly(wat ? '#4f8197' : '#957043', x, y + hh, x + hw, y, x + hw, y + D, x, y + hh + D);
        if (!wat) {
          this.poly('#82603a', x, y + hh + D * 0.55, x + hw, y + D * 0.55, x + hw, y + D * 0.7, x, y + hh + D * 0.7);
          this.poly(shade(lip, -0.12), x, y + hh, x + hw, y, x + hw, y + D * 0.18, x, y + hh + D * 0.18);
        }
      }
      // 地块顶面：北角略亮、南角略暗
      const grd = gc.createLinearGradient(x, y - hh, x, y + hh);
      grd.addColorStop(0, shade(col, 0.05));
      grd.addColorStop(1, shade(col, -0.04));
      this.poly(col, x, y - hh - 0.4, x + hw + 0.5, y, x, y + hh + 0.4, x - hw - 0.5, y);
      gc.fillStyle = grd;
      gc.fill();
      this.tileDetail(t, t.type === 'plaza' && t.village >= 0 && !occupied.has(t.village) ? 'grass' : t.type, x, y, col, lw);
    }
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

  /** 地块上的小细节：草丛、野花、落叶、田垄、石板、沙粒 */
  private tileDetail(t: Tile, kind: Tile['type'], x: number, y: number, col: string, lw: number) {
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
      if (!snowy || h(30) > a.cover) {
        c.strokeStyle = shade(col, a.season === 1 ? -0.22 : -0.16);
        c.lineWidth = lw;
        c.beginPath();
        const n = a.season === 1 ? 3 : 2;
        for (let k = 0; k < n; k++) {
          const [px, py] = pt(k);
          const ht = tw * (a.season === 1 ? 0.09 : 0.06);
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

  private drawSea() {
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
    // 拍岸的浪花：沿着露出的海岸线，一涨一落
    for (const pass of [0, 1]) {
      const ph = this.t * 0.9 + pass * Math.PI;
      const out = (0.5 + 0.5 * Math.sin(ph)) * tw * 0.09 + tw * 0.03;
      c.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * (0.5 - 0.5 * Math.sin(ph))})`;
      c.lineWidth = Math.max(1, tw * 0.035);
      c.lineCap = 'round';
      c.beginPath();
      for (const t of m.all) {
        if (!t.edge) continue;
        const [x, y] = this.iso(t.i, t.j);
        const yb = y + D;
        if (!m.at(t.i, t.j + 1)) {
          c.moveTo(x - hw - out * 0.9, yb + out * 0.4);
          c.lineTo(x - out * 0.2, yb + hh + out);
        }
        if (!m.at(t.i + 1, t.j)) {
          c.moveTo(x + out * 0.2, yb + hh + out);
          c.lineTo(x + hw + out * 0.9, yb + out * 0.4);
        }
        if (!m.at(t.i - 1, t.j)) {
          c.moveTo(x - hw - out, y - out * 0.4);
          c.lineTo(x - out * 0.2, y - hh - out * 0.9);
        }
        if (!m.at(t.i, t.j - 1)) {
          c.moveTo(x + out * 0.2, y - hh - out * 0.9);
          c.lineTo(x + hw + out, y - out * 0.4);
        }
      }
      c.stroke();
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

  private drawTree(x: number, y: number, s: number, kind: 'pine' | 'round', seed: number) {
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
      const tiers: [number, number, number][] = [
        [0.18, 0.62, 0.36],
        [0.46, 0.92, 0.28],
        [0.72, 1.28, 0.2],
      ];
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
    const lobes: [number, number, number][] = [
      [-0.16, 0.02, 0.24],
      [0.17, 0.04, 0.23],
      [0, -0.14, 0.27],
      [0.02, 0.1, 0.26],
    ];
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
  private facePoly(fill: string, x0: number, y0: number, w: number, h: number, slope: number) {
    this.poly(fill, x0, y0, x0 + w, y0 + w * slope, x0 + w, y0 + w * slope - h, x0, y0 - h);
  }

  /**
   * 小房子：石基、两面墙、带框的窗、门、四坡屋顶（有瓦线和屋脊），
   * 冬天屋顶积雪，冷天和傍晚烟囱冒烟，节日挂灯笼贴对联。返回窗户位置，供夜里点灯。
   */
  private drawHouse(x: number, y: number, s: number, roof: string, wall = '#efe5cf', boarded = false, deco = true, lamp = true): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const hw = s / 2;
    const hh = s / 4;
    const H = s * 0.5;
    this.shadow(x + s * 0.12, y + hh * 0.45, s * 0.66, s * 0.27);
    // 墙
    this.poly(wall, x - hw, y, x, y + hh, x, y + hh - H, x - hw, y - H);
    this.poly(shade(wall, -0.14), x, y + hh, x + hw, y, x + hw, y - H, x, y + hh - H);
    // 石基
    const fb = H * 0.14;
    this.poly('#b9ad97', x - hw, y, x, y + hh, x, y + hh - fb, x - hw, y - fb);
    this.poly('#9c917d', x, y + hh, x + hw, y, x + hw, y - fb, x, y + hh - fb);
    // 墙角的木柱
    c.strokeStyle = shade(wall, -0.32);
    c.lineWidth = Math.max(0.5, s * 0.025);
    c.beginPath();
    c.moveTo(x, y + hh - fb);
    c.lineTo(x, y + hh - H);
    c.stroke();
    // 窗（左墙）
    const ww = hw * 0.34;
    const wh = H * 0.32;
    const wx = x - hw * 0.7;
    const wy = y + hh * 0.3 - H * 0.36;
    const lit = this.lit && !boarded && lamp;
    this.facePoly('#7b5e45', wx - s * 0.02, wy + s * 0.02, ww + s * 0.04, wh + s * 0.04, 0.5);
    this.facePoly(boarded ? '#5a4a3a' : lit ? '#ffd677' : '#8fa5b2', wx, wy, ww, wh, 0.5);
    if (!boarded) {
      c.strokeStyle = '#7b5e45';
      c.lineWidth = Math.max(0.5, s * 0.02);
      c.beginPath();
      c.moveTo(wx + ww / 2, wy + (ww / 2) * 0.5);
      c.lineTo(wx + ww / 2, wy + (ww / 2) * 0.5 - wh);
      c.moveTo(wx, wy - wh / 2);
      c.lineTo(wx + ww, wy + ww * 0.5 - wh / 2);
      c.stroke();
    } else {
      c.strokeStyle = '#3d3128';
      c.lineWidth = Math.max(0.6, s * 0.03);
      c.beginPath();
      c.moveTo(wx, wy - wh);
      c.lineTo(wx + ww, wy + ww * 0.5);
      c.moveTo(wx, wy);
      c.lineTo(wx + ww, wy + ww * 0.5 - wh);
      c.stroke();
    }
    // 门（右墙）
    const dx0 = x + hw * 0.3;
    const dy0 = y + hh - hh * 0.3;
    const dw = hw * 0.3;
    const dh = H * 0.6;
    this.facePoly('#5e4532', dx0, dy0, dw, dh, -0.5);
    this.facePoly('#7a5a40', dx0 + dw * 0.12, dy0 - dw * 0.06, dw * 0.76, dh * 0.9, -0.5);
    this.dot(dx0 + dw * 0.7, dy0 - dw * 0.35 - dh * 0.45, Math.max(0.5, s * 0.018), '#e2c56a');
    // 屋顶：四坡顶，出檐，瓦线，屋脊高光
    const ay = y - H - s * 0.42;
    const L: [number, number] = [x - hw * 1.14, y - H + hh * 0.04];
    const F: [number, number] = [x, y + hh - H + hh * 0.24];
    const R: [number, number] = [x + hw * 1.14, y - H + hh * 0.04];
    const dark = shade(roof, -0.22);
    this.poly(shade(roof, -0.35), L[0], L[1], F[0], F[1] + s * 0.035, R[0], R[1], F[0], F[1]);
    this.poly(roof, L[0], L[1], F[0], F[1], x, ay);
    this.poly(dark, F[0], F[1], R[0], R[1], x, ay);
    c.lineWidth = Math.max(0.5, s * 0.02);
    c.strokeStyle = shade(roof, -0.12);
    c.beginPath();
    for (const f of [0.33, 0.66]) {
      c.moveTo(L[0] + (x - L[0]) * f, L[1] + (ay - L[1]) * f);
      c.lineTo(F[0], F[1] + (ay - F[1]) * f);
    }
    c.stroke();
    c.strokeStyle = shade(roof, -0.34);
    c.beginPath();
    for (const f of [0.33, 0.66]) {
      c.moveTo(F[0], F[1] + (ay - F[1]) * f);
      c.lineTo(R[0] + (x - R[0]) * f, R[1] + (ay - R[1]) * f);
    }
    c.stroke();
    c.strokeStyle = shade(roof, 0.25);
    c.beginPath();
    c.moveTo(F[0], F[1]);
    c.lineTo(x, ay);
    c.stroke();
    // 烟囱
    const cx = x + hw * 0.42;
    const cy = ay + (R[1] - ay) * 0.42 + s * 0.05;
    const cw = s * 0.07;
    this.poly('#a0796a', cx - cw, cy, cx, cy + cw * 0.5, cx, cy + cw * 0.5 - s * 0.2, cx - cw, cy - s * 0.2);
    this.poly('#80594c', cx, cy + cw * 0.5, cx + cw, cy, cx + cw, cy - s * 0.2, cx, cy + cw * 0.5 - s * 0.2);
    // 积雪
    if (a.cover > 0.15) {
      const f = 0.35 + 0.45 * a.cover;
      const lerp = (p: [number, number], k: number): [number, number] => [x + (p[0] - x) * k, ay + (p[1] - ay) * k];
      const [l1, l2] = lerp(L, f);
      const [f1, f2] = lerp(F, f);
      const [r1, r2] = lerp(R, f);
      this.poly(SNOW, x, ay - s * 0.015, l1, l2, f1, f2 + s * 0.02);
      this.poly(SNOW_SHADE, x, ay - s * 0.015, f1, f2 + s * 0.02, r1, r2);
      this.poly(SNOW, cx - cw, cy - s * 0.2, cx, cy + cw * 0.5 - s * 0.2, cx + cw, cy - s * 0.2, cx, cy - cw * 0.5 - s * 0.2);
    }
    // 炊烟：冷天、阴雨天和傍晚
    if (!boarded && deco && (a.season === 3 || a.weather !== 'clear' || this.day.warm > 0.4 || this.lit)) {
      for (let k = 0; k < 3; k++) {
        const ph = (this.t * 0.35 + k / 3 + (x * 0.013) % 1) % 1;
        const r = s * (0.05 + ph * 0.1);
        c.fillStyle = `rgba(236,236,232,${0.55 * (1 - ph)})`;
        c.beginPath();
        c.arc(cx + cw * 0.3 + Math.sin(ph * 5 + k) * s * 0.06 + ph * s * 0.12, cy - s * 0.24 - ph * s * 0.6, r, 0, Math.PI * 2);
        c.fill();
      }
    }
    // 节日装饰
    if (deco && !boarded) this.houseFestival(x, y, s, hh, H, dx0, dy0, dw, dh);
    if (lit) this.lights.push([wx + ww / 2, wy + ww * 0.25 - wh / 2, s * 0.55, WARM]);
    return [wx + ww / 2, wy + ww * 0.25 - wh / 2];
  }

  private houseFestival(x: number, y: number, s: number, hh: number, H: number, dx0: number, dy0: number, dw: number, dh: number) {
    const c = this.ctx;
    const f = this.amb.fest;
    if (f.has('chunjie') || f.has('yuanxiao')) {
      // 对联
      this.facePoly('#d63a2c', dx0 - dw * 0.3, dy0 + dw * 0.15, dw * 0.16, dh * 0.85, -0.5);
      this.facePoly('#d63a2c', dx0 + dw * 1.14, dy0 - dw * 0.57, dw * 0.16, dh * 0.85, -0.5);
    }
    if (f.has('chunjie') || f.has('yuanxiao') || f.has('zhongqiu')) {
      // 屋檐下的灯笼
      const lx = x;
      const ly = y + hh - H + hh * 0.24 + s * 0.12;
      const sw = Math.sin(this.t * 1.8 + x) * s * 0.01;
      c.strokeStyle = '#5a3a24';
      c.lineWidth = Math.max(0.5, s * 0.015);
      c.beginPath();
      c.moveTo(lx, ly - s * 0.08);
      c.lineTo(lx + sw, ly - s * 0.04);
      c.stroke();
      const col = f.has('zhongqiu') ? '#f29a3a' : '#e0372b';
      c.fillStyle = col;
      c.beginPath();
      c.ellipse(lx + sw, ly, s * 0.06, s * 0.05, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#f2c14a';
      c.fillRect(lx + sw - s * 0.03, ly - s * 0.055, s * 0.06, s * 0.012);
      c.fillRect(lx + sw - s * 0.005, ly + s * 0.05, s * 0.01, s * 0.04);
      if (this.lit) this.lights.push([lx + sw, ly, s * 0.5, LANTERN]);
    }
    if (f.has('christmas')) {
      // 门上的花环
      c.strokeStyle = '#3f7a3a';
      c.lineWidth = Math.max(0.8, s * 0.03);
      c.beginPath();
      c.arc(dx0 + dw / 2, dy0 - dw * 0.25 - dh * 0.68, s * 0.04, 0, Math.PI * 2);
      c.stroke();
      this.dot(dx0 + dw / 2, dy0 - dw * 0.25 - dh * 0.68 + s * 0.04, s * 0.015, '#d63a2c');
    }
  }

  private drawFlag(x: number, y: number, s: number, color: string, seed: number, star = false) {
    const c = this.ctx;
    c.fillStyle = '#6b4a30';
    c.fillRect(x - Math.max(0.5, s * 0.012), y - s * 0.5, Math.max(1, s * 0.025), s * 0.5);
    const w = s * 0.26;
    const h = s * 0.16;
    const top = y - s * 0.5;
    const wave = (k: number) => Math.sin(this.t * 3 + seed + k * 2.2) * s * 0.018;
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x, top);
    c.quadraticCurveTo(x + w * 0.5, top + wave(0), x + w, top + wave(1));
    c.lineTo(x + w, top + h + wave(1));
    c.quadraticCurveTo(x + w * 0.5, top + h + wave(0), x, top + h);
    c.fill();
    if (star) {
      this.dot(x + w * 0.22, top + h * 0.32 + wave(0) * 0.3, s * 0.03, '#ffd84a');
      for (let k = 0; k < 4; k++) this.dot(x + w * (0.38 + (k % 2) * 0.06), top + h * (0.14 + k * 0.12) + wave(0) * 0.4, s * 0.011, '#ffd84a');
    }
  }

  private drawMountain(x: number, y: number, t: Tile, tw: number) {
    const a = this.amb;
    const s = tw * (0.75 + t.v * 0.55);
    const ax = x + tw * 0.08 * (t.v - 0.5);
    const ay = y - s;
    const by = y + tw * 0.12;
    const L = x - tw * 0.48;
    const R = x + tw * 0.48;
    const yb = y + tw * 0.05;
    const green = a.season === 1 ? 0.25 : a.season === 0 ? 0.15 : 0;
    this.poly(mix('#b3b6a3', '#8fae6a', green), L, yb, ax, ay, ax, by);
    this.poly(mix('#8a8e7c', '#6f8a52', green), ax, ay, R, yb, ax, by);
    // 岩石的棱
    const c = this.ctx;
    c.strokeStyle = 'rgba(70,72,60,.35)';
    c.lineWidth = Math.max(0.6, tw * 0.02);
    c.beginPath();
    c.moveTo(ax - s * 0.08, ay + s * 0.35);
    c.lineTo(ax - s * 0.2, ay + s * 0.62);
    c.moveTo(ax + s * 0.12, ay + s * 0.45);
    c.lineTo(ax + s * 0.22, ay + s * 0.7);
    c.stroke();
    const f = clamp([0.3, 0.16, 0.24, 0.42][a.season] + a.cover * 0.35, 0, 0.85);
    // 雪线是锯齿形的
    const lf = (k: number) => [ax + (L - ax) * k, ay + (yb - ay) * k];
    const rf = (k: number) => [ax + (R - ax) * k, ay + (yb - ay) * k];
    const [l1, l2] = lf(f);
    const [r1, r2] = rf(f);
    const my = ay + (by - ay) * f * 0.9;
    this.poly(SNOW, ax, ay, l1, l2, ax + (l1 - ax) * 0.5, l2 - s * 0.05, ax, my);
    this.poly('#dcdcd2', ax, ay, ax, my, ax + (r1 - ax) * 0.5, r2 - s * 0.04, r1, r2);
  }

  private drawLighthouse(x: number, y: number, tw: number) {
    const c = this.ctx;
    const a = this.amb;
    const base = y - tw * 0.9;
    const w = tw * 0.16;
    const h = tw * 0.62;
    // 塔身：渐细，左亮右暗，两道红环
    this.poly('#f4f1e8', x - w, base, x - w * 0.7, base - h, x, base - h, x, base);
    this.poly('#d6d2c6', x, base, x, base - h, x + w * 0.7, base - h, x + w, base);
    for (const [b0, b1] of [
      [0.18, 0.36],
      [0.56, 0.74],
    ]) {
      const wl = (f: number) => w * (1 - 0.3 * f);
      this.poly('#c8473a', x - wl(b0), base - h * b0, x - wl(b1), base - h * b1, x, base - h * b1, x, base - h * b0);
      this.poly('#a0372d', x, base - h * b0, x, base - h * b1, x + wl(b1), base - h * b1, x + wl(b0), base - h * b0);
    }
    // 小门
    c.fillStyle = '#6b4a30';
    this.rrect(x - w * 0.28, base - h * 0.16, w * 0.4, h * 0.16, w * 0.15);
    c.fill();
    // 回廊
    c.fillStyle = '#3e3a36';
    c.fillRect(x - w * 0.95, base - h - tw * 0.02, w * 1.9, tw * 0.03);
    // 灯室
    const lr = base - h - tw * 0.14;
    const lit = this.lit;
    c.fillStyle = lit ? '#fff0a8' : '#cfe3e8';
    c.fillRect(x - w * 0.6, lr, w * 1.2, tw * 0.12);
    c.fillStyle = '#3e3a36';
    c.fillRect(x - Math.max(0.5, tw * 0.01), lr, Math.max(1, tw * 0.02), tw * 0.12);
    this.poly('#9a3a30', x - w * 0.8, lr, x, lr - tw * 0.15, x + w * 0.8, lr);
    this.dot(x, lr - tw * 0.16, Math.max(0.8, tw * 0.02), '#3e3a36');
    if (a.fest.has('guoqing')) this.drawFlag(x, lr - tw * 0.15, tw * 0.55, '#de2910', 3, true);
    if (a.cover > 0.3) this.poly(SNOW, x - w * 0.7, lr, x, lr - tw * 0.11, x, lr - tw * 0.06);
    if (lit) {
      const ang = this.t * 0.6;
      const ly = lr + tw * 0.06;
      const beam = clamp(this.day.night * 1.3, 0.25, 1);
      this.lights.push([x, ly, tw * 1.1, '255,236,160']);
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const off of [0, Math.PI]) {
        const g = c.createRadialGradient(x, ly, 0, x, ly, tw * 4.5);
        g.addColorStop(0, `rgba(255,232,150,${0.34 * beam})`);
        g.addColorStop(1, 'rgba(255,232,150,0)');
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(x, ly);
        c.arc(x, ly, tw * 4.5, ang + off - 0.16, ang + off + 0.16);
        c.closePath();
        c.fill();
      }
      c.restore();
    }
  }

  /** 地标：村落合成的永久建筑。石台 + 主屋，规模大的多一座塔；返回窗户位置 */
  private drawLandmark(x: number, y: number, tw: number, l: LandmarkView, anim: number, selected: boolean): [number, number] {
    const c = this.ctx;
    const k = 0.25 + 0.75 * anim;
    const hw = tw / 2;
    const hh = tw / 4;
    if (selected) {
      c.strokeStyle = this.theme.accent;
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(x, y, hw * 0.95, hh * 0.95, 0, 0, Math.PI * 2);
      c.stroke();
    }
    // 石台：顶面、两侧，加一道砌缝
    const pw = hw * 0.78;
    const ph = hh * 0.78;
    const pd = tw * 0.1;
    this.poly('#cfc8b4', x - pw, y, x, y + ph, x, y + ph + pd, x - pw, y + pd);
    this.poly('#b3ab95', x, y + ph, x + pw, y, x + pw, y + pd, x, y + ph + pd);
    c.strokeStyle = 'rgba(90,80,60,.3)';
    c.lineWidth = Math.max(0.5, tw * 0.012);
    c.beginPath();
    c.moveTo(x - pw, y + pd / 2);
    c.lineTo(x, y + ph + pd / 2);
    c.lineTo(x + pw, y + pd / 2);
    c.stroke();
    this.poly(this.amb.cover > 0.3 ? SNOW : '#e4dece', x, y - ph, x + pw, y, x, y + ph, x - pw, y);
    c.save();
    c.translate(x, y);
    c.scale(1, k);
    c.translate(-x, -y);
    const big = l.size >= 6;
    const roof = shade(l.roof, -0.05);
    if (big) {
      // 后面一座塔
      const tx = x + hw * 0.32;
      const ty = y - hh * 0.32;
      const w = tw * 0.13;
      const h = tw * 0.62;
      this.poly('#f1eadb', tx - w, ty, tx, ty + w * 0.5, tx, ty + w * 0.5 - h, tx - w, ty - h);
      this.poly('#d8cfbb', tx, ty + w * 0.5, tx + w, ty, tx + w, ty - h, tx, ty + w * 0.5 - h);
      c.fillStyle = this.lit ? '#ffd677' : '#8fa5b2';
      c.fillRect(tx - w * 0.6, ty - h * 0.7, w * 0.3, h * 0.16);
      this.poly(roof, tx - w * 1.2, ty - h, tx, ty - h - tw * 0.3, tx, ty - h + w * 0.6);
      this.poly(shade(roof, -0.2), tx, ty - h - tw * 0.3, tx + w * 1.2, ty - h, tx, ty - h + w * 0.6);
      if (this.amb.cover > 0.2) this.poly(SNOW, tx - w * 0.5, ty - h - tw * 0.17, tx, ty - h - tw * 0.3, tx + w * 0.5, ty - h - tw * 0.17);
    }
    // Canvas 的 scale 只影响即时绘制；drawHouse 追加到 lights 的坐标需要显式同步同一变换。
    const lightStart = this.lights.length;
    const win = this.drawHouse(x - (big ? hw * 0.12 : 0), y + (big ? hh * 0.12 : 0), tw * (big ? 0.5 : 0.44), roof, '#f4ecd8');
    // 旗
    const fx = x - hw * (big ? 0.55 : 0.4);
    const fy = y - tw * (big ? 0.62 : 0.55);
    this.drawFlag(fx, fy + tw * 0.04, tw * 0.68, l.roof, l.index);
    c.restore();
    for (let i = lightStart; i < this.lights.length; i++) {
      this.lights[i][1] = y + (this.lights[i][1] - y) * k;
    }
    return [win[0], y + (win[1] - y) * k];
  }

  private shownGranaryRatio(scene: Scene): number {
    const a = this.granaryTransition;
    if (!a) return scene.granaryRatio;
    const k = a.t * a.t * (3 - 2 * a.t);
    return a.from + (a.to - a.from) * k;
  }

  private shownFog(scene: Scene): number {
    const a = this.fogTransition;
    if (!a) return scene.fog;
    const k = a.t * a.t * (3 - 2 * a.t);
    return a.from + (a.to - a.from) * k;
  }

  private drawGranary(x: number, y: number, tw: number, ratio: number, busy = false) {
    const c = this.ctx;
    const s = tw * 0.46;
    const r = s * 0.34;
    const h = s * 0.95;
    this.shadow(x + s * 0.1, y + s * 0.06, s * 0.6, s * 0.25);
    const g = c.createLinearGradient(x - r, 0, x + r, 0);
    g.addColorStop(0, '#f2e6c8');
    g.addColorStop(0.55, '#dccaa0');
    g.addColorStop(1, '#b9a47a');
    c.fillStyle = g;
    c.fillRect(x - r, y - h, r * 2, h);
    c.beginPath();
    c.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI);
    c.fill();
    // 木板
    c.strokeStyle = 'rgba(120,90,50,.28)';
    c.lineWidth = Math.max(0.5, s * 0.02);
    c.beginPath();
    for (const f of [-0.6, -0.2, 0.2, 0.6]) {
      c.moveTo(x + r * f, y - h);
      c.lineTo(x + r * f, y + r * 0.45 * Math.sqrt(1 - f * f));
    }
    c.stroke();
    // 存量：金黄的一截
    const fh = h * clamp(ratio, 0, 1);
    c.fillStyle = ratio < 0.25 ? '#c98a4a' : '#e2ad2f';
    c.fillRect(x - r * 0.55, y - fh, r * 1.1, fh);
    // 铁箍
    c.strokeStyle = '#6b5a44';
    c.lineWidth = Math.max(0.7, s * 0.035);
    c.beginPath();
    c.ellipse(x, y - h * 0.3, r, r * 0.45, 0, 0, Math.PI);
    c.stroke();
    c.fillStyle = '#9c6a35';
    c.beginPath();
    c.ellipse(x, y - h, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
    c.fill();
    this.poly('#b07a40', x - r * 1.15, y - h, x, y - h - s * 0.55, x, y - h + r * 0.5);
    this.poly('#8a5a2c', x, y - h - s * 0.55, x + r * 1.15, y - h, x, y - h + r * 0.5);
    if (this.amb.cover > 0.15) {
      this.poly(SNOW, x - r * 0.7, y - h - s * 0.22, x, y - h - s * 0.56, x, y - h - s * 0.12);
      this.poly(SNOW_SHADE, x, y - h - s * 0.56, x + r * 0.7, y - h - s * 0.22, x, y - h - s * 0.12);
    }
    if (busy) {
      // 门半开表示「此刻正在用时间」，不改变粮仓存量高度。
      c.fillStyle = '#6e4d32';
      c.fillRect(x - r * 0.48, y - s * 0.34, r * 0.96, s * 0.34);
      c.fillStyle = '#3f3025';
      c.beginPath();
      c.moveTo(x - r * 0.48, y - s * 0.34);
      c.lineTo(x - r * 0.08, y - s * 0.25);
      c.lineTo(x - r * 0.08, y + 0.01);
      c.lineTo(x - r * 0.48, y);
      c.closePath();
      c.fill();
      if (this.lit) this.lights.push([x - r * 0.16, y - s * 0.16, tw * 0.24, WARM]);
    }
  }

  private drawWeeds(x: number, y: number, tw: number, seed: number) {
    const c = this.ctx;
    c.strokeStyle = this.amb.season === 3 ? '#8a835f' : '#6d7f3a';
    c.lineWidth = Math.max(0.7, tw * 0.025);
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      const ox = x + (hash(seed + 'a' + k) - 0.5) * tw * 0.6;
      const oy = y + (hash(seed + 'b' + k) - 0.5) * tw * 0.25;
      for (const d of [-1, 0, 1]) {
        c.moveTo(ox, oy);
        c.lineTo(ox + d * tw * 0.04, oy - tw * 0.1);
      }
    }
    c.stroke();
  }

  /** 村中央的井；节日在旁边挂灯笼或插旗 */
  private drawWell(x: number, y: number, tw: number, vv: VillageView, t: Tile) {
    const c = this.ctx;
    const a = this.amb;
    const r = tw * 0.1;
    this.shadow(x + r * 0.2, y + r * 0.2, r * 1.3, r * 0.6);
    c.fillStyle = '#8f8a7a';
    c.beginPath();
    c.ellipse(x, y, r, r * 0.5, 0, 0, Math.PI * 2);
    c.fill();
    c.fillRect(x - r, y - r * 0.5, r * 2, r * 0.5);
    c.fillStyle = '#a7a290';
    c.beginPath();
    c.ellipse(x, y - r * 0.5, r, r * 0.5, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = vv.stage >= 2 ? '#7d8a8c' : a.cover > 0.6 ? '#cfe2ea' : '#5a7f95';
    c.beginPath();
    c.ellipse(x, y - r * 0.5, r * 0.68, r * 0.32, 0, 0, Math.PI * 2);
    c.fill();
    // 井架
    c.strokeStyle = '#6b4a30';
    c.lineWidth = Math.max(0.8, tw * 0.025);
    c.beginPath();
    c.moveTo(x - r * 0.9, y - r * 0.4);
    c.lineTo(x - r * 0.9, y - r * 2.1);
    c.moveTo(x + r * 0.9, y - r * 0.4);
    c.lineTo(x + r * 0.9, y - r * 2.1);
    c.stroke();
    this.poly(shade(vv.roof, -0.1), x - r * 1.3, y - r * 1.9, x, y - r * 2.7, x + r * 1.3, y - r * 1.9);
    if (a.cover > 0.2) this.poly(SNOW, x - r * 0.8, y - r * 2.2, x, y - r * 2.7, x + r * 0.8, y - r * 2.2);
    if (vv.stage >= 2) this.drawWeeds(x, y + tw * 0.08, tw, t.i * 31 + t.j);
    const f = a.fest;
    const px = x + tw * 0.24;
    const py = y - tw * 0.02;
    if (f.has('guoqing')) this.drawFlag(px, py, tw * 0.8, '#de2910', t.i + t.j, true);
    else if (f.has('chunjie') || f.has('yuanxiao') || f.has('zhongqiu')) {
      // 一串灯笼
      c.strokeStyle = '#5a3a24';
      c.lineWidth = Math.max(0.6, tw * 0.015);
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px, py - tw * 0.42);
      c.stroke();
      const col = f.has('zhongqiu') ? '#f29a3a' : '#e0372b';
      for (let k = 0; k < 3; k++) {
        const ly = py - tw * (0.36 - k * 0.1);
        c.fillStyle = col;
        c.beginPath();
        c.ellipse(px + tw * 0.04, ly, tw * 0.035, tw * 0.03, 0, 0, Math.PI * 2);
        c.fill();
        if (this.lit) this.lights.push([px + tw * 0.04, ly, tw * 0.22, LANTERN]);
      }
    } else if (f.has('christmas')) this.drawTree(px, py, tw * 0.4, 'pine', 0.1);
    if (vv.agenda?.phase === 'live') this.drawGathering(x, y, tw);
  }

  private drawGathering(x: number, y: number, tw: number) {
    const c = this.ctx;
    const r = tw * 0.18;
    c.strokeStyle = `rgba(${this.lit ? WARM : '210,174,98'},${this.lit ? 0.72 : 0.35})`;
    c.lineWidth = Math.max(0.8, tw * 0.018);
    c.beginPath();
    c.ellipse(x, y - tw * 0.05, r, r * 0.45, 0, 0, Math.PI * 2);
    c.stroke();
    this.dot(x, y - tw * 0.08, tw * 0.035, this.lit ? '#ffe08a' : '#d9b45f');
    if (this.lit) this.lights.push([x, y - tw * 0.1, tw * 0.6, WARM]);
  }

  private drawNoticeBoard(x: number, y: number, tw: number, agenda: AgendaView) {
    const c = this.ctx;
    const phaseColor = agenda.soon?.length ? '#c98a3b' : '#8a6e4d';
    const w = tw * 0.32;
    const h = tw * 0.3;
    c.strokeStyle = '#6b4a30';
    c.lineWidth = Math.max(0.7, tw * 0.02);
    c.beginPath();
    c.moveTo(x - w * 0.34, y + h * 0.55);
    c.lineTo(x - w * 0.34, y - h * 0.6);
    c.moveTo(x + w * 0.34, y + h * 0.55);
    c.lineTo(x + w * 0.34, y - h * 0.6);
    c.stroke();
    c.fillStyle = phaseColor;
    this.rrect(x - w / 2, y - h / 2, w, h, tw * 0.035);
    c.fill();
    c.fillStyle = '#f4e2b7';
    c.fillRect(x - w * 0.3, y - h * 0.16, w * 0.6, Math.max(1, tw * 0.018));
    c.fillRect(x - w * 0.3, y + h * 0.12, w * 0.42, Math.max(1, tw * 0.018));
    const count = (agenda.soon?.length ?? 0) + agenda.later;
    c.fillStyle = '#fff6dc';
    c.font = `700 ${Math.max(8, tw * 0.16)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (count > 0) c.fillText(String(count), x + w * 0.28, y - h * 0.04);
  }

  private drawUnfiredBricks(x: number, y: number, tw: number, count: number) {
    const c = this.ctx;
    const n = Math.min(3, count);
    for (let k = 0; k < n; k++) {
      const bx = x + (k - (n - 1) / 2) * tw * 0.12;
      const by = y + tw * 0.22 - (k % 2) * tw * 0.035;
      c.fillStyle = '#d8c5a6';
      c.strokeStyle = '#a88768';
      c.lineWidth = Math.max(0.5, tw * 0.012);
      c.fillRect(bx - tw * 0.075, by - tw * 0.04, tw * 0.15, tw * 0.08);
      c.strokeRect(bx - tw * 0.075, by - tw * 0.04, tw * 0.15, tw * 0.08);
    }
  }

  /**
   * 灯塔条幅竖着叠放的间距：布面连竹竿约占 0.34 格高；格子很小时文字有 7.5px 的下限，
   * 所以间距也不小于 11px，保证上下两条的字不会叠在一起。
   */

  private drawBanner(x: number, y: number, tw: number, title: string, color: string) {
    const c = this.ctx;
    const w = this.bannerWidth(title);
    const h = tw * 0.27;
    c.strokeStyle = '#72533b';
    c.lineWidth = Math.max(0.6, tw * 0.018);
    c.beginPath();
    c.moveTo(x - w * 0.48, y - h * 0.72);
    c.lineTo(x - w * 0.48, y + h * 0.54);
    c.moveTo(x + w * 0.48, y - h * 0.72);
    c.lineTo(x + w * 0.48, y + h * 0.54);
    c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x - w * 0.48, y - h * 0.56);
    c.lineTo(x + w * 0.48, y - h * 0.56);
    c.lineTo(x + w * 0.4, y + h * 0.44);
    c.lineTo(x, y + h * 0.24);
    c.lineTo(x - w * 0.4, y + h * 0.44);
    c.closePath();
    c.fill();
    c.fillStyle = '#fff4d8';
    c.font = `600 ${Math.max(7.5, tw * 0.105)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(title.length > 8 ? title.slice(0, 7) + '…' : title, x, y - h * 0.03);
  }

  private drawWoodpile(x: number, y: number, tw: number, step: 0 | 1 | 2 | 3) {
    if (!step) return;
    const c = this.ctx;
    const n = [0, 2, 4, 7][step];
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / 2);
      const side = k % 2 ? 1 : -1;
      const bx = x + side * tw * (0.08 + row * 0.02);
      const by = y - tw * (0.04 + row * 0.065);
      c.save();
      c.translate(bx, by);
      c.rotate(side * 0.1);
      c.fillStyle = row % 2 ? '#875a35' : '#a87546';
      c.fillRect(-tw * 0.12, -tw * 0.035, tw * 0.24, tw * 0.07);
      c.restore();
    }
  }

  private drawBroom(x: number, y: number, tw: number, moving: boolean) {
    const c = this.ctx;
    const swing = moving && !this.calm ? Math.sin(this.t * 5) * tw * 0.05 : 0;
    c.strokeStyle = '#725033';
    c.lineWidth = Math.max(0.8, tw * 0.025);
    c.beginPath();
    c.moveTo(x - tw * 0.08, y - tw * 0.13);
    c.lineTo(x + tw * 0.1 + swing, y - tw * 0.38);
    c.stroke();
    c.fillStyle = '#c49b55';
    c.beginPath();
    c.moveTo(x - tw * 0.2 + swing, y - tw * 0.08);
    c.lineTo(x + tw * 0.02 + swing, y - tw * 0.08);
    c.lineTo(x + tw * 0.08 + swing, y + tw * 0.02);
    c.lineTo(x - tw * 0.24 + swing, y + tw * 0.02);
    c.closePath();
    c.fill();
  }

  private drawDriftBottle(x: number, y: number, tw: number, title: string, index: number) {
    const c = this.ctx;
    const sway = this.calm ? 0 : Math.sin(this.t * 0.8 + index) * tw * 0.035;
    c.save();
    c.translate(x + sway, y);
    c.rotate(Math.sin(index * 2.1) * 0.15);
    c.fillStyle = '#d4a45e';
    c.strokeStyle = '#8a633a';
    c.lineWidth = Math.max(0.7, tw * 0.018);
    c.beginPath();
    c.ellipse(0, 0, tw * 0.11, tw * 0.055, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#f4dfaa';
    c.fillRect(-tw * 0.025, -tw * 0.075, tw * 0.05, tw * 0.04);
    c.fillStyle = '#fff2c5';
    c.font = `700 ${Math.max(7, tw * 0.12)}px sans-serif`;
    c.textAlign = 'center';
    c.fillText(String(index + 1), 0, tw * 0.02);
    c.restore();
    void title;
  }

  private drawPerson(x: number, y: number, s: number, p: Walker, dim: number) {
    const c = this.ctx;
    const a = this.amb;
    c.globalAlpha = dim;
    this.shadow(x, y, s * 0.32, s * 0.13, 0.2);
    const step = p.moving ? Math.sin(p.walk) : 0;
    const bob = p.moving ? Math.abs(Math.cos(p.walk)) * s * 0.04 : 0;
    y -= bob;
    // 腿
    c.fillStyle = '#4a4038';
    c.fillRect(x - s * 0.15 + step * s * 0.06, y - s * 0.3, s * 0.12, s * 0.3);
    c.fillRect(x + s * 0.03 - step * s * 0.06, y - s * 0.3, s * 0.12, s * 0.3);
    // 身子：受光的一侧亮一点
    const coat = a.season === 3 ? shade(p.color, -0.08) : shade(p.color, 0.08);
    c.fillStyle = coat;
    this.rrect(x - s * 0.23, y - s * 0.95, s * 0.46, s * 0.7, s * 0.15);
    c.fill();
    c.fillStyle = shade(coat, -0.15);
    this.rrect(x + s * 0.02 * p.face, y - s * 0.93, s * 0.21, s * 0.66, s * 0.12);
    c.fill();
    // 手臂
    c.strokeStyle = shade(coat, -0.1);
    c.lineWidth = Math.max(1, s * 0.1);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x - s * 0.2, y - s * 0.82);
    c.lineTo(x - s * 0.24 - step * s * 0.08, y - s * 0.5);
    c.moveTo(x + s * 0.2, y - s * 0.82);
    c.lineTo(x + s * 0.24 + step * s * 0.08, y - s * 0.5);
    c.stroke();
    // 头
    const hy = y - s * 1.13;
    this.dot(x, hy, s * 0.21, p.skin);
    c.fillStyle = p.hair;
    c.beginPath();
    c.arc(x, hy - s * 0.04, s * 0.21, Math.PI, 0);
    c.fill();
    c.beginPath();
    c.arc(x - p.face * s * 0.12, hy, s * 0.11, 0, Math.PI * 2);
    c.fill();
    if (a.season === 3) {
      // 围巾和毛线帽
      c.fillStyle = p.r < 0.5 ? '#c8473a' : '#e0b84a';
      c.fillRect(x - s * 0.2, y - s * 0.98, s * 0.4, s * 0.1);
      c.fillRect(x + p.face * s * 0.05, y - s * 0.95, s * 0.09, s * 0.22);
      c.fillStyle = a.fest.has('christmas') ? '#d63a2c' : p.r < 0.5 ? '#e7e2d6' : '#5a7f95';
      c.beginPath();
      c.arc(x, hy - s * 0.06, s * 0.22, Math.PI, 0);
      c.fill();
      this.dot(x, hy - s * 0.3, s * 0.07, '#ffffff');
    } else if (a.season === 1 && a.weather === 'clear' && p.r < 0.55 && !this.lit) {
      // 草帽
      c.fillStyle = '#e6c878';
      c.beginPath();
      c.ellipse(x, hy - s * 0.1, s * 0.34, s * 0.09, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#d6b45e';
      c.beginPath();
      c.arc(x, hy - s * 0.12, s * 0.16, Math.PI, 0);
      c.fill();
      c.fillStyle = '#c8473a';
      c.fillRect(x - s * 0.16, hy - s * 0.15, s * 0.32, s * 0.04);
    }
    if (p.leaving) {
      // 背着包袱
      this.dot(x - p.face * s * 0.24, y - s * 0.7, s * 0.17, '#b98b3c');
      c.strokeStyle = '#8a6428';
      c.lineWidth = Math.max(0.6, s * 0.04);
      c.beginPath();
      c.moveTo(x - p.face * s * 0.3, y - s * 0.78);
      c.lineTo(x - p.face * s * 0.18, y - s * 0.62);
      c.stroke();
    }
    if (a.weather === 'rain' || (a.weather === 'snow' && p.r < 0.4)) {
      // 伞
      const uy = hy - s * 0.42;
      c.strokeStyle = '#4a4038';
      c.lineWidth = Math.max(0.6, s * 0.04);
      c.beginPath();
      c.moveTo(x + s * 0.06, uy);
      c.lineTo(x + s * 0.06, y - s * 0.6);
      c.stroke();
      const uc = ['#d8574a', '#4c6a84', '#e0b84a', '#5d8a4a'][Math.floor(p.r * 4)];
      c.fillStyle = uc;
      c.beginPath();
      c.ellipse(x + s * 0.06, uy, s * 0.5, s * 0.3, 0, Math.PI, 0);
      c.fill();
      c.fillStyle = shade(uc, -0.2);
      c.beginPath();
      c.ellipse(x + s * 0.06, uy, s * 0.5, s * 0.08, 0, 0, Math.PI);
      c.fill();
      if (a.weather === 'snow') this.poly(SNOW, x - s * 0.36, uy - s * 0.1, x + s * 0.06, uy - s * 0.3, x + s * 0.48, uy - s * 0.1);
    }
    c.globalAlpha = 1;
  }

  /** 码头边的季节中性美术道具；积雪明显时收起，避免贴图与雪景冲突。 */
  private drawHarborProps(tw: number) {
    if (this.amb.cover > 0.18) return;
    const dock = this.map.dock;
    const props = [
      ['crate', -0.56, -0.46, 0.44],
      ['barrel', 0.42, -0.3, 0.34],
      ['rope-coil', -0.1, 0.05, 0.34],
      ['fishing-net', 0.56, 0.08, 0.46],
    ] as const;
    for (const [id, di, dj, scale] of props) {
      const [x, y] = this.iso(dock.i + di, dock.j + dj);
      this.propArt.draw(this.ctx, id, x, y + tw * 0.12, tw * scale);
    }
  }

  private drawBoat(x: number, y: number, tw: number, k: number) {
    const c = this.ctx;
    const bob = Math.sin(this.t * 1.6 + k * 1.3) * tw * 0.025;
    const roll = Math.sin(this.t * 1.1 + k) * 0.04;
    const s = tw * 0.42;
    // 船边的水纹
    c.strokeStyle = 'rgba(255,255,255,.45)';
    c.lineWidth = 1;
    c.beginPath();
    const rr = s * (0.62 + 0.08 * Math.sin(this.t * 1.6 + k * 1.3));
    c.ellipse(x, y + s * 0.1, rr, rr * 0.3, 0, 0, Math.PI * 2);
    c.stroke();
    y += bob;
    this.shadow(x, y + s * 0.08, s * 0.55, s * 0.16, 0.18);
    c.save();
    c.translate(x, y);
    c.rotate(roll);
    // 船身：两层木板
    this.poly('#7a4e2c', -s * 0.58, -s * 0.12, s * 0.58, -s * 0.12, s * 0.38, s * 0.1, -s * 0.38, s * 0.1);
    this.poly('#a8713f', -s * 0.58, -s * 0.12, s * 0.58, -s * 0.12, s * 0.48, -s * 0.02, -s * 0.48, -s * 0.02);
    c.strokeStyle = 'rgba(60,35,20,.4)';
    c.lineWidth = Math.max(0.5, s * 0.02);
    c.beginPath();
    c.moveTo(-s * 0.45, s * 0.04);
    c.lineTo(s * 0.45, s * 0.04);
    c.stroke();
    c.fillStyle = '#6b4a30';
    c.fillRect(-s * 0.02, -s * 0.95, s * 0.04, s * 0.85);
    const sail = k % 3 === 0 ? '#f4efe2' : k % 3 === 1 ? '#efe0c4' : '#f7f3ea';
    this.poly(sail, s * 0.03, -s * 0.92, s * 0.44, -s * 0.2, s * 0.03, -s * 0.2);
    this.poly(shade(sail, -0.12), s * 0.03, -s * 0.92, s * 0.18, -s * 0.2, s * 0.03, -s * 0.2);
    this.poly(k % 2 ? '#c8473a' : '#4c6a84', 0, -s * 0.95, -s * 0.18, -s * 0.9, 0, -s * 0.85);
    c.restore();
    if (this.lit) {
      this.dot(x - s * 0.04, y - s * 0.6, Math.max(0.8, s * 0.04), '#ffe08a');
      this.lights.push([x - s * 0.04, y - s * 0.6, s * 0.7, WARM]);
    }
  }

  /** 端午的龙舟：绕岛划行；back 为 true 时只画岛背后那一段，否则画前面那一段 */
  private drawDragonBoat(back: boolean) {
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
  private drawFocus() {
    const f = this.focus;
    if (!f) return;
    const c = this.ctx;
    const { tw } = this.view;
    const k = 0.55 + 0.45 * Math.sin(this.t * 4);
    c.save();
    c.strokeStyle = '#ffffff';
    c.globalAlpha = 0.5 + 0.4 * k;
    c.lineWidth = 2;
    c.setLineDash([5, 4]);
    c.lineDashOffset = -this.t * 12;
    c.beginPath();
    if (f.tree) {
      const [x, y, s] = f.tree;
      c.ellipse(x, y, s * 0.42, s * 0.18, 0, 0, Math.PI * 2);
    } else {
      const [x, y] = this.iso(f.i, f.j);
      const hw = tw / 2;
      const hh = tw / 4;
      c.moveTo(x, y - hh);
      c.lineTo(x + hw, y);
      c.lineTo(x, y + hh);
      c.lineTo(x - hw, y);
      c.closePath();
    }
    c.stroke();
    c.restore();
  }

  /* ---------------- 天空与天气 ---------------- */

  /** 云影缓缓掠过小岛 */
  private drawCloudShadows() {
    const v = this.view;
    const c = this.ctx;
    const a = this.amb;
    if (this.day.night > 0.7) return;
    const [n, al] = a.weather === 'clear' ? [2, 0.06] : a.weather === 'cloudy' ? [5, 0.1] : [6, 0.12];
    for (let k = 0; k < n; k++) {
      const r = v.w * (0.16 + hash('cr' + k) * 0.14);
      const x = ((hash('cx' + k) * (v.w + 2 * r) + this.t * (6 + k * 2)) % (v.w + 2 * r)) - r;
      const y = v.h * (0.15 + hash('cy' + k) * 0.7);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(20,30,40,${al * (1 - this.day.night)})`);
      g.addColorStop(1, 'rgba(20,30,40,0)');
      c.fillStyle = g;
      c.save();
      c.translate(x, y);
      c.scale(1, 0.5);
      c.translate(-x, -y);
      c.fillRect(x - r, y - r, r * 2, r * 2);
      c.restore();
    }
  }

  private drawBirds() {
    const a = this.amb;
    if (this.day.night > 0.5 || a.weather === 'rain' || a.weather === 'snow') return;
    const v = this.view;
    const c = this.ctx;
    c.strokeStyle = 'rgba(60,60,60,.75)';
    c.lineWidth = 1.2;
    c.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const span = v.w + 160;
      const x = ((hash('bx' + k) * span + this.t * (22 + k * 5)) % span) - 80;
      const y = v.h * (0.08 + hash('by' + k) * 0.3) + Math.sin(this.t * 0.7 + k) * 8;
      const f = Math.sin(this.t * 7 + k * 2);
      const w = 5 + hash('bw' + k) * 2;
      c.beginPath();
      c.moveTo(x - w, y - f * 3);
      c.quadraticCurveTo(x - w * 0.4, y - 2 - f * 1.5, x, y);
      c.quadraticCurveTo(x + w * 0.4, y - 2 - f * 1.5, x + w, y - f * 3);
      c.stroke();
    }
  }

  private drawDrifts() {
    const c = this.ctx;
    const kind = this.driftKind;
    if (!kind) return;
    if (kind === 'rain') {
      c.strokeStyle = 'rgba(220,232,245,.45)';
      c.lineWidth = 1;
      c.beginPath();
      for (const d of this.drifts) {
        c.moveTo(d.x, d.y);
        c.lineTo(d.x + (d.vx / d.vy) * d.size, d.y + d.size);
      }
      c.stroke();
      return;
    }
    for (const d of this.drifts) {
      c.fillStyle = d.color;
      c.globalAlpha = kind === 'snow' ? 0.9 : 0.85;
      c.beginPath();
      if (kind === 'snow') c.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      else c.ellipse(d.x, d.y, d.size, d.size * 0.5 * Math.abs(Math.cos(d.rot)) + 0.4, d.rot, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** 水面倒映的月亮（按当天的月相） */
  private drawMoon(s: Scene) {
    const n = this.day.night;
    if (n < 0.3 || this.amb.weather === 'rain' || this.amb.weather === 'snow') return;
    const [y0, m0, d0] = s.date.split('-').map(Number);
    const phase = moonPhase(new Date(y0, m0 - 1, d0, Math.floor(s.hour), (s.hour % 1) * 60));
    const illum = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    if (illum < 0.04) return;
    const v = this.view;
    const c = this.ctx;
    const cloudy = this.amb.weather === 'cloudy' ? 0.5 : 1;
    const r = Math.max(9, v.tw * 0.42);
    const x = v.w - r * 2.6;
    const y = r * 2.4;
    const al = clamp((n - 0.3) / 0.4, 0, 1) * cloudy;
    // 光晕和水面上的光带
    c.save();
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
    g.addColorStop(0, `rgba(230,236,255,${0.25 * al * illum})`);
    g.addColorStop(1, 'rgba(230,236,255,0)');
    c.fillStyle = g;
    c.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    c.fillStyle = `rgba(240,240,220,${0.22 * al * illum})`;
    for (let k = 0; k < 9; k++) {
      const yy = y + r * 1.4 + k * r * 0.55;
      const ww = r * (1.1 - k * 0.08) * (0.7 + 0.3 * Math.sin(this.t * 1.5 + k * 1.7));
      if (this.onSea(x, yy)) c.fillRect(x - ww / 2 + Math.sin(this.t + k) * 2, yy, ww, 1.5);
    }
    c.restore();
    // 月盘：月面减去一个偏移的圆，剩下的就是亮面（上弦亮在右，下弦亮在左）
    const off = phase < 0.5 ? -2 * r * (phase * 2) : 2 * r * (1 - (phase - 0.5) * 2);
    c.save();
    c.globalAlpha = al;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(200,210,230,.08)';
    c.fill();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.arc(x + off, y, r * 1.02, 0, Math.PI * 2);
    c.fillStyle = '#fbf6e0';
    c.fill('evenodd');
    c.clip('evenodd');
    c.fillStyle = 'rgba(200,196,170,.5)';
    c.beginPath();
    c.arc(x - r * 0.3, y - r * 0.2, r * 0.22, 0, Math.PI * 2);
    c.arc(x + r * 0.25, y + r * 0.3, r * 0.15, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  /** 夜里水面上星星的倒影 */
  private drawStars() {
    const n = this.day.night;
    if (n < 0.5 || this.amb.weather !== 'clear') return;
    const v = this.view;
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 60; k++) {
      const x = hash('sx' + k) * v.w;
      const y = hash('sy' + k) * v.h;
      if (!this.onSea(x, y)) continue;
      const tw2 = 0.5 + 0.5 * Math.sin(this.t * (1 + hash('st' + k) * 2) + k);
      c.fillStyle = `rgba(255,255,240,${(0.25 + 0.5 * tw2) * (n - 0.5) * 2})`;
      const r = 0.6 + hash('sr' + k) * 0.9;
      c.fillRect(x - r / 2, y - r / 2, r, r);
    }
    c.restore();
  }

  /** 萤火虫：夏夜在树林边 */
  private drawFireflies() {
    const a = this.amb;
    if (a.season !== 1 || this.day.night < 0.4 || a.weather === 'rain') return;
    const forest = this.map.all.filter((t) => t.type === 'forest');
    if (!forest.length) return;
    for (let k = 0; k < 18; k++) {
      const t = forest[Math.floor(hash('ff' + k) * forest.length)];
      const i = t.i + Math.sin(this.t * 0.4 + k * 1.7) * 0.6;
      const j = t.j + Math.cos(this.t * 0.33 + k * 2.3) * 0.6;
      const [x, y] = this.iso(i, j);
      const on = 0.5 + 0.5 * Math.sin(this.t * 2.2 + k * 3.1);
      if (on < 0.3) continue;
      this.lights.push([x, y - this.view.tw * 0.25, this.view.tw * 0.16 * on, '200,255,120']);
    }
  }

  /** 中秋、元宵的孔明灯：从岛上缓缓升起 */
  private drawSkyLanterns() {
    const f = this.amb.fest;
    if (!(f.has('zhongqiu') || f.has('yuanxiao')) || this.day.night < 0.3 || this.calm) return;
    const v = this.view;
    const c = this.ctx;
    for (let k = 0; k < 10; k++) {
      const ph = (this.t * 0.025 + hash('sl' + k)) % 1;
      const x = v.w * (0.25 + hash('slx' + k) * 0.5) + Math.sin(this.t * 0.5 + k) * 10 + ph * 30;
      const y = v.h * (0.7 - ph * 0.85);
      const s = Math.max(3, v.tw * 0.12) * (1 - ph * 0.5);
      const al = ph < 0.1 ? ph * 10 : ph > 0.85 ? (1 - ph) / 0.15 : 1;
      c.globalAlpha = al;
      this.poly('#ffb35a', x - s * 0.5, y - s, x + s * 0.5, y - s, x + s * 0.35, y, x - s * 0.35, y);
      c.globalAlpha = 1;
      this.lights.push([x, y - s * 0.4, s * 3 * al, '255,170,80']);
    }
  }

  private drawSparks() {
    if (!this.sparks.length) return;
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    const big = Math.max(1, this.view.h / 400);
    for (const p of this.sparks) {
      const k = p.rocket ? 1 : 1 - p.life / p.max;
      if (p.flash) {
        const fr = this.view.h * 0.16 * (1.2 - k);
        const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, fr);
        g.addColorStop(0, `rgba(255,240,200,${0.35 * k})`);
        g.addColorStop(1, 'rgba(255,240,200,0)');
        c.globalAlpha = 1;
        c.fillStyle = g;
        c.fillRect(p.x - fr, p.y - fr, fr * 2, fr * 2);
        continue;
      }
      c.fillStyle = p.color;
      c.globalAlpha = clamp(k * 1.2, 0, 1);
      const r = (p.rocket ? 1.6 : 1.2 + k * 1.6) * big;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
      if (!p.rocket && k > 0.5) {
        c.globalAlpha = (k - 0.5) * 0.5;
        c.beginPath();
        c.arc(p.x - p.vx * 0.03, p.y - p.vy * 0.03, r * 0.8, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  /** 环境光：一天里的颜色乘到画面上；阴雨天整体发灰 */
  private drawAmbient() {
    const v = this.view;
    const c = this.ctx;
    const w = this.amb.weather;
    const wt = w === 'rain' ? [200, 206, 216] : w === 'snow' ? [222, 226, 234] : w === 'cloudy' ? [232, 234, 238] : [255, 255, 255];
    const t = this.day.tint.map((q, k) => (q * wt[k]) / 255);
    if (t.every((q) => q > 252)) return;
    c.save();
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = rgb(t);
    c.fillRect(0, 0, v.w, v.h);
    c.restore();
    // 日出日落时，画面一角有一层暖光
    if (this.day.warm > 0.05) {
      const g = c.createLinearGradient(v.w, 0, 0, v.h);
      g.addColorStop(0, `rgba(255,170,90,${0.22 * this.day.warm})`);
      g.addColorStop(1, 'rgba(255,170,90,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, v.w, v.h);
    }
  }

  private drawLights() {
    if (!this.lights.length) return;
    const c = this.ctx;
    const k = clamp(Math.max(this.day.night, this.scene?.light === 'day' ? 0 : 0.6), 0.35, 1);
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const [x, y, r, col] of this.lights) {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${col},${0.85 * k})`);
      g.addColorStop(0.35, `rgba(${col},${0.32 * k})`);
      g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    c.restore();
  }

  private label(x: number, y: number, txt: string, dot: string | null, hl: boolean, muted = false) {
    const c = this.ctx;
    const tw = this.view.tw;
    c.font = `600 ${tw < 30 ? 10.5 : 12}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    c.textBaseline = 'middle';
    const w = c.measureText(txt).width;
    const bw = w + (dot ? 22 : 14);
    const bh = tw < 30 ? 18 : 21;
    c.globalAlpha = muted ? 0.82 : 1;
    c.fillStyle = 'rgba(20,30,20,.12)';
    this.rrect(x - bw / 2, y - bh / 2 + 1.5, bw, bh, bh / 2);
    c.fill();
    c.fillStyle = this.theme.label;
    c.strokeStyle = hl ? this.theme.accent : this.theme.line;
    c.lineWidth = hl ? 2.2 : 1;
    this.rrect(x - bw / 2, y - bh / 2, bw, bh, bh / 2);
    c.fill();
    c.stroke();
    if (dot) {
      c.fillStyle = dot;
      c.beginPath();
      c.arc(x - bw / 2 + 9, y, 3, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = this.theme.ink;
    c.textAlign = 'left';
    c.fillText(txt, x - bw / 2 + (dot ? 16 : 7), y + 0.5);
    c.globalAlpha = 1;
  }

  /* ---------------- 每帧 ---------------- */

  private draw() {
    const s = this.scene;
    const v = this.view;
    const c = this.ctx;
    if (!v.w || !s) return;
    const a = this.amb;
    // 晚间结算时把画面拨到黄昏
    const shift = [0, 0.6, 0, -0.6][a.season];
    const hour = s.light === 'dusk' && s.hour >= 5.5 && s.hour < 17.5 ? 18.4 + shift : s.hour;
    this.day = dayLight(hour, a.season);
    c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    c.clearRect(0, 0, v.w, v.h);
    const { tw } = v;
    const hw = tw / 2;
    const hh = tw / 4;
    const m = this.map;
    this.lights = [];

    this.drawSea();
    this.drawGround(s);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.ground, 0, 0);
    c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

    // 小溪的流水
    if (a.cover <= 0.6) {
      c.strokeStyle = 'rgba(255,255,255,.45)';
      c.lineWidth = Math.max(0.6, tw * 0.025);
      c.lineCap = 'round';
      c.beginPath();
      for (const t of m.water) {
        const [x, y] = this.iso(t.i, t.j);
        for (let k = 0; k < 2; k++) {
          const ph = (this.t * 0.35 + tileHash(t.i, t.j, 60 + k)) % 1;
          const px = x + (ph - 0.5) * hw * 0.9 * (k ? 1 : -1) * 0.5;
          const py = y + (ph - 0.5) * hh * 1.2;
          c.moveTo(px - hw * 0.12, py + hh * 0.04);
          c.lineTo(px + hw * 0.12, py - hh * 0.04);
        }
      }
      c.stroke();
    } else {
      // 结冰的溪面上几道裂纹
      c.strokeStyle = 'rgba(255,255,255,.7)';
      c.lineWidth = Math.max(0.5, tw * 0.015);
      c.beginPath();
      for (const t of m.water) {
        const [x, y] = this.iso(t.i, t.j);
        c.moveTo(x - hw * 0.3, y);
        c.lineTo(x, y - hh * 0.2);
        c.lineTo(x + hw * 0.2, y + hh * 0.1);
      }
      c.stroke();
    }

    // 码头栈桥与船
    const [di, dj] = m.pierDir;
    for (let k = 0; k <= m.pierLen; k++) {
      const pi = m.dock.i + di * (k + 0.2);
      const pj = m.dock.j + dj * (k + 0.2);
      const [x, y] = this.iso(pi, pj);
      const w = 0.28;
      const pa = this.iso(pi - w, pj - 0.5);
      const pb = this.iso(pi + w, pj - 0.5);
      const pc = this.iso(pi + w, pj + 0.5);
      const pd = this.iso(pi - w, pj + 0.5);
      // 桩子
      c.fillStyle = '#4e3522';
      c.fillRect(pd[0] - tw * 0.015, pd[1], tw * 0.03, tw * 0.16);
      c.fillRect(pc[0] - tw * 0.015, pc[1], tw * 0.03, tw * 0.16);
      this.poly('#6b4a30', pa[0], pa[1] + tw * 0.06, pb[0], pb[1] + tw * 0.06, pc[0], pc[1] + tw * 0.06, pd[0], pd[1] + tw * 0.06);
      this.poly(a.cover > 0.4 ? mix('#a8794a', SNOW, 0.6) : '#a8794a', pa[0], pa[1], pb[0], pb[1], pc[0], pc[1], pd[0], pd[1]);
      // 木板缝
      c.strokeStyle = 'rgba(80,50,30,.35)';
      c.lineWidth = Math.max(0.5, tw * 0.012);
      c.beginPath();
      for (const f of [0.25, 0.5, 0.75]) {
        const l = this.iso(pi - w, pj - 0.5 + f);
        const r = this.iso(pi + w, pj - 0.5 + f);
        c.moveTo(l[0], l[1]);
        c.lineTo(r[0], r[1]);
      }
      c.stroke();
      if (k === m.pierLen) {
        // 栈桥尽头的灯
        c.fillStyle = '#3e3a36';
        c.fillRect(x - hw * 0.32, y - tw * 0.3, tw * 0.025, tw * 0.32);
        this.dot(x - hw * 0.32 + tw * 0.012, y - tw * 0.32, tw * 0.035, this.lit ? '#ffe08a' : '#e8e2cc');
        if (this.lit) this.lights.push([x - hw * 0.32 + tw * 0.012, y - tw * 0.32, tw * 0.6, WARM]);
      }
    }
    const ships = Math.min(8, s.dockShips);
    for (let k = 0; k < ships; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const along = Math.floor(k / 2);
      const [x, y] = this.iso(m.dock.i + side * 0.85, m.dock.j + 0.7 + along * 0.85);
      this.drawBoat(x, y, tw, k);
    }

    // 地块上的东西
    const occupied = new Map<number, VillageView>();
    for (const vv of s.villages) occupied.set(vv.slot, vv);
    const lmAt = new Map<number, LandmarkView>();
    for (const l of s.landmarks) lmAt.set(l.index, l);
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      if (t.type === 'mountain') this.drawMountain(x, y, t, tw);
      if (t === m.lighthouse) {
        this.drawLighthouse(x, y, tw);
        for (const banner of this.lighthouseBannerLayout(s.lighthouseBanners)) {
          this.drawBanner(banner.x, banner.y, tw, banner.title, '#d8c9a7');
        }
      }
      if (t === m.granary) this.drawGranary(x, y, tw, this.shownGranaryRatio(s), s.granaryBusy);
      if (t === m.chores) {
        this.drawHouse(x + hw * 0.2, y - hh * 0.2, tw * 0.3, '#8a8578', '#e3dccb', false, false, !!s.chores.live);
        this.drawWoodpile(x + hw * 0.55, y + hh * 0.22, tw, s.chores.woodpile);
        // 即将开始：扫帚靠在门口；进行中：扫帚动起来
        if (s.chores.live || s.chores.soon) this.drawBroom(x + hw * 0.72, y + hh * 0.12, tw, !!s.chores.live);
      }
      if (t === m.dock) this.drawHarborProps(tw);
      if (t.type === 'plaza' && t.village >= 0) {
        const vv = occupied.get(t.village);
        if (vv) {
          this.drawWell(x, y, tw, vv, t);
          if (vv.agenda) {
            const [ax, ay] = this.villageAgendaAnchor(vv);
            if (this.hasNoticeBoard(vv.agenda)) this.drawNoticeBoard(ax, ay, tw, vv.agenda);
            if (vv.agenda.ended) this.drawUnfiredBricks(x, y, tw, vv.agenda.ended);
            for (const b of this.villageBannerLayout(vv)) this.drawBanner(b.x, b.y, tw, b.title, vv.roof);
          }
        }
      }
      if (t.village >= 0 && t.slotIdx >= 0) {
        const vv = occupied.get(t.village);
        if (vv && t.slotIdx < vv.houses) {
          const g = this.grow.get(vv.projectId);
          const isNew = g && g.anim < 1 && t.slotIdx === vv.houses - 1;
          const k = isNew ? 0.3 + 0.7 * g!.anim : 1;
          const dust = [0, 0.1, 0.45, 0.6][vv.stage];
          const roof = mix(shade(vv.roof, (t.v - 0.5) * 0.25), '#9a9588', dust);
          const boarded = vv.stage === 3 && t.slotIdx % 2 === 1;
          const wall = boarded ? '#cfc4ab' : vv.stage >= 2 ? '#e6dcc6' : '#efe5cf';
          // 越冷清的村落，夜里亮灯的人家越少
          const litFrac = [0.9, 0.5, 0.25, 0.12][vv.stage];
          this.drawHouse(x, y, tw * 0.36 * k, roof, wall, boarded, vv.stage < 2, hash(vv.projectId + t.slotIdx) < litFrac);
          if (vv.stage >= 2 && t.slotIdx % 2 === 0) this.drawWeeds(x - hw * 0.4, y + hh * 0.2, tw, t.i * 17 + t.j);
        }
      }
      const lm = t.landmark >= 0 ? lmAt.get(t.landmark) : undefined;
      if (lm) {
        const g = this.grow.get('lm:' + lm.projectId);
        this.drawLandmark(x, y, tw, lm, g ? g.anim : 1, s.selected?.kind === 'project' && s.selected.id === lm.projectId);
        continue;
      }
      for (const tr of t.trees) this.drawTree(x + (tr.dx - tr.dy) * hw, y + (tr.dx + tr.dy) * hh, tw * 0.42 * tr.s, tr.kind, tileHash(t.i, t.j, 70 + Math.round(tr.dx * 100)));
    }

    for (let k = 0; k < s.drifting.length; k++) {
      const [x, y] = this.driftBottleAnchor(k);
      this.drawDriftBottle(x, y, tw, s.drifting[k].title, k);
    }
    for (const bottle of this.pickedBottles) {
      c.save();
      c.globalAlpha = 1 - bottle.t / 0.4;
      this.drawDriftBottle(bottle.x, bottle.y - tw * 0.9 * (bottle.t / 0.4), tw, bottle.title, bottle.index);
      c.restore();
    }

    // 小人
    const s0 = Math.max(5, tw * 0.2);
    const list = [...this.walkers.values()].sort((a, b) => a.x + a.y - (b.x + b.y));
    let selW: [Walker, number, number] | null = null;
    for (const p of list) {
      const [x, y] = this.iso(p.x, p.y);
      if (s.selected?.kind === 'task' && s.selected.id === p.id) {
        selW = [p, x, y];
        c.strokeStyle = this.theme.accent;
        c.lineWidth = 2;
        c.beginPath();
        c.ellipse(x, y, s0 * 0.75, s0 * 0.32, 0, 0, Math.PI * 2);
        c.stroke();
      }
      this.drawPerson(x, y, s0, p, s.light === 'night' ? 0.88 : 1);
    }
    if (a.fest.has('duanwu') && this.day.night < 0.6) this.drawDragonBoat(false);

    this.drawFocus();

    // 天空、天气与光线
    this.drawCloudShadows();
    this.drawBirds();
    this.drawAmbient();
    this.drawStars();
    this.drawMoon(s);
    this.drawFireflies();
    this.drawSkyLanterns();
    this.drawLights();
    this.drawSparks();
    this.drawDrifts();

    // 统一提示管线的非破坏性转场：阶段变差落灰，阶段变好散灰。
    for (const cue of this.stageCues) {
      const village = s.villages.find((v) => v.projectId === cue.projectId);
      if (!village) continue;
      const center = m.villages[village.slot].center;
      const [x, y] = this.iso(center.i, center.j);
      const k = Math.min(1, cue.t / 1.2);
      c.strokeStyle = cue.to >= 2 ? `rgba(130,130,115,${(1 - k) * 0.5})` : `rgba(225,235,205,${(1 - k) * 0.65})`;
      c.lineWidth = Math.max(1, tw * 0.035);
      c.beginPath();
      c.ellipse(x, y - tw * 0.12, tw * (0.5 + k * 0.6), tw * (0.24 + k * 0.3), 0, 0, Math.PI * 2);
      c.stroke();
    }

    for (const ripple of this.bellRipples) {
      const [x, y] = this.iso(ripple.at.i, ripple.at.j);
      const k = Math.min(1, ripple.t / 1.2);
      c.strokeStyle = `rgba(238,205,112,${(1 - k) * 0.82})`;
      c.lineWidth = Math.max(1, tw * 0.028);
      c.beginPath();
      c.ellipse(x, y - tw * 0.52, tw * (0.18 + k * 1.15), tw * (0.07 + k * 0.45), 0, 0, Math.PI * 2);
      c.stroke();
    }

    // 落砖时的光圈
    for (const pl of this.pulses) {
      const [x, y] = this.iso(pl.at.i, pl.at.j);
      const k = pl.t / 1.4;
      c.strokeStyle = `rgba(226,173,47,${(1 - k) * 0.9})`;
      c.lineWidth = 3;
      c.beginPath();
      c.ellipse(x, y, tw * (0.4 + k * 1.6), tw * (0.2 + k * 0.8), 0, 0, Math.PI * 2);
      c.stroke();
    }

    // 海雾：未结算的日子
    const fog = this.shownFog(s);
    if (fog > 0.01) {
      const [cx, cy] = this.iso(m.N / 2, m.N / 2);
      for (let k = 0; k < 9; k++) {
        const ang = hash('fog' + k) * Math.PI * 2 + this.t * 0.03 * (k % 2 ? 1 : -1);
        const rr = tw * (1.5 + hash('fr' + k) * 3.2);
        const x = cx + Math.cos(ang) * tw * 3.2 * hash('fd' + k) * 1.4 + Math.sin(this.t * 0.1 + k) * tw * 0.4;
        const y = cy + Math.sin(ang) * tw * 1.6 * hash('fe' + k) * 1.4;
        const g = c.createRadialGradient(x, y, 0, x, y, rr * 2);
        const al = 0.55 * fog;
        g.addColorStop(0, `rgba(236,240,240,${al})`);
        g.addColorStop(1, 'rgba(236,240,240,0)');
        c.fillStyle = g;
        c.fillRect(x - rr * 2, y - rr * 2, rr * 4, rr * 4);
      }
      c.fillStyle = `rgba(230,234,235,${0.18 * fog})`;
      c.fillRect(0, 0, v.w, v.h);
    }

    // 标签
    const sel = s.selected;
    for (const vv of s.villages) {
      const [x, y] = this.villageLabelAnchor(vv);
      this.label(x, y, this.villageLabelText(vv), vv.roof, sel?.kind === 'project' && sel.id === vv.projectId, vv.stage >= 2);
    }
    {
      const [x, y] = this.iso(m.dock.i + 0.2, m.dock.j + m.pierLen + 0.6);
      this.label(x, y + tw * 0.2, s.dockShips ? `码头 · ${s.dockShips} 船` : '码头', null, sel?.kind === 'dock');
      const [gx, gy] = this.iso(m.granary.i, m.granary.j);
      this.label(gx, gy + tw * 0.32, s.granaryLabel, '#e2ad2f', sel?.kind === 'granary');
      const ch = s.chores;
      if (ch.count || ch.live || ch.soon || ch.later || ch.ended) {
        const [cx2, cy2] = this.iso(m.chores.i, m.chores.j);
        this.label(cx2, cy2 + tw * 0.3, this.choresLabelText(ch), '#8a8578', sel?.kind === 'chores', true);
      }
    }
    for (const l of s.landmarks) {
      const site = m.landmarks[l.index];
      if (!site) continue;
      const hl = sel?.kind === 'project' && sel.id === l.projectId;
      if (!hl && v.zoom < 1.4) continue;
      const [x, y] = this.iso(site.i, site.j);
      this.label(x, y - tw * 0.95, l.name, l.roof, hl, !hl);
    }
    if (selW) {
      const [p, x, y] = selW;
      c.font = `600 ${tw < 30 ? 10.5 : 12}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
      const txt = p.title.length > 16 ? p.title.slice(0, 15) + '…' : p.title;
      const w2 = c.measureText(txt).width;
      const bw = w2 + 14;
      const bh = tw < 30 ? 18 : 20;
      const ly = y - s0 * 1.6 - bh / 2 - 2;
      c.fillStyle = this.theme.accent;
      this.rrect(x - bw / 2, ly - bh / 2, bw, bh, 6);
      c.fill();
      c.fillStyle = this.theme.accentInk;
      c.textAlign = 'center';
      c.fillText(txt, x, ly + 0.5);
    }
  }
}
