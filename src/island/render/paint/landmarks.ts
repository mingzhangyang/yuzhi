import type { LandmarkView } from '../model';
import { LANDMARK_HEIGHT, landmarkKind, SNOW, WARM, type LandmarkKind } from '../style';
import { shade } from '../utils';
import { IslandStructurePainter } from './structures';

const f = (...q: [number, number][]) => q.flat();

/**
 * 永久地标：石台 + 八种楼体，按地标位轮换（landmarkKind）。钟楼、藏书阁、风车画在 structures.ts，
 * 观星台、玻璃温室、海港会馆、纪念塔、山亭画在这里；造型参考 docs/art/landmark-concepts.webp，
 * 都用程序化的清晰轮廓重画，不贴整栋概念图。
 */
export abstract class IslandLandmarkPainter extends IslandStructurePainter {
  /** 观星台：圆石塔、木栏平台，顶上一座金属穹顶，缝里探出一支铜望远镜 */
  protected drawObservatory(x: number, y: number, tw: number, roof: string, sc: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const r = tw * 0.17 * sc;
    const h = tw * 0.36 * sc;
    const by = y + tw * 0.03;
    const top = by - h;
    this.shadow(x + tw * 0.1, by + tw * 0.02, r * 1.6, r * 0.55);
    // 塔身
    const g = c.createLinearGradient(x - r, 0, x + r, 0);
    g.addColorStop(0, '#f1e7d2');
    g.addColorStop(0.55, '#dccfb2');
    g.addColorStop(1, '#b9ab8e');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x - r, top);
    c.lineTo(x - r, by);
    c.ellipse(x, by, r, r * 0.4, 0, Math.PI, 0, true);
    c.lineTo(x + r, top);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(120,105,80,.25)';
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    for (let k = 1; k < 4; k++) c.ellipse(x, by - (h * k) / 4, r, r * 0.4, 0, 0.1, Math.PI - 0.1);
    c.stroke();
    // 门与一扇窗
    c.fillStyle = '#6a4e38';
    c.fillRect(x - tw * 0.045, by - h * 0.42 + r * 0.38, tw * 0.07, h * 0.42);
    this.dot(x - tw * 0.01, by - h * 0.42 + r * 0.38, tw * 0.035, '#6a4e38');
    const win: [number, number] = [x - r * 0.62, by - h * 0.62];
    c.fillStyle = this.lit ? '#ffd677' : '#8fa5b2';
    c.fillRect(win[0] - tw * 0.02, win[1] - tw * 0.035, tw * 0.04, tw * 0.07);
    // 平台：一圈木栏
    c.fillStyle = '#8a6242';
    c.beginPath();
    c.ellipse(x, top, r * 1.2, r * 0.48, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#a77b52';
    c.beginPath();
    c.ellipse(x, top - tw * 0.012, r * 1.2, r * 0.48, 0, 0, Math.PI * 2);
    c.fill();
    // 穹顶：半球，左亮右暗；两道接缝
    const rd = r * 0.95;
    const dy = top - tw * 0.02;
    const dg = c.createLinearGradient(x - rd, 0, x + rd, 0);
    dg.addColorStop(0, '#c4ccd4');
    dg.addColorStop(0.5, '#98a4b0');
    dg.addColorStop(1, '#6c7886');
    c.fillStyle = dg;
    c.beginPath();
    c.ellipse(x, dy, rd, rd * 0.4, 0, 0, Math.PI);
    c.ellipse(x, dy, rd, rd, 0, Math.PI, 0);
    c.fill();
    c.strokeStyle = 'rgba(50,60,70,.35)';
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    c.ellipse(x, dy, rd * 0.5, rd, 0, Math.PI, 0);
    c.stroke();
    if (a.cover > 0.15) {
      c.fillStyle = SNOW;
      c.beginPath();
      c.ellipse(x - rd * 0.1, dy - rd * 0.78, rd * 0.55, rd * 0.24, 0, 0, Math.PI * 2);
      c.fill();
    }
    // 观测缝：夜里透出灯光
    this.poly(this.lit ? '#ffd98a' : '#2f3842', x + rd * 0.05, dy - rd * 0.98, x + rd * 0.35, dy - rd * 0.9, x + rd * 0.42, dy - rd * 0.1, x + rd * 0.12, dy - rd * 0.05);
    // 望远镜：从缝里斜向右上方伸出
    const t0: [number, number] = [x + rd * 0.25, dy - rd * 0.55];
    const len = tw * 0.2 * sc;
    const t1: [number, number] = [t0[0] + len * 0.78, t0[1] - len * 0.62];
    c.lineCap = 'round';
    c.strokeStyle = '#8a6328';
    c.lineWidth = Math.max(1.2, tw * 0.055 * sc);
    c.beginPath();
    c.moveTo(...t0);
    c.lineTo(...t1);
    c.stroke();
    c.strokeStyle = '#c99a4a';
    c.lineWidth = Math.max(0.8, tw * 0.03 * sc);
    c.beginPath();
    c.moveTo(t0[0] - tw * 0.005, t0[1] - tw * 0.008);
    c.lineTo(t1[0] - tw * 0.005, t1[1] - tw * 0.008);
    c.stroke();
    this.dot(t1[0], t1[1], tw * 0.03 * sc, '#5a4126');
    // 顶上一颗小球，和项目颜色呼应
    this.dot(x, dy - rd - tw * 0.012, tw * 0.022, roof);
    if (this.lit) {
      this.lights.push([win[0], win[1], tw * 0.3, WARM]);
      this.lights.push([x + rd * 0.25, dy - rd * 0.6, tw * 0.3, WARM]);
    }
    return win;
  }

