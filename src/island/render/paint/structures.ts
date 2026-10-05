import type { AgendaView, LandmarkView, Scene, VillageView } from '../model';
import type { Tile } from '../../map';
import { LANTERN, SNOW, SNOW_SHADE, WARM, type HouseVariant } from '../style';
import { clamp, hash, shade } from '../utils';
import { IslandTerrainPainter } from './terrain';

/** Buildings and tangible island props. */
export type LandmarkKind = 'clock' | 'library' | 'windmill';

/** 按地标位轮换：前三座地标一定各不相同 */
export function landmarkKind(index: number): LandmarkKind {
  return (['clock', 'library', 'windmill'] as const)[((index % 3) + 3) % 3];
}

export abstract class IslandStructurePainter extends IslandTerrainPainter {
  protected facePoly(fill: string, x0: number, y0: number, w: number, h: number, slope: number) {
    this.poly(fill, x0, y0, x0 + w, y0 + w * slope, x0 + w, y0 + w * slope - h, x0, y0 - h);
  }

  /**
   * 小房子：石基、两面墙、带框的窗、门、四坡屋顶（有瓦线和屋脊），
   * 冬天屋顶积雪，冷天和傍晚烟囱冒烟，节日挂灯笼贴对联。返回窗户位置，供夜里点灯。
   */

  protected drawHouse(x: number, y: number, s: number, roof: string, wall = '#efe5cf', boarded = false, deco = true, lamp = true, variant: HouseVariant = 0): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const hw = s / 2;
    const hh = s / 4;
    // 门窗按一层的高度排布；两层的房子墙更高，楼上再开一扇窗
    const H0 = s * 0.5;
    const H = variant === 2 ? s * 0.8 : H0;
    // 房子局部的等距坐标：pi、pj ∈ [-0.5, 0.5] 是主屋的地面，z 向上
    const P = (pi: number, pj: number, z: number): [number, number] => [x + ((pi - pj) * s) / 2, y + ((pi + pj) * s) / 4 - z];
    this.shadow(x + s * 0.12, y + hh * 0.45, s * 0.66, s * 0.27);
    if (variant === 3) this.drawLeanTo(P, s, H0, roof, wall);
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
    const wh = H0 * 0.32;
    const wx = x - hw * 0.7;
    const wy = y + hh * 0.3 - H0 * 0.36;
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
    const dh = H0 * 0.6;
    this.facePoly('#5e4532', dx0, dy0, dw, dh, -0.5);
    this.facePoly('#7a5a40', dx0 + dw * 0.12, dy0 - dw * 0.06, dw * 0.76, dh * 0.9, -0.5);
    this.dot(dx0 + dw * 0.7, dy0 - dw * 0.35 - dh * 0.45, Math.max(0.5, s * 0.018), '#e2c56a');
    const upLit = variant === 2 && this.lit && !boarded && lamp;
    if (variant === 2) {
      // 楼上：左墙一扇窗、右墙一扇小窗，中间一道腰檐
      const uy = wy - H0 * 0.52;
      this.facePoly('#7b5e45', wx + ww * 0.8 - s * 0.02, uy + ww * 0.4 + s * 0.02, ww + s * 0.04, wh + s * 0.04, 0.5);
      this.facePoly(boarded ? '#5a4a3a' : upLit ? '#ffd677' : '#8fa5b2', wx + ww * 0.8, uy + ww * 0.4, ww, wh, 0.5);
      this.facePoly(shade(wall, -0.3), x + hw * 0.4, y + hh * 0.6 - H0 * 1.0, ww * 0.8, wh * 0.9, -0.5);
      const [b0x, b0y] = P(-0.5, 0.5, H0 * 1.02);
      const [b1x, b1y] = P(0.5, 0.5, H0 * 1.02);
      const [b2x, b2y] = P(0.5, -0.5, H0 * 1.02);
      c.strokeStyle = shade(roof, -0.2);
      c.lineWidth = Math.max(0.8, s * 0.035);
      c.beginPath();
      c.moveTo(b0x, b0y);
      c.lineTo(b1x, b1y);
      c.lineTo(b2x, b2y);
      c.stroke();
    }
    let cx: number;
    let cy: number;
    const cw = s * 0.07;
    if (variant === 1) {
      [cx, cy] = this.drawGableRoof(P, s, H, roof, wall);
    } else {
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
    cx = x + hw * 0.42;
    cy = ay + (R[1] - ay) * 0.42 + s * 0.05;
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
    if (upLit) this.lights.push([wx + ww * 1.3, wy - H0 * 0.52 + ww * 0.65 - wh / 2, s * 0.45, WARM]);
    return [wx + ww / 2, wy + ww * 0.25 - wh / 2];
  }

