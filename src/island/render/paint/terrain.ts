import type { Scene } from '../model';
import { tileHash, type Tile } from '../../map';
import { SNOW, WARM } from '../style';
import { clamp, hash, mix, shade } from '../utils';
import { IslandPaintBase } from './base';

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
    col = shade(col, (t.v - 0.5) * 0.1);
    if (a.cover > 0 && t.type !== 'water') col = mix(col, SNOW, clamp(a.cover * (0.86 + 0.18 * tileHash(t.i, t.j, 41)), 0, 0.92));
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

  protected drawMountain(x: number, y: number, t: Tile, tw: number) {
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
