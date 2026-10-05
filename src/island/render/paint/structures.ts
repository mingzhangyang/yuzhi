import type { AgendaView, LandmarkView, Scene, VillageView } from '../model';
import type { Tile } from '../../map';
import { LANTERN, SNOW, SNOW_SHADE, WARM } from '../style';
import { clamp, hash, shade } from '../utils';
import { IslandTerrainPainter } from './terrain';

/** Buildings and tangible island props. */
export abstract class IslandStructurePainter extends IslandTerrainPainter {
  protected facePoly(fill: string, x0: number, y0: number, w: number, h: number, slope: number) {
    this.poly(fill, x0, y0, x0 + w, y0 + w * slope, x0 + w, y0 + w * slope - h, x0, y0 - h);
  }

  /**
   * 小房子：石基、两面墙、带框的窗、门、四坡屋顶（有瓦线和屋脊），
   * 冬天屋顶积雪，冷天和傍晚烟囱冒烟，节日挂灯笼贴对联。返回窗户位置，供夜里点灯。
   */

  protected drawHouse(x: number, y: number, s: number, roof: string, wall = '#efe5cf', boarded = false, deco = true, lamp = true): [number, number] {
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

  protected houseFestival(x: number, y: number, s: number, hh: number, H: number, dx0: number, dy0: number, dw: number, dh: number) {
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

  protected drawFlag(x: number, y: number, s: number, color: string, seed: number, star = false) {
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

  protected drawLighthouse(x: number, y: number, tw: number) {
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

  /** 房子的屏幕轮廓（地面三角 + 墙 + 出檐四坡顶），与 drawHouse 的比例一致 */
  protected houseOutline(x: number, y: number, s: number): [number, number][] {
    const hw = s / 2;
    return [
      [x - hw, y],
      [x, y + s / 4],
      [x + hw, y],
      [x + hw * 1.14, y - s * 0.5],
      [x, y - s * 0.92],
      [x - hw * 1.14, y - s * 0.5],
    ];
  }

  /** 井：井身和井顶是实心的，两根立柱之间是空的 */
  protected wellOutline(x: number, y: number, tw: number): [number, number][][] {
    const r = tw * 0.1;
    return [
      [
        [x - r, y + r * 0.5],
        [x + r, y + r * 0.5],
        [x + r, y - r],
        [x - r, y - r],
      ],
      [
        [x - r * 1.3, y - r * 1.9],
        [x, y - r * 2.7],
        [x + r * 1.3, y - r * 1.9],
      ],
    ];
  }

  /** 地标：石台加主楼（规模大的还有后面的塔），随建成动画纵向伸展 */
  protected landmarkOutline(x: number, y: number, tw: number, l: LandmarkView, anim: number): [number, number][] {
    const k = 0.25 + 0.75 * anim;
    const top = y - tw * (l.size >= 6 ? 1.0 : 0.62) * k;
    return [
      [x - tw * 0.39, y + tw * 0.1],
      [x, y + tw * 0.28],
      [x + tw * 0.39, y + tw * 0.1],
      [x + tw * 0.39, top],
      [x - tw * 0.39, top],
    ];
  }

  protected drawLandmark(x: number, y: number, tw: number, l: LandmarkView, anim: number, selected: boolean): [number, number] {
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

  protected shownGranaryRatio(scene: Scene): number {
    const a = this.granaryTransition;
    if (!a) return scene.granaryRatio;
    const k = a.t * a.t * (3 - 2 * a.t);
    return a.from + (a.to - a.from) * k;
  }

  protected shownFog(scene: Scene): number {
    const a = this.fogTransition;
    if (!a) return scene.fog;
    const k = a.t * a.t * (3 - 2 * a.t);
    return a.from + (a.to - a.from) * k;
  }

  protected drawGranary(x: number, y: number, tw: number, ratio: number, busy = false) {
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

  protected drawWeeds(x: number, y: number, tw: number, seed: number) {
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

  protected drawWell(x: number, y: number, tw: number, vv: VillageView, t: Tile) {
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

  protected drawGathering(x: number, y: number, tw: number) {
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

  protected drawNoticeBoard(x: number, y: number, tw: number, agenda: AgendaView) {
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

  protected drawUnfiredBricks(x: number, y: number, tw: number, count: number) {
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

  protected drawBanner(x: number, y: number, tw: number, title: string, color: string) {
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

  protected drawWoodpile(x: number, y: number, tw: number, step: 0 | 1 | 2 | 3) {
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

  protected drawBroom(x: number, y: number, tw: number, moving: boolean) {
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

  protected drawDriftBottle(x: number, y: number, tw: number, title: string, index: number) {
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

  protected drawHarborProps(tw: number) {
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

  protected drawBoat(x: number, y: number, tw: number, k: number) {
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
}