  /** 双坡顶：屋脊平行于左墙，右墙上露出三角形的山墙。返回烟囱落点。 */
  protected drawGableRoof(P: (pi: number, pj: number, z: number) => [number, number], s: number, H: number, roof: string, wall: string): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const o = 0.08;
    const rh = s * 0.36;
    const d = s * 0.04;
    const e1 = P(-0.5 - o, 0.5 + o, H - d);
    const e2 = P(0.5 + o, 0.5 + o, H - d);
    const k1 = P(-0.5 - o, 0, H + rh);
    const k2 = P(0.5 + o, 0, H + rh);
    const b1 = P(-0.5 - o, -0.5 - o, H - d);
    const b2 = P(0.5 + o, -0.5 - o, H - d);
    const pts = (...q: [number, number][]) => q.flat();
    // 后坡（大半被挡住）、右侧山墙、前坡
    this.poly(shade(roof, -0.3), ...pts(b1, b2, k2, k1));
    const g0 = P(0.5, 0.5, H);
    const g1 = P(0.5, -0.5, H);
    const g2 = P(0.5, 0, H + rh * 0.92);
    this.poly(shade(wall, -0.2), ...pts(g0, g1, g2));
    // 山墙上一个小圆窗
    const [gx, gy] = P(0.5, 0, H + rh * 0.38);
    this.dot(gx, gy, s * 0.045, shade(wall, -0.45));
    this.poly(roof, ...pts(e1, e2, k2, k1));
    // 檐口的厚度与山墙边的封檐板
    this.poly(shade(roof, -0.35), ...pts(e1, e2, [e2[0], e2[1] + s * 0.035], [e1[0], e1[1] + s * 0.035]));
    c.strokeStyle = shade(roof, -0.3);
    c.lineWidth = Math.max(0.8, s * 0.035);
    c.beginPath();
    c.moveTo(e2[0], e2[1]);
    c.lineTo(k2[0], k2[1]);
    c.lineTo(b2[0], b2[1]);
    c.stroke();
    // 瓦线平行于屋脊
    c.strokeStyle = shade(roof, -0.12);
    c.lineWidth = Math.max(0.5, s * 0.02);
    c.beginPath();
    for (const f of [0.33, 0.66]) {
      const l = [e1[0] + (k1[0] - e1[0]) * f, e1[1] + (k1[1] - e1[1]) * f];
      const r = [e2[0] + (k2[0] - e2[0]) * f, e2[1] + (k2[1] - e2[1]) * f];
      c.moveTo(l[0], l[1]);
      c.lineTo(r[0], r[1]);
    }
    c.stroke();
    c.strokeStyle = shade(roof, 0.25);
    c.beginPath();
    c.moveTo(k1[0], k1[1]);
    c.lineTo(k2[0], k2[1]);
    c.stroke();
    // 烟囱
    const [cx, cy] = P(-0.22, 0.2, H + rh * 0.62);
    const cw = s * 0.07;
    this.poly('#a0796a', cx - cw, cy, cx, cy + cw * 0.5, cx, cy + cw * 0.5 - s * 0.2, cx - cw, cy - s * 0.2);
    this.poly('#80594c', cx, cy + cw * 0.5, cx + cw, cy, cx + cw, cy - s * 0.2, cx, cy + cw * 0.5 - s * 0.2);
    if (a.cover > 0.15) {
      const f = 0.35 + 0.45 * a.cover;
      const l = [k1[0] + (e1[0] - k1[0]) * f, k1[1] + (e1[1] - k1[1]) * f] as [number, number];
      const r = [k2[0] + (e2[0] - k2[0]) * f, k2[1] + (e2[1] - k2[1]) * f] as [number, number];
      this.poly(SNOW, ...pts([k1[0], k1[1] - s * 0.015], [k2[0], k2[1] - s * 0.015], r, l));
      this.poly(SNOW, cx - cw, cy - s * 0.2, cx, cy + cw * 0.5 - s * 0.2, cx + cw, cy - s * 0.2, cx, cy - cw * 0.5 - s * 0.2);
    }
    return [cx, cy];
  }

  /** 披屋：贴在主屋左后方的一间矮屋，单坡顶朝外斜下。先画，主屋会压住它的一角。 */
  protected drawLeanTo(P: (pi: number, pj: number, z: number) => [number, number], s: number, H0: number, roof: string, wall: string) {
    const c = this.ctx;
    const a = this.amb;
    const i0 = -1.08;
    const i1 = -0.5;
    const j0 = -0.25;
    const j1 = 0.42;
    const zl = H0 * 0.6;
    const zh = H0 * 0.95;
    const pts = (...q: [number, number][]) => q.flat();
    // 朝前的一面墙
    this.poly(shade(wall, -0.04), ...pts(P(i0, j1, 0), P(i1, j1, 0), P(i1, j1, zh), P(i0, j1, zl)));
    this.poly('#b9ad97', ...pts(P(i0, j1, 0), P(i1, j1, 0), P(i1, j1, H0 * 0.07), P(i0, j1, H0 * 0.07)));
    // 一扇小门
    const [dx, dy] = P(-0.78, j1, 0);
    this.facePoly('#6a4e38', dx, dy, s * 0.1, H0 * 0.48, 0.5);
    // 单坡顶
    const o = 0.06;
    const r = a.cover > 0.3 ? SNOW : shade(roof, 0.05);
    this.poly(r, ...pts(P(i0 - o, j0 - o, zl - s * 0.02), P(i1, j0 - o, zh), P(i1, j1 + o, zh), P(i0 - o, j1 + o, zl - s * 0.02)));
    this.poly(shade(roof, -0.3), ...pts(P(i0 - o, j1 + o, zl - s * 0.02), P(i1, j1 + o, zh), [P(i1, j1 + o, zh)[0], P(i1, j1 + o, zh)[1] + s * 0.03], [P(i0 - o, j1 + o, zl - s * 0.02)[0], P(i0 - o, j1 + o, zl - s * 0.02)[1] + s * 0.03]));
    c.strokeStyle = shade(roof, -0.15);
    c.lineWidth = Math.max(0.5, s * 0.018);
    c.beginPath();
    for (const f of [0.33, 0.66]) {
      const [ax, ay] = P(i0 - o, j0 + (j1 - j0) * f, zl - s * 0.02);
      const [bx, by] = P(i1, j0 + (j1 - j0) * f, zh);
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
    }
    c.stroke();
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

  /** 地标局部的等距坐标：pi、pj 以地块宽为单位，z 为屏幕像素高度 */
  protected isoAt(x: number, y: number, tw: number) {
    return (pi: number, pj: number, z: number): [number, number] => [x + ((pi - pj) * tw) / 2, y + ((pi + pj) * tw) / 4 - z];
  }

  /** 一个等距方块：画朝左前（+j）和朝右前（+i）两面，可选顶面 */
  protected isoBox(P: (pi: number, pj: number, z: number) => [number, number], i0: number, i1: number, j0: number, j1: number, z0: number, z1: number, left: string, right: string, top?: string) {
    const f = (...q: [number, number][]) => q.flat();
    this.poly(left, ...f(P(i0, j1, z0), P(i1, j1, z0), P(i1, j1, z1), P(i0, j1, z1)));
    this.poly(right, ...f(P(i1, j1, z0), P(i1, j0, z0), P(i1, j0, z1), P(i1, j1, z1)));
    if (top) this.poly(top, ...f(P(i0, j0, z1), P(i1, j0, z1), P(i1, j1, z1), P(i0, j1, z1)));
  }

  /** 四坡攒尖顶：底边四角 + 顶点，画朝前的两面，冬天上半截压雪 */
  protected isoPyramid(P: (pi: number, pj: number, z: number) => [number, number], h: number, z0: number, z1: number, roof: string) {
    const f = (...q: [number, number][]) => q.flat();
    const L = P(-h, h, z0);
    const F = P(h, h, z0);
    const R = P(h, -h, z0);
    const A = P(0, 0, z1);
    this.poly(shade(roof, -0.35), ...f(L, F, [F[0], F[1] + (z1 - z0) * 0.08], R, F));
    this.poly(roof, ...f(L, F, A));
    this.poly(shade(roof, -0.22), ...f(F, R, A));
    if (this.amb.cover > 0.15) {
      const k = 0.4 + 0.4 * this.amb.cover;
      const at = (q: [number, number]): [number, number] => [A[0] + (q[0] - A[0]) * k, A[1] + (q[1] - A[1]) * k];
      this.poly(SNOW, ...f(A, at(L), at(F)));
      this.poly(SNOW_SHADE, ...f(A, at(F), at(R)));
    }
  }

  /** 钟楼：方形石塔，左墙上一面钟（指针随岛上的时间走），顶上钟亭、木围栏、攒尖顶和小旗 */
  protected drawClockTower(x: number, y: number, tw: number, roof: string, sc: number, seed: number): [number, number] {
    const c = this.ctx;
    const P = this.isoAt(x, y, tw);
    const w = 0.16;
    const H = tw * 0.82 * sc;
    const bell = tw * 0.17 * sc;
    this.shadow(x + tw * 0.08, y + tw * 0.06, tw * 0.3, tw * 0.12);
    // 塔身与石缝
    this.isoBox(P, -w, w, -w, w, 0, H, '#efe6d2', '#d3c8b1');
    c.strokeStyle = 'rgba(120,105,80,.28)';
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    for (let k = 1; k < 6; k++) {
      const z = (H * k) / 6;
      const [a0, a1] = P(-w, w, z);
      const [b0, b1] = P(w, w, z);
      const [d0, d1] = P(w, -w, z);
      c.moveTo(a0, a1);
      c.lineTo(b0, b1);
      c.lineTo(d0, d1);
    }
    c.stroke();
    // 拱门（右墙）与一道窄窗（左墙）
    const [dx, dy] = P(w, 0.04, 0);
    this.facePoly('#6a4e38', dx, dy, tw * 0.07, H * 0.2, -0.5);
    this.dot(dx + tw * 0.035, dy - tw * 0.02 - H * 0.2, tw * 0.035, '#6a4e38');
    const [sx, sy] = P(-0.04, w, H * 0.38);
    this.facePoly(this.lit ? '#ffd677' : '#6f7f88', sx, sy, tw * 0.04, H * 0.1, 0.5);
    // 钟面：画在左墙的斜面上
    const [cx, cy] = P(0, w, H * 0.74);
    const r = tw * 0.058 * sc;
    c.save();
    c.translate(cx, cy);
    c.transform(1, 0.5, 0, 1, 0, 0);
    c.fillStyle = '#5a4a3a';
    c.beginPath();
    c.arc(0, 0, r * 1.18, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = this.lit ? '#fff1c8' : '#f8f3e6';
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    const hour = this.scene?.hour ?? 12;
    c.strokeStyle = '#3d3128';
    c.lineCap = 'round';
    c.lineWidth = Math.max(0.8, r * 0.16);
    const ha = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
    const ma = (hour % 1) * Math.PI * 2 - Math.PI / 2;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(ha) * r * 0.5, Math.sin(ha) * r * 0.5);
    c.moveTo(0, 0);
    c.lineTo(Math.cos(ma) * r * 0.8, Math.sin(ma) * r * 0.8);
    c.stroke();
    c.restore();
    // 钟亭：四角立柱，中间露出黑洞洞的钟室和一口铜钟
    const z0 = H;
    const z1 = H + bell;
    this.isoBox(P, -w * 0.92, w * 0.92, -w * 0.92, w * 0.92, z0, z1, '#4a3c30', '#3a2f26');
    const [bx, by] = P(0, w * 0.92, z0 + bell * 0.55);
    this.dot(bx, by, tw * 0.035 * sc, '#c99a3c');
    for (const [pi, pj] of [[-w, w], [w, w], [w, -w]] as const) {
      const [p0, p1] = P(pi, pj, z0);
      c.fillStyle = '#e8dcc4';
      c.fillRect(p0 - tw * 0.015, p1 - bell, tw * 0.03, bell);
    }
    // 围栏
    this.isoBox(P, -w * 1.25, w * 1.25, -w * 1.25, w * 1.25, z0 - tw * 0.02, z0 + tw * 0.035, '#8a6242', '#6e4d32', '#9c7350');
    this.isoPyramid(P, w * 1.45, z1, z1 + tw * 0.34 * sc, roof);
    const [ax, ay] = P(0, 0, z1 + tw * 0.34 * sc);
    this.drawFlag(ax, ay + tw * 0.02, tw * 0.5, roof, seed);
    if (this.lit) this.lights.push([cx, cy, tw * 0.45, WARM]);
    return [cx, cy];
  }

  /** 藏书阁：两层楼阁，底层宽、上层收窄，两重出檐，一排格子窗 */
  protected drawLibrary(x: number, y: number, tw: number, roof: string, sc: number): [number, number] {
    const c = this.ctx;
    const P = this.isoAt(x, y, tw);
    const f = (...q: [number, number][]) => q.flat();
    const wi = 0.3 * sc;
    const wj = 0.24 * sc;
    const h1 = tw * 0.2 * sc;
    const pillar = '#8a3b2a';
    this.shadow(x + tw * 0.08, y + tw * 0.08, tw * 0.42, tw * 0.17);
    // 台阶
    this.isoBox(P, -0.12, 0.12, wj, wj + 0.1, 0, tw * 0.03, '#d6ccb6', '#bfb49c', '#e4dac4');
    // 底层
    this.isoBox(P, -wi, wi, -wj, wj, 0, h1, '#f1e4c8', '#d7c7a6');
    // 柱子与格子窗
    c.strokeStyle = pillar;
    c.lineWidth = Math.max(0.8, tw * 0.025);
    c.beginPath();
    for (const u of [-1, -0.33, 0.33, 1]) {
      const [a0, a1] = P(u * wi, wj, 0);
      c.moveTo(a0, a1);
      c.lineTo(a0, a1 - h1);
    }
    for (const u of [0.33, -0.33, -1]) {
      const [a0, a1] = P(wi, u * wj, 0);
      c.moveTo(a0, a1);
      c.lineTo(a0, a1 - h1);
    }
    c.stroke();
    const lightsAt: [number, number][] = [];
    for (const u of [-0.66, 0, 0.66]) {
      const [wx, wy] = P(u * wi - 0.06, wj, h1 * 0.3);
      this.facePoly(this.lit ? '#ffd677' : '#8fa5b2', wx, wy, tw * 0.1 * sc, h1 * 0.45, 0.5);
      lightsAt.push([wx + tw * 0.05, wy - h1 * 0.2]);
    }
    const [ddx, ddy] = P(wi, 0.06, 0);
    this.facePoly('#6a4e38', ddx, ddy, tw * 0.09, h1 * 0.7, -0.5);
    // 第一重檐：一圈斜坡裙檐，四角微微上翘
    const o = 0.12;
    const zE = h1 - tw * 0.01;
    const zI = h1 + tw * 0.1 * sc;
    const ii = wi * 0.7;
    const ij = wj * 0.7;
    const eL = P(-wi - o, wj + o, zE);
    const eF = P(wi + o, wj + o, zE);
    const eR = P(wi + o, -wj - o, zE);
    const nL = P(-ii, ij, zI);
    const nF = P(ii, ij, zI);
    const nR = P(ii, -ij, zI);
    this.poly(roof, ...f(eL, eF, nF, nL));
    this.poly(shade(roof, -0.22), ...f(eF, eR, nR, nF));
    this.poly(shade(roof, -0.38), ...f(eL, eF, [eF[0], eF[1] + tw * 0.025], [eL[0], eL[1] + tw * 0.025]));
    c.strokeStyle = shade(roof, -0.3);
    c.lineWidth = Math.max(0.8, tw * 0.03);
    c.lineCap = 'round';
    c.beginPath();
    for (const e of [eL, eF, eR]) {
      c.moveTo(e[0], e[1]);
      c.lineTo(e[0] + (e === eL ? -1 : e === eR ? 1 : 0) * tw * 0.03, e[1] - tw * 0.04);
    }
    c.stroke();
    // 上层
    const h2 = tw * 0.15 * sc;
    this.isoBox(P, -ii, ii, -ij, ij, zI, zI + h2, '#f1e4c8', '#d7c7a6');
    c.strokeStyle = pillar;
    c.lineWidth = Math.max(0.7, tw * 0.02);
    c.beginPath();
    for (const u of [-1, 0, 1]) {
      const [a0, a1] = P(u * ii, ij, zI);
      c.moveTo(a0, a1);
      c.lineTo(a0, a1 - h2);
    }
    c.stroke();
    for (const u of [-0.5, 0.5]) {
      const [wx, wy] = P(u * ii - 0.05, ij, zI + h2 * 0.25);
      this.facePoly(this.lit ? '#ffd677' : '#8fa5b2', wx, wy, tw * 0.08 * sc, h2 * 0.5, 0.5);
      lightsAt.push([wx + tw * 0.04, wy - h2 * 0.25]);
    }
    // 第二重檐：攒尖顶，顶上一颗宝珠
    const z2 = zI + h2;
    this.isoPyramid(P, ii + 0.1, z2 - tw * 0.01, z2 + tw * 0.26 * sc, roof);
    const [tx, ty] = P(0, 0, z2 + tw * 0.26 * sc);
    c.fillStyle = '#c99a3c';
    c.fillRect(tx - tw * 0.008, ty - tw * 0.06, tw * 0.016, tw * 0.06);
    this.dot(tx, ty - tw * 0.07, tw * 0.025, '#e2b84a');
    if (this.lit) for (const [lx, ly] of lightsAt) this.lights.push([lx, ly, tw * 0.3, WARM]);
    return lightsAt[0];
  }

  /** 风车：收分的圆石塔、尖顶，四片帆慢慢转 */
  protected drawWindmill(x: number, y: number, tw: number, roof: string, sc: number, seed: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const rb = tw * 0.22 * sc;
    const rt = tw * 0.15 * sc;
    const h = tw * 0.62 * sc;
    const by = y + tw * 0.04;
    this.shadow(x + tw * 0.1, by + tw * 0.02, rb * 1.4, rb * 0.5);
    // 塔身：左亮右暗的渐变
    const g = c.createLinearGradient(x - rb, 0, x + rb, 0);
    g.addColorStop(0, '#f3ead6');
    g.addColorStop(0.55, '#e0d3b6');
    g.addColorStop(1, '#bfb092');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x - rb, by);
    c.lineTo(x - rt, by - h);
    c.lineTo(x + rt, by - h);
    c.lineTo(x + rb, by);
    c.ellipse(x, by, rb, rb * 0.4, 0, 0, Math.PI);
    c.fill();
    // 石缝
    c.strokeStyle = 'rgba(120,105,80,.25)';
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    for (let k = 1; k < 5; k++) {
      const f = k / 5;
      const r = rb + (rt - rb) * f;
      c.ellipse(x, by - h * f, r, r * 0.4, 0, 0.1, Math.PI - 0.1);
    }
    c.stroke();
    // 门和小窗
    c.fillStyle = '#6a4e38';
    c.fillRect(x - tw * 0.05, by - h * 0.26 + rb * 0.35, tw * 0.07, h * 0.26);
    this.dot(x - tw * 0.015, by - h * 0.26 + rb * 0.35, tw * 0.035, '#6a4e38');
    const winY = by - h * 0.6;
    c.fillStyle = this.lit ? '#ffd677' : '#8fa5b2';
    c.fillRect(x - tw * 0.1, winY, tw * 0.05, tw * 0.07);
    // 尖顶
    const top = by - h;
    c.fillStyle = shade(roof, -0.3);
    c.beginPath();
    c.ellipse(x, top, rt * 1.25, rt * 0.5, 0, 0, Math.PI * 2);
    c.fill();
    this.poly(roof, x - rt * 1.25, top, x, top - tw * 0.3 * sc, x, top + rt * 0.5);
    this.poly(shade(roof, -0.22), x, top - tw * 0.3 * sc, x + rt * 1.25, top, x, top + rt * 0.5);
    if (a.cover > 0.15) this.poly(SNOW, x - rt * 0.6, top - tw * 0.16 * sc, x, top - tw * 0.3 * sc, x + rt * 0.5, top - tw * 0.17 * sc);
    // 帆：轴心在塔顶左前方，四片帆架加帆布格子
    const hx = x - rt * 0.55;
    const hy = top + tw * 0.02;
    const len = tw * 0.52 * sc;
    const ang = this.t * 0.5 + seed;
    c.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const th = ang + (k * Math.PI) / 2;
      // 帆面朝左前方：横向压扁一点
      const ux = Math.cos(th) * 0.82;
      const uy = Math.sin(th);
      const vx = -uy * 0.82;
      const vy = ux / 0.82;
      const p = (u: number, v: number): [number, number] => [hx + (ux * u + vx * v) * len, hy + (uy * u + vy * v * 0.82) * len];
      c.strokeStyle = '#6b4a30';
      c.lineWidth = Math.max(0.8, tw * 0.02);
      c.beginPath();
      c.moveTo(hx, hy);
      c.lineTo(...p(1, 0));
      c.stroke();
      const q = [p(0.22, 0), p(1, 0), p(1, 0.17), p(0.22, 0.17)];
      this.poly(a.cover > 0.4 ? '#eef1f3' : '#f1e8d4', ...q.flat());
      c.strokeStyle = 'rgba(107,74,48,.6)';
      c.lineWidth = Math.max(0.5, tw * 0.008);
      c.beginPath();
      for (const u of [0.48, 0.74]) {
        c.moveTo(...p(u, 0));
        c.lineTo(...p(u, 0.17));
      }
      c.moveTo(...p(0.22, 0.085));
      c.lineTo(...p(1, 0.085));
      c.stroke();
    }
    this.dot(hx, hy, tw * 0.028, '#4a3a2c');
    const lw: [number, number] = [x - tw * 0.075, winY + tw * 0.035];
    if (this.lit) this.lights.push([lw[0], lw[1], tw * 0.35, WARM]);
    return lw;
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

  /** 房子的屏幕轮廓（地面三角 + 墙 + 出檐屋顶），与 drawHouse 各样式的比例一致 */
  protected houseOutline(x: number, y: number, s: number, variant: HouseVariant = 0): [number, number][] {
    const hw = s / 2;
    const wall = s * (variant === 2 ? 0.8 : 0.5);
    const top = wall + s * (variant === 1 ? 0.4 : 0.42);
    return [
      [x - hw * (variant === 3 ? 2.2 : 1), y],
      [x, y + s / 4],
      [x + hw, y],
      [x + hw * 1.14, y - wall],
      [x, y - top],
      [x - hw * 1.14, y - wall],
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

  /** 地标：石台加楼体，高度按样式（钟楼最高），随建成动画纵向伸展 */
  protected landmarkOutline(x: number, y: number, tw: number, l: LandmarkView, anim: number): [number, number][] {
    const k = 0.25 + 0.75 * anim;
    const sc = l.size >= 6 ? 1.12 : 0.92;
    const kind = landmarkKind(l.index);
    const h = kind === 'clock' ? 1.33 : kind === 'library' ? 0.86 : 0.98;
    const top = y - tw * h * sc * k;
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
    // Canvas 的 scale 只影响即时绘制；追加到 lights 的坐标需要显式同步同一变换。
    const lightStart = this.lights.length;
    const kind = landmarkKind(l.index);
    const sc = big ? 1.12 : 0.92;
    let win: [number, number];
    if (kind === 'clock') win = this.drawClockTower(x, y, tw, roof, sc, l.index);
    else if (kind === 'library') win = this.drawLibrary(x, y, tw, roof, sc);
    else win = this.drawWindmill(x, y, tw, roof, sc, l.index);
    if (kind !== 'clock') {
      const fx = x - hw * 0.62;
      const fy = y - tw * 0.02;
      this.drawFlag(fx, fy, tw * 0.6, l.roof, l.index);
    }
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