  /** 玻璃温室：石砌矮基、铁框玻璃墙和双坡玻璃顶，里面一丛丛绿植和花，顶上一座小亭 */
  protected drawGreenhouse(x: number, y: number, tw: number, roof: string, sc: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const P = this.isoAt(x, y, tw);
    const wi = 0.32 * sc;
    const wj = 0.22 * sc;
    const z0 = tw * 0.035;
    const H = tw * 0.27 * sc;
    const rh = tw * 0.17 * sc;
    const frame = '#4f6b5a';
    this.shadow(x + tw * 0.08, y + tw * 0.08, tw * 0.42, tw * 0.17);
    this.isoBox(P, -wi, wi, -wj, wj, 0, z0, '#cfc6b0', '#b5ab94');
    // 后面两面玻璃墙（透过前墙能看到）
    const backGlass = this.lit ? 'rgba(236,214,150,.85)' : 'rgba(170,205,198,.9)';
    this.poly(backGlass, ...f(P(-wi, -wj, z0), P(wi, -wj, z0), P(wi, -wj, H), P(-wi, -wj, H)));
    this.poly(shade(backGlass, -0.08), ...f(P(-wi, -wj, z0), P(-wi, wj, z0), P(-wi, wj, H), P(-wi, -wj, H)));
    // 里面的绿植与花：叶色随季节
    const leaf = a.cover > 0.3 ? '#6f8f6a' : ['#6fae55', '#5f9a48', '#8a9a48', '#5f8a5a'][a.season] ?? '#6fae55';
    const bloom = ['#f2a6c0', '#f6d36b', '#e88a5a', '#e9e4f2'][a.season] ?? '#f2a6c0';
    for (const [u, v, s] of [[-0.6, -0.3, 1], [0, -0.5, 1.2], [0.55, -0.2, 0.9], [-0.25, 0.35, 0.8], [0.4, 0.4, 1]] as const) {
      const [px, py] = P(u * wi, v * wj, z0);
      this.dot(px, py - tw * 0.06 * s * sc, tw * 0.07 * s * sc, leaf);
      this.dot(px - tw * 0.03, py - tw * 0.05 * s * sc, tw * 0.045 * s * sc, shade(leaf, 0.12));
      this.dot(px + tw * 0.02, py - tw * 0.1 * s * sc, tw * 0.016, bloom);
    }
    // 前面两面玻璃墙
    const glass = this.lit ? 'rgba(255,226,150,.5)' : 'rgba(214,238,232,.5)';
    this.poly(glass, ...f(P(-wi, wj, z0), P(wi, wj, z0), P(wi, wj, H), P(-wi, wj, H)));
    this.poly(shade(glass, -0.06), ...f(P(wi, wj, z0), P(wi, -wj, z0), P(wi, -wj, H), P(wi, wj, H)));
    // 双坡玻璃顶：屋脊沿 i 方向，朝左前的一坡和右侧的山墙
    const R0 = P(-wi, 0, H + rh);
    const R1 = P(wi, 0, H + rh);
    this.poly(this.lit ? 'rgba(255,230,165,.7)' : 'rgba(226,244,240,.75)', ...f(P(-wi, wj, H), P(wi, wj, H), R1, R0));
    this.poly(this.lit ? 'rgba(240,210,140,.7)' : 'rgba(196,224,220,.75)', ...f(P(wi, wj, H), P(wi, -wj, H), R1));
    if (a.cover > 0.3) this.poly(SNOW, ...f(R0, R1, P(wi, wj * 0.35, H + rh * 0.65), P(-wi, wj * 0.35, H + rh * 0.65)));
    // 铁框
    c.strokeStyle = frame;
    c.lineWidth = Math.max(0.6, tw * 0.014);
    c.lineJoin = 'round';
    c.beginPath();
    for (const u of [-1, -0.5, 0, 0.5, 1]) {
      c.moveTo(...P(u * wi, wj, z0));
      c.lineTo(...P(u * wi, wj, H));
      c.lineTo(...P(u * wi, 0, H + rh));
    }
    for (const v of [0, -1]) {
      c.moveTo(...P(wi, v * wj, z0));
      c.lineTo(...P(wi, v * wj, H));
    }
    c.moveTo(...P(-wi, wj, H));
    c.lineTo(...P(wi, wj, H));
    c.lineTo(...P(wi, -wj, H));
    c.lineTo(...R1);
    c.lineTo(...P(wi, wj, H));
    c.moveTo(...R0);
    c.lineTo(...R1);
    c.moveTo(...P(-wi, wj, H * 0.55));
    c.lineTo(...P(wi, wj, H * 0.55));
    c.lineTo(...P(wi, -wj, H * 0.55));
    c.stroke();
    // 门：右侧山墙中间，用项目颜色
    const [ddx, ddy] = P(wi, wj * 0.3, z0);
    this.facePoly(shade(roof, -0.15), ddx, ddy, tw * 0.08 * sc, H * 0.62, -0.5);
    // 屋脊正中一座小亭和尖顶
    const zc = H + rh;
    this.isoBox(P, -0.05, 0.05, -0.05, 0.05, zc - tw * 0.01, zc + tw * 0.05, 'rgba(226,244,240,.9)', 'rgba(196,224,220,.9)');
    this.isoPyramid(P, 0.07, zc + tw * 0.05, zc + tw * 0.11 * sc, frame);
    const [ax, ay] = P(0, 0, zc + tw * 0.11 * sc);
    this.dot(ax, ay - tw * 0.015, tw * 0.018, '#e2b84a');
    const glow = P(0, 0, H * 0.6);
    if (this.lit) this.lights.push([glow[0], glow[1], tw * 0.5, WARM]);
    return glow;
  }

  /** 海港会馆：石基木构的大屋，双坡顶，山墙上一枚锚；门前两根系缆桩和一盏港灯 */
  protected drawHarborHall(x: number, y: number, tw: number, roof: string, sc: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const P = this.isoAt(x, y, tw);
    const wi = 0.27 * sc;
    const wj = 0.2 * sc;
    const z0 = tw * 0.05;
    const H = tw * 0.25 * sc;
    const rh = tw * 0.2 * sc;
    const o = 0.05;
    const beam = '#6e4d32';
    this.shadow(x + tw * 0.08, y + tw * 0.08, tw * 0.42, tw * 0.17);
    // 石基与墙
    this.isoBox(P, -wi, wi, -wj, wj, 0, z0, '#bfb7a3', '#a59c87');
    this.isoBox(P, -wi, wi, -wj, wj, z0, H, '#efe2c6', '#d3c3a2');
    // 木构：转角和中间的立柱、一道腰梁
    c.strokeStyle = beam;
    c.lineWidth = Math.max(0.7, tw * 0.022);
    c.beginPath();
    for (const u of [-1, 0, 1]) {
      c.moveTo(...P(u * wi, wj, z0));
      c.lineTo(...P(u * wi, wj, H));
    }
    c.moveTo(...P(wi, -wj, z0));
    c.lineTo(...P(wi, -wj, H));
    c.moveTo(...P(-wi, wj, H * 0.62));
    c.lineTo(...P(wi, wj, H * 0.62));
    c.lineTo(...P(wi, -wj, H * 0.62));
    c.stroke();
    // 左墙两扇窗、右墙一道门
    const lightsAt: [number, number][] = [];
    for (const u of [-0.55, 0.45]) {
      const [wx, wy] = P(u * wi - 0.04, wj, z0 + H * 0.12);
      this.facePoly(this.lit ? '#ffd677' : '#8fa5b2', wx, wy, tw * 0.08 * sc, H * 0.3, 0.5);
      lightsAt.push([wx + tw * 0.04, wy - H * 0.15]);
    }
    const [ddx, ddy] = P(wi, 0.07, z0);
    this.facePoly('#5a3f2c', ddx, ddy, tw * 0.1 * sc, H * 0.52, -0.5);
    // 双坡顶：屋脊沿 i 方向，朝左前一坡 + 右侧山墙
    const zr = H + rh;
    const eL = P(-wi - o, wj + o, H - tw * 0.01);
    const eF = P(wi + o, wj + o, H - tw * 0.01);
    const eR = P(wi + o, -wj - o, H - tw * 0.01);
    const R0 = P(-wi - o, 0, zr);
    const R1 = P(wi + o, 0, zr);
    this.poly('#e6d7b8', ...f(P(wi, wj, H), P(wi, -wj, H), P(wi, 0, zr - tw * 0.02)));
    this.poly(roof, ...f(eL, eF, R1, R0));
    this.poly(shade(roof, -0.35), ...f(eL, eF, [eF[0], eF[1] + tw * 0.025], [eL[0], eL[1] + tw * 0.025]));
    c.strokeStyle = shade(roof, -0.3);
    c.lineWidth = Math.max(0.8, tw * 0.025);
    c.beginPath();
    c.moveTo(...eF);
    c.lineTo(...R1);
    c.lineTo(...eR);
    c.moveTo(...R0);
    c.lineTo(...R1);
    c.stroke();
    if (a.cover > 0.15) this.poly(SNOW, ...f(R0, R1, P(wi + o, wj * 0.45, zr - rh * 0.45), P(-wi - o, wj * 0.45, zr - rh * 0.45)));
    // 山墙上的锚
    const [gx, gy] = P(wi, 0, H + rh * 0.38);
    c.save();
    c.translate(gx, gy);
    c.transform(1, -0.5, 0, 1, 0, 0);
    c.strokeStyle = '#3e4c5c';
    c.lineWidth = Math.max(0.6, tw * 0.014);
    c.lineCap = 'round';
    const s = tw * 0.05 * sc;
    c.beginPath();
    c.moveTo(0, -s);
    c.lineTo(0, s);
    c.moveTo(-s * 0.5, -s * 0.5);
    c.lineTo(s * 0.5, -s * 0.5);
    c.moveTo(-s * 0.75, s * 0.25);
    c.quadraticCurveTo(0, s * 1.4, s * 0.75, s * 0.25);
    c.stroke();
    c.restore();
    // 屋脊上一根烟囱
    this.isoBox(P, -wi * 0.55, -wi * 0.38, -0.04, 0.04, zr - tw * 0.06, zr + tw * 0.06, '#9a8d78', '#7f735f');
    // 门前：两根系缆桩缠着绳子，一盏港灯
    for (const [pi, pj] of [[wi + 0.1, wj + 0.12], [wi + 0.1, -wj + 0.02]] as const) {
      const [px, py] = P(pi, pj, 0);
      c.fillStyle = '#5a4030';
      c.fillRect(px - tw * 0.016, py - tw * 0.09, tw * 0.032, tw * 0.09);
      this.dot(px, py - tw * 0.09, tw * 0.018, '#6e4d32');
      c.fillStyle = '#c8ab72';
      c.fillRect(px - tw * 0.018, py - tw * 0.06, tw * 0.036, tw * 0.018);
    }
    const [lx, ly] = P(-wi - 0.04, wj + 0.12, 0);
    c.fillStyle = '#3e3a36';
    c.fillRect(lx - tw * 0.01, ly - tw * 0.3 * sc, tw * 0.02, tw * 0.3 * sc);
    const lamp: [number, number] = [lx, ly - tw * 0.31 * sc];
    this.dot(lamp[0], lamp[1], tw * 0.03, this.lit ? '#ffe08a' : '#e8e2cc');
    if (this.lit) {
      for (const [wx, wy] of lightsAt) this.lights.push([wx, wy, tw * 0.3, WARM]);
      this.lights.push([lamp[0], lamp[1], tw * 0.5, WARM]);
    }
    return lightsAt[0];
  }

  /** 纪念塔：三级石阶托着一座收分的方尖石塔，正面嵌一块碑，塔顶铜盆里燃着长明火 */
  protected drawMemorial(x: number, y: number, tw: number, roof: string, sc: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const P = this.isoAt(x, y, tw);
    this.shadow(x + tw * 0.1, y + tw * 0.06, tw * 0.32, tw * 0.13);
    // 石阶
    this.isoBox(P, -0.24, 0.24, -0.24, 0.24, 0, tw * 0.05, '#d6ccb6', '#bfb49c', a.cover > 0.3 ? SNOW : '#e4dac4');
    this.isoBox(P, -0.17, 0.17, -0.17, 0.17, tw * 0.05, tw * 0.1, '#ddd3bd', '#c4b9a1', a.cover > 0.3 ? SNOW : '#e9dfc9');
    // 塔身：底宽顶窄
    const z0 = tw * 0.1;
    const z1 = z0 + tw * 0.68 * sc;
    const w0 = 0.11 * sc;
    const w1 = 0.075 * sc;
    this.poly('#efe6d2', ...f(P(-w0, w0, z0), P(w0, w0, z0), P(w1, w1, z1), P(-w1, w1, z1)));
    this.poly('#d3c8b1', ...f(P(w0, w0, z0), P(w0, -w0, z0), P(w1, -w1, z1), P(w1, w1, z1)));
    c.strokeStyle = 'rgba(120,105,80,.25)';
    c.lineWidth = Math.max(0.5, tw * 0.01);
    c.beginPath();
    for (let k = 1; k < 5; k++) {
      const t = k / 5;
      const w = w0 + (w1 - w0) * t;
      const z = z0 + (z1 - z0) * t;
      c.moveTo(...P(-w, w, z));
      c.lineTo(...P(w, w, z));
      c.lineTo(...P(w, -w, z));
    }
    c.stroke();
    // 碑：左墙下部一块深色石板，上面一道项目颜色的饰带
    const [bx, by] = P(-w0 * 0.6, w0, z0 + tw * 0.08 * sc);
    this.facePoly('#a69a82', bx, by, tw * 0.1 * sc, tw * 0.16 * sc, 0.5);
    this.facePoly(roof, bx, by - tw * 0.18 * sc, tw * 0.1 * sc, tw * 0.025, 0.5);
    // 塔顶：一圈压顶石和铜盆
    this.isoBox(P, -w1 * 1.35, w1 * 1.35, -w1 * 1.35, w1 * 1.35, z1, z1 + tw * 0.035, '#e4dac4', '#c9bea6', '#f0e8d6');
    const [px, py] = P(0, 0, z1 + tw * 0.035);
    c.fillStyle = '#7a5a2c';
    c.beginPath();
    c.ellipse(px, py, tw * 0.07 * sc, tw * 0.028 * sc, 0, 0, Math.PI);
    c.lineTo(px - tw * 0.07 * sc, py);
    c.fill();
    c.fillStyle = '#9c7a3c';
    c.beginPath();
    c.ellipse(px, py - tw * 0.004, tw * 0.07 * sc, tw * 0.025 * sc, 0, 0, Math.PI * 2);
    c.fill();
    // 火焰：慢慢摇曳；减少动态效果时保持不动
    const fh = tw * 0.13 * sc;
    const sway = this.calm ? 0 : Math.sin(this.t * 6) * tw * 0.012;
    const flick = this.calm ? 1 : 0.92 + 0.08 * Math.sin(this.t * 9.3);
    this.poly('#f08a3a', px - tw * 0.05 * sc, py - tw * 0.01, px + sway, py - fh * flick, px + tw * 0.05 * sc, py - tw * 0.01);
    this.poly('#ffd36b', px - tw * 0.026 * sc, py - tw * 0.012, px + sway * 0.6, py - fh * 0.62 * flick, px + tw * 0.026 * sc, py - tw * 0.012);
    const fire: [number, number] = [px, py - fh * 0.4];
    // 长明火：白天也亮着，夜里照亮塔顶
    if (this.lit) this.lights.push([fire[0], fire[1], tw * 0.6, '255,170,90']);
    return fire;
  }

  /** 山亭：石台上四根红柱撑起起翘的攒尖顶，亭里一张石桌；亭后一棵花树随季节换颜色 */
  protected drawPavilion(x: number, y: number, tw: number, roof: string, sc: number, seed: number): [number, number] {
    const c = this.ctx;
    const a = this.amb;
    const P = this.isoAt(x, y, tw);
    const w = 0.18 * sc;
    const z0 = tw * 0.05;
    const ph = tw * 0.28 * sc;
    const pillar = '#9a3a2c';
    this.shadow(x + tw * 0.08, y + tw * 0.07, tw * 0.36, tw * 0.14);
    // 亭后的花树：春天粉、夏天绿、秋天橙红，冬天落尽只剩枝
    const [tx, ty] = P(-0.34, 0.12, 0);
    const ts = tw * 0.5 * sc;
    c.strokeStyle = '#6b4a30';
    c.lineCap = 'round';
    c.lineWidth = Math.max(1, ts * 0.07);
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(tx + ts * 0.04, ty - ts * 0.55);
    c.moveTo(tx + ts * 0.02, ty - ts * 0.35);
    c.lineTo(tx - ts * 0.18, ty - ts * 0.62);
    c.moveTo(tx + ts * 0.03, ty - ts * 0.45);
    c.lineTo(tx + ts * 0.2, ty - ts * 0.7);
    c.stroke();
    if (a.season !== 3) {
      const crown = ['#f3b6c8', '#6fae55', '#e0904a'][a.season];
      const r0 = (seed * 0.37) % 1;
      for (const [dx, dy, r] of [[-0.16, -0.66, 0.2], [0.18, -0.7, 0.19], [0.02, -0.82, 0.22], [0, -0.6, 0.18]] as const) {
        this.dot(tx + ts * (dx + (r0 - 0.5) * 0.04), ty + ts * dy, ts * r, crown);
      }
      this.dot(tx - ts * 0.06, ty - ts * 0.86, ts * 0.12, shade(crown, 0.15));
      if (a.season === 0) for (const [dx, dy] of [[-0.2, -0.6], [0.12, -0.78], [0.22, -0.62]] as const) this.dot(tx + ts * dx, ty + ts * dy, ts * 0.025, '#fff1f5');
    } else if (a.cover > 0.15) {
      c.strokeStyle = SNOW;
      c.lineWidth = Math.max(0.8, ts * 0.035);
      c.beginPath();
      c.moveTo(tx - ts * 0.18, ty - ts * 0.64);
      c.lineTo(tx + ts * 0.02, ty - ts * 0.38);
      c.moveTo(tx + ts * 0.2, ty - ts * 0.72);
      c.lineTo(tx + ts * 0.05, ty - ts * 0.48);
      c.stroke();
    }
    // 亭基
    this.isoBox(P, -w * 1.45, w * 1.45, -w * 1.45, w * 1.45, 0, z0, '#cfc6b0', '#b5ab94', a.cover > 0.3 ? SNOW : '#e0d8c4');
    const column = (pi: number, pj: number) => {
      const [px, py] = P(pi, pj, z0);
      c.fillStyle = pillar;
      c.fillRect(px - tw * 0.017, py - ph, tw * 0.034, ph);
      c.fillStyle = shade(pillar, -0.25);
      c.fillRect(px + tw * 0.004, py - ph, tw * 0.013, ph);
    };
    // 后柱、石桌和石凳、前三根柱
    column(-w, -w);
    const [sx, sy] = P(0, 0, z0);
    c.fillStyle = '#a79f8c';
    c.fillRect(sx - tw * 0.012, sy - tw * 0.07, tw * 0.024, tw * 0.07);
    c.fillStyle = '#c9c1ad';
    c.beginPath();
    c.ellipse(sx, sy - tw * 0.07, tw * 0.07, tw * 0.03, 0, 0, Math.PI * 2);
    c.fill();
    this.dot(sx - tw * 0.1, sy - tw * 0.02, tw * 0.025, '#b8b09c');
    this.dot(sx + tw * 0.1, sy - tw * 0.02, tw * 0.025, '#b8b09c');
    column(-w, w);
    column(w, -w);
    // 正面两根柱之间一道矮栏
    c.strokeStyle = '#7a3428';
    c.lineWidth = Math.max(0.6, tw * 0.016);
    c.beginPath();
    c.moveTo(...P(-w, w, z0 + ph * 0.25));
    c.lineTo(...P(w, w, z0 + ph * 0.25));
    c.lineTo(...P(w, -w, z0 + ph * 0.25));
    c.stroke();
    column(w, w);
    // 起翘的攒尖顶：四角向上挑，顶上一颗宝顶
    const zE = z0 + ph;
    const zA = zE + tw * 0.24 * sc;
    const rw = w + 0.12;
    this.isoPyramid(P, rw, zE, zA, roof);
    c.strokeStyle = shade(roof, -0.3);
    c.lineWidth = Math.max(0.8, tw * 0.03);
    c.lineCap = 'round';
    c.beginPath();
    for (const [pi, pj, side] of [[-rw, rw, -1], [rw, rw, 0], [rw, -rw, 1]] as const) {
      const [ex, ey] = P(pi, pj, zE);
      c.moveTo(ex, ey);
      c.lineTo(ex + side * tw * 0.04, ey - tw * 0.05);
    }
    c.stroke();
    const [ax, ay] = P(0, 0, zA);
    c.fillStyle = '#c99a3c';
    c.fillRect(ax - tw * 0.008, ay - tw * 0.05, tw * 0.016, tw * 0.05);
    this.dot(ax, ay - tw * 0.06, tw * 0.026, '#e2b84a');
    // 檐下两盏灯笼
    const lamps: [number, number][] = [P(-rw * 0.95, rw * 0.95, zE - tw * 0.05), P(rw * 0.95, -rw * 0.95, zE - tw * 0.05)];
    for (const [lx, ly] of lamps) {
      c.fillStyle = '#5a4030';
      c.fillRect(lx - 0.5, ly - tw * 0.03, 1, tw * 0.03);
      this.dot(lx, ly + tw * 0.012, tw * 0.025, this.lit ? '#ffb070' : '#c8473a');
      if (this.lit) this.lights.push([lx, ly + tw * 0.012, tw * 0.3, WARM]);
    }
    return [lamps[0][0], lamps[0][1] + tw * 0.012];
  }

  /**
   * 地标：石台加楼体，高度按样式（LANDMARK_HEIGHT）；风车再加一圈帆扫过的圆，钟楼再加顶上的小旗。
   * 都随建成动画纵向伸展（与 drawLandmark 的 scale(1, k) 一致）。
   */
  protected landmarkOutline(x: number, y: number, tw: number, l: LandmarkView, anim: number): [number, number][][] {
    const k = 0.25 + 0.75 * anim;
    const sc = l.size >= 6 ? 1.12 : 0.92;
    const kind = landmarkKind(l.index);
    const h = LANDMARK_HEIGHT[kind];
    const sy = (py: number) => y + (py - y) * k;
    const top = sy(y - tw * h * sc);
    // 半宽：石台 0.39tw；大藏书阁的第一重檐角在 ±(wi + wj + 2o)/2 = ±0.42tw，按 drawLibrary 的尺寸取
    const hw = kind === 'library' ? Math.max(0.39, (0.54 * sc + 0.24) / 2) * tw : tw * 0.39;
    const outlines: [number, number][][] = [
      [
        [x - tw * 0.39, y + tw * 0.1],
        [x, y + tw * 0.28],
        [x + tw * 0.39, y + tw * 0.1],
        [x + hw, top],
        [x - hw, top],
      ],
    ];
    if (kind === 'windmill') {
      // 与 drawWindmill 一致：轴心在塔顶左前方，帆长 0.52tw·sc，横向压扁到 0.82
      const hx = x - tw * 0.15 * sc * 0.55;
      const hy = y + tw * 0.04 - tw * 0.62 * sc + tw * 0.02;
      const len = tw * 0.52 * sc;
      outlines.push(Array.from({ length: 16 }, (_, i): [number, number] => {
        const th = (i / 16) * Math.PI * 2;
        return [hx + Math.cos(th) * len * 0.82, sy(hy + Math.sin(th) * len)];
      }));
    } else if (kind === 'clock') {
      // 攒尖顶尖上的小旗（drawFlag：旗杆高 0.5·0.5tw，旗面宽 0.26·0.5tw）
      const apex = y - tw * h * sc;
      outlines.push([
        [x - tw * 0.01, sy(apex + tw * 0.02)],
        [x + tw * 0.14, sy(apex + tw * 0.02)],
        [x + tw * 0.14, sy(apex - tw * 0.24)],
        [x - tw * 0.01, sy(apex - tw * 0.24)],
      ]);
    }
    return outlines;
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
    const win = this.drawLandmarkBody(kind, x, y, tw, roof, sc, l.index);
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

  private drawLandmarkBody(kind: LandmarkKind, x: number, y: number, tw: number, roof: string, sc: number, seed: number): [number, number] {
    switch (kind) {
      case 'clock':
        return this.drawClockTower(x, y, tw, roof, sc, seed);
      case 'library':
        return this.drawLibrary(x, y, tw, roof, sc);
      case 'windmill':
        return this.drawWindmill(x, y, tw, roof, sc, seed);
      case 'observatory':
        return this.drawObservatory(x, y, tw, roof, sc);
      case 'greenhouse':
        return this.drawGreenhouse(x, y, tw, roof, sc);
      case 'harbor':
        return this.drawHarborHall(x, y, tw, roof, sc);
      case 'memorial':
        return this.drawMemorial(x, y, tw, roof, sc);
      case 'pavilion':
        return this.drawPavilion(x, y, tw, roof, sc, seed);
    }
  }
}
