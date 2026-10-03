/**
 * 小岛的 Canvas 绘制与交互。绘制手法来自禾境（等距地块、小房子、小人、标签），
 * 加上屿志自己的东西：村落阶段、码头与船、粮仓、灯塔、海雾、黄昏与夜晚。
 */
import type { Stage } from '../logic/config';
import { buildIsland, mulberry32, type IslandMap, type Tile, type VillageSite } from './map';

export interface WalkerView {
  id: string;
  title: string;
}

export interface VillageView {
  slot: number;
  projectId: string;
  name: string;
  roof: string;
  stage: Stage;
  houses: number;
  walkers: WalkerView[];
  /** 没画出来的任务数 */
  extra: number;
  openCount: number;
}

export type Light = 'day' | 'dusk' | 'night';

export interface Scene {
  season: 0 | 1 | 2 | 3;
  light: Light;
  villages: VillageView[];
  dockShips: number;
  choresCount: number;
  /** 0–1 */
  granaryRatio: number;
  granaryLabel: string;
  /** 0–1 */
  fog: number;
  selected: Selection | null;
}

export type Selection = { kind: 'project'; id: string } | { kind: 'task'; id: string } | { kind: 'dock' } | { kind: 'granary' } | { kind: 'chores' };
export type Hit = Selection | { kind: 'lighthouse' } | null;

interface Walker {
  id: string;
  title: string;
  slot: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  color: string;
  leaving: boolean;
  skin: string;
  hair: string;
}

const SKIN = ['#f1c9a5', '#e6b48c', '#d9a074', '#c98d62'];
const HAIR = ['#2f2620', '#4a3426', '#1f1c1a', '#6b4a2e', '#3b2f2a'];
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
function hash(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return (h >>> 0) / 4294967296;
}
function hx(c: string): number[] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
export function mix(a: string, b: string, t: number): string {
  const A = hx(a);
  const B = hx(b);
  return '#' + A.map((v, k) => clamp(Math.round(v + (B[k] - v) * t), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function shade(c: string, t: number): string {
  return t > 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);
}

export class IslandRenderer {
  readonly map: IslandMap = buildIsland();
  private ctx: CanvasRenderingContext2D;
  private view = { w: 0, h: 0, dpr: 1, zoom: 1, panX: 0, panY: 0, tw: 30, ox: 0, oy: 0 };
  private scene: Scene | null = null;
  private walkers = new Map<string, Walker>();
  private theme = { label: '#fff', ink: '#263022', line: '#dfe2d2', accent: '#4f7136', accentInk: '#fff', sea: '#a9d3dc', seaDeep: '#8cc0cc' };
  private colorKey = '';
  private tileCol = new Map<Tile, string>();
  private raf = 0;
  private last = 0;
  private t = 0;
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private grow = new Map<string, { houses: number; anim: number }>();
  private pulses: { slot: number; t: number }[] = [];
  private lights: [number, number, number][] = [];
  private rnd = mulberry32(7);
  onTap: (hit: Hit) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    this.readTheme();
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, px: this.view.panX, py: this.view.panY, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
      if (d.moved && (this.view.zoom > 1.01 || e.pointerType === 'mouse')) {
        this.view.panX = d.px + dx;
        this.view.panY = d.py + dy;
        this.layout();
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved) this.onTap(this.hitAt(this.localPt(e)));
    });
    canvas.addEventListener('pointercancel', () => (this.drag = null));
    new ResizeObserver(() => this.resize()).observe(wrap);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
    this.theme = {
      label: g('--label', '#fff'),
      ink: g('--ink', '#263022'),
      line: g('--line', '#dfe2d2'),
      accent: g('--accent', '#4f7136'),
      accentInk: g('--accent-ink', '#fff'),
      sea: g('--sea', '#a9d3dc'),
      seaDeep: g('--sea-deep', '#8cc0cc'),
    };
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

  /* ---------------- 场景同步 ---------------- */

  setScene(s: Scene) {
    const prev = this.scene;
    this.scene = s;
    if (!prev || prev.season !== s.season) this.colorKey = '';
    const keep = new Set<string>();
    for (const v of s.villages) {
      const site = this.map.villages[v.slot];
      const g = this.grow.get(v.projectId);
      if (!g) this.grow.set(v.projectId, { houses: v.houses, anim: 1 });
      else if (v.houses > g.houses) this.grow.set(v.projectId, { houses: v.houses, anim: 0 });
      else g.houses = v.houses;
      v.walkers.forEach((w, idx) => {
        keep.add(w.id);
        let p = this.walkers.get(w.id);
        if (!p || p.slot !== v.slot) {
          const home = site.slots[idx % Math.max(1, v.houses)] ?? site.center;
          const r = hash(w.id);
          p = {
            id: w.id,
            title: w.title,
            slot: v.slot,
            x: home.i + (r - 0.5) * 0.5,
            y: home.j + (hash(w.id + 'y') - 0.5) * 0.5,
            tx: home.i,
            ty: home.j,
            wait: r * 3,
            color: v.roof,
            leaving: false,
            skin: SKIN[Math.floor(r * SKIN.length)],
            hair: HAIR[Math.floor(hash(w.id + 'h') * HAIR.length)],
          };
          this.walkers.set(w.id, p);
        }
        p.title = w.title;
        p.color = v.roof;
        p.leaving = v.stage === 3 && idx % 2 === 0;
      });
    }
    for (const id of [...this.walkers.keys()]) if (!keep.has(id)) this.walkers.delete(id);
  }

  /** 一块砖飞进村落后，让村落亮一下 */
  pulse(projectId: string) {
    const v = this.scene?.villages.find((x) => x.projectId === projectId);
    if (v) this.pulses.push({ slot: v.slot, t: 0 });
  }

  /** 村落在页面上的位置（用于砖块飞行动画） */
  villageClientPos(projectId: string): { x: number; y: number } | null {
    const v = this.scene?.villages.find((x) => x.projectId === projectId);
    if (!v) return null;
    const c = this.map.villages[v.slot].center;
    const [x, y] = this.iso(c.i, c.j);
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + x, y: r.top + y - this.view.tw * 0.3 };
  }

  zoomBy(f: number) {
    this.view.zoom = clamp(this.view.zoom * f, 1, 2.8);
    if (this.view.zoom <= 1.01) {
      this.view.panX = 0;
      this.view.panY = 0;
    }
    this.layout();
  }

  resetView() {
    this.view.zoom = 1;
    this.view.panX = 0;
    this.view.panY = 0;
    this.layout();
  }

  /* ---------------- 几何 ---------------- */

  private resize() {
    const r = this.wrap.getBoundingClientRect();
    if (!r.width) return;
    const v = this.view;
    v.w = r.width;
    v.h = r.height;
    v.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * v.dpr);
    this.canvas.height = Math.round(r.height * v.dpr);
    this.layout();
  }

  private layout() {
    const v = this.view;
    const N = this.map.N;
    // 岛的半径约 10.5 格：等距投影后横向跨度约 15 格宽、纵向约 8 格高
    const base = Math.min((v.w * 0.97) / 15.2, (v.h * 0.94) / 8.4);
    v.tw = base * v.zoom;
    v.panX = clamp(v.panX, -v.w * 0.6 * v.zoom, v.w * 0.6 * v.zoom);
    v.panY = clamp(v.panY, -v.h * 0.6 * v.zoom, v.h * 0.6 * v.zoom);
    v.ox = v.w / 2 + v.panX;
    v.oy = v.h / 2 - ((N - 1) * v.tw) / 4 + v.panY;
    this.canvas.style.touchAction = v.zoom > 1.01 ? 'none' : 'pan-y';
  }

  private iso(i: number, j: number): [number, number] {
    const v = this.view;
    return [v.ox + ((i - j) * v.tw) / 2, v.oy + ((i + j) * v.tw) / 4];
  }

  private localPt(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private tileCoords(pt: { x: number; y: number }) {
    const v = this.view;
    const u = (pt.x - v.ox) / (v.tw / 2);
    const w = (pt.y - v.oy) / (v.tw / 4);
    return { fi: (u + w) / 2, fj: (w - u) / 2 };
  }

  hitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;
    const s0 = Math.max(5, this.view.tw * 0.2);
    let best: Walker | null = null;
    let bd = Math.max(16, s0 * 1.4);
    for (const p of this.walkers.values()) {
      const [x, y] = this.iso(p.x, p.y);
      const d = Math.hypot(pt.x - x, pt.y - (y - s0 * 0.7));
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) return { kind: 'task', id: best.id };
    const { fi, fj } = this.tileCoords(pt);
    const m = this.map;
    const near = (t: Tile, r: number) => Math.hypot(t.i - fi, t.j - fj) < r;
    if (fj > m.dock.j - 0.6 && Math.abs(fi - m.dock.i) < 1.8 && fj < m.dock.j + m.pierLen + 1) return { kind: 'dock' };
    if (near(m.granary, 0.9)) return { kind: 'granary' };
    if (near(m.chores, 0.9)) return { kind: 'chores' };
    if (near(m.lighthouse, 1.3)) return { kind: 'lighthouse' };
    let vb: VillageView | null = null;
    let vd = 2.6;
    for (const v of s.villages) {
      const c = m.villages[v.slot].center;
      const d = Math.hypot(c.i - fi, c.j - fj);
      if (d < vd) {
        vd = d;
        vb = v;
      }
    }
    if (vb) return { kind: 'project', id: vb.projectId };
    // 点标签
    return null;
  }

  /* ---------------- 动画 ---------------- */

  private step(dt: number) {
    const s = this.scene;
    if (!s) return;
    const speed = 0.55 * dt;
    const m = this.map;
    for (const p of this.walkers.values()) {
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.02) {
        const k = Math.min(d, speed * (p.leaving ? 1.3 : 1));
        p.x += (dx / d) * k;
        p.y += (dy / d) * k;
        continue;
      }
      if (p.leaving && Math.hypot(p.x - m.dock.i, p.y - (m.dock.j + 0.6)) < 0.1) {
        // 走到码头的人，过一会儿又回到村里，然后再次离开
        const c = m.villages[p.slot].center;
        p.x = c.i;
        p.y = c.j;
      }
      p.wait -= dt;
      if (p.wait > 0) continue;
      this.retarget(p, m.villages[p.slot], s);
    }
    for (const g of this.grow.values()) if (g.anim < 1) g.anim = Math.min(1, g.anim + dt * 1.6);
    for (const pl of this.pulses) pl.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < 1.4);
  }

  private retarget(p: Walker, site: VillageSite, s: Scene) {
    const r = this.rnd();
    const v = s.villages.find((x) => x.slot === p.slot);
    const houses = Math.max(1, v?.houses ?? 1);
    let t: { i: number; j: number };
    if (p.leaving && r < 0.5) t = { i: this.map.dock.i, j: this.map.dock.j + 0.6 };
    else if (r < 0.45) t = site.center;
    else t = site.slots[Math.floor(this.rnd() * houses)] ?? site.center;
    p.tx = t.i + (this.rnd() - 0.5) * 0.6;
    p.ty = t.j + (this.rnd() - 0.5) * 0.6;
    const quiet = v ? [1, 2.2, 3.5, 2][v.stage] : 1;
    p.wait = (1 + this.rnd() * 4) * quiet * (s.light === 'night' ? 2 : 1);
  }

  /* ---------------- 绘制 ---------------- */

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

  private tileColors(season: number) {
    const key = String(season);
    if (key === this.colorKey) return;
    this.colorKey = key;
    const GR = ['#a6c46a', '#93b65a', '#c4b866', '#d3d8c4'][season];
    const FI = ['#b3cd70', '#dcc45c', '#e3ad45', '#c9c2a2'][season];
    const WA = season === 3 ? '#a6c8d3' : '#7db3c7';
    for (const t of this.map.all) {
      const base: Record<string, string> = { grass: GR, forest: shade(GR, -0.1), field: FI, water: WA, mountain: '#a3a68f', plaza: '#e4d8b8', sand: '#e6d6a8' };
      this.tileCol.set(t, shade(base[t.type], (t.v - 0.5) * 0.1));
    }
  }

  private grassCol(season: number, t: Tile) {
    return shade(['#a6c46a', '#93b65a', '#c4b866', '#d3d8c4'][season], (t.v - 0.5) * 0.1);
  }

  private drawTree(x: number, y: number, s: number, kind: 'pine' | 'round', se: number) {
    const c = this.ctx;
    c.fillStyle = 'rgba(30,40,20,.14)';
    c.beginPath();
    c.ellipse(x, y, s * 0.3, s * 0.12, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#7a5a3a';
    c.fillRect(x - s * 0.05, y - s * 0.32, s * 0.1, s * 0.32);
    if (kind === 'pine') {
      const col = se === 3 ? '#5d7a55' : '#4c7a44';
      this.poly(col, x, y - s * 1.25, x - s * 0.32, y - s * 0.24, x, y - s * 0.18);
      this.poly(shade(col, -0.18), x, y - s * 1.25, x + s * 0.32, y - s * 0.24, x, y - s * 0.18);
      if (se === 3) this.poly('#f3f4ee', x, y - s * 1.25, x - s * 0.14, y - s * 0.8, x + s * 0.14, y - s * 0.8);
    } else {
      const col = ['#6f9a48', '#5f8c3e', '#c8963c', '#a39e86'][se];
      c.fillStyle = col;
      c.beginPath();
      c.arc(x, y - s * 0.62, s * 0.34, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = shade(col, 0.18);
      c.beginPath();
      c.arc(x - s * 0.1, y - s * 0.72, s * 0.15, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 小房子；返回窗户位置，供夜里点灯 */
  private drawHouse(x: number, y: number, s: number, roof: string, wall = '#efe5cf', boarded = false): [number, number] {
    const hw = s / 2;
    const hh = s / 4;
    const H = s * 0.5;
    const c = this.ctx;
    c.fillStyle = 'rgba(30,40,20,.15)';
    c.beginPath();
    c.ellipse(x + s * 0.1, y + hh * 0.4, s * 0.62, s * 0.26, 0, 0, Math.PI * 2);
    c.fill();
    this.poly(wall, x - hw, y, x, y + hh, x, y + hh - H, x - hw, y - H);
    this.poly(shade(wall, -0.13), x, y + hh, x + hw, y, x + hw, y - H, x, y + hh - H);
    c.fillStyle = '#6b5240';
    c.fillRect(x + hw * 0.35, y + hh * 0.35 - H * 0.55, hw * 0.25, H * 0.5);
    // 窗
    const wx = x - hw * 0.55;
    const wy = y - H * 0.55;
    c.fillStyle = boarded ? '#5a4a3a' : '#8a9aa6';
    c.fillRect(wx, wy, hw * 0.26, H * 0.26);
    if (boarded) {
      c.strokeStyle = '#3d3128';
      c.lineWidth = Math.max(0.6, s * 0.03);
      c.beginPath();
      c.moveTo(wx, wy);
      c.lineTo(wx + hw * 0.26, wy + H * 0.26);
      c.moveTo(wx + hw * 0.26, wy);
      c.lineTo(wx, wy + H * 0.26);
      c.stroke();
    }
    const ay = y - H - s * 0.42;
    this.poly(roof, x - hw * 1.12, y - H + hh * 0.05, x, y + hh - H + hh * 0.2, x, ay);
    this.poly(shade(roof, -0.2), x, y + hh - H + hh * 0.2, x + hw * 1.12, y - H + hh * 0.05, x, ay);
    return [wx + hw * 0.13, wy + H * 0.13];
  }

  private drawMountain(x: number, y: number, t: Tile, tw: number, se: number) {
    const s = tw * (0.75 + t.v * 0.55);
    const ax = x + tw * 0.08 * (t.v - 0.5);
    const ay = y - s;
    const by = y + tw * 0.12;
    this.poly('#b3b6a3', x - tw * 0.48, y + tw * 0.05, ax, ay, ax, by);
    this.poly('#8a8e7c', ax, ay, x + tw * 0.48, y + tw * 0.05, ax, by);
    const f = se === 3 ? 0.45 : 0.24;
    this.poly('#f3f2ea', ax, ay, ax + (x - tw * 0.48 - ax) * f, ay + (y - ay) * f, ax, ay + (by - ay) * f * 0.9);
    this.poly('#dcdcd2', ax, ay, ax + (x + tw * 0.48 - ax) * f, ay + (y - ay) * f, ax, ay + (by - ay) * f * 0.9);
  }

  private drawLighthouse(x: number, y: number, tw: number, light: Light) {
    const c = this.ctx;
    const base = y - tw * 0.9;
    const w = tw * 0.16;
    const h = tw * 0.62;
    this.poly('#f1eee4', x - w, base, x - w * 0.7, base - h, x + w * 0.7, base - h, x + w, base);
    this.poly('#c8473a', x - w * 0.88, base - h * 0.35, x - w * 0.8, base - h * 0.55, x + w * 0.8, base - h * 0.55, x + w * 0.88, base - h * 0.35);
    c.fillStyle = light === 'day' ? '#f6e7a6' : '#ffe27a';
    c.fillRect(x - w * 0.6, base - h - tw * 0.12, w * 1.2, tw * 0.12);
    this.poly('#7a3a32', x - w * 0.8, base - h - tw * 0.12, x, base - h - tw * 0.26, x + w * 0.8, base - h - tw * 0.12);
    if (light !== 'day') {
      const a = this.t * 0.6;
      const ly = base - h - tw * 0.06;
      this.lights.push([x, ly, tw * 0.9]);
      c.save();
      c.globalCompositeOperation = 'lighter';
      const g = c.createRadialGradient(x, ly, 0, x, ly, tw * 4);
      g.addColorStop(0, 'rgba(255,230,140,.35)');
      g.addColorStop(1, 'rgba(255,230,140,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(x, ly);
      c.arc(x, ly, tw * 4, a - 0.18, a + 0.18);
      c.closePath();
      c.fill();
      c.restore();
    }
  }

  private drawGranary(x: number, y: number, tw: number, ratio: number) {
    const c = this.ctx;
    const s = tw * 0.46;
    const r = s * 0.34;
    const h = s * 0.95;
    c.fillStyle = 'rgba(30,40,20,.15)';
    c.beginPath();
    c.ellipse(x + s * 0.1, y + s * 0.06, s * 0.6, s * 0.25, 0, 0, Math.PI * 2);
    c.fill();
    const g = c.createLinearGradient(x - r, 0, x + r, 0);
    g.addColorStop(0, '#f0e3c3');
    g.addColorStop(1, '#c8b48a');
    c.fillStyle = g;
    c.fillRect(x - r, y - h, r * 2, h);
    c.beginPath();
    c.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI);
    c.fill();
    // 存量：金黄的一截
    const fh = h * clamp(ratio, 0, 1);
    c.fillStyle = ratio < 0.25 ? '#c98a4a' : '#e2ad2f';
    c.fillRect(x - r * 0.55, y - fh, r * 1.1, fh);
    c.fillStyle = '#9c6a35';
    c.beginPath();
    c.ellipse(x, y - h, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
    c.fill();
    this.poly('#b07a40', x - r * 1.15, y - h, x, y - h - s * 0.55, x, y - h + r * 0.5);
    this.poly('#8a5a2c', x, y - h - s * 0.55, x + r * 1.15, y - h, x, y - h + r * 0.5);
  }

  private drawWeeds(x: number, y: number, tw: number, seed: number) {
    const c = this.ctx;
    c.strokeStyle = '#6d7f3a';
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

  private drawPerson(x: number, y: number, s: number, p: Walker, dim: number) {
    const c = this.ctx;
    c.globalAlpha = dim;
    c.fillStyle = 'rgba(20,30,10,.2)';
    c.beginPath();
    c.ellipse(x, y, s * 0.32, s * 0.13, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = shade(p.color, 0.08);
    this.rrect(x - s * 0.22, y - s * 0.95, s * 0.44, s * 0.86, s * 0.14);
    c.fill();
    c.fillStyle = p.skin;
    c.beginPath();
    c.arc(x, y - s * 1.13, s * 0.21, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = p.hair;
    c.beginPath();
    c.arc(x, y - s * 1.17, s * 0.21, Math.PI, 0);
    c.fill();
    if (p.leaving) {
      // 背着包袱
      c.fillStyle = '#b98b3c';
      c.beginPath();
      c.arc(x + s * 0.22, y - s * 0.7, s * 0.17, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  private drawBoat(x: number, y: number, tw: number, k: number) {
    const c = this.ctx;
    const bob = Math.sin(this.t * 1.6 + k * 1.3) * tw * 0.025;
    const s = tw * 0.42;
    y += bob;
    c.fillStyle = 'rgba(20,50,70,.18)';
    c.beginPath();
    c.ellipse(x, y + s * 0.08, s * 0.55, s * 0.16, 0, 0, Math.PI * 2);
    c.fill();
    this.poly('#8a5a34', x - s * 0.55, y - s * 0.12, x + s * 0.55, y - s * 0.12, x + s * 0.36, y + s * 0.1, x - s * 0.36, y + s * 0.1);
    this.poly('#a8713f', x - s * 0.55, y - s * 0.12, x + s * 0.55, y - s * 0.12, x + s * 0.45, y - s * 0.02, x - s * 0.45, y - s * 0.02);
    c.fillStyle = '#6b4a30';
    c.fillRect(x - s * 0.02, y - s * 0.95, s * 0.04, s * 0.85);
    this.poly(k % 3 === 0 ? '#f4efe2' : k % 3 === 1 ? '#efe0c4' : '#f7f3ea', x + s * 0.03, y - s * 0.92, x + s * 0.42, y - s * 0.2, x + s * 0.03, y - s * 0.2);
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

  private draw() {
    const s = this.scene;
    const v = this.view;
    const c = this.ctx;
    if (!v.w || !s) return;
    c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    c.clearRect(0, 0, v.w, v.h);
    const { tw } = v;
    const hw = tw / 2;
    const hh = tw / 4;
    const D = tw * 0.32;
    const m = this.map;
    this.tileColors(s.season);
    this.lights = [];

    // 海
    c.fillStyle = this.theme.sea;
    c.fillRect(0, 0, v.w, v.h);
    c.strokeStyle = 'rgba(255,255,255,.35)';
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 0; k < 26; k++) {
      const bx = hash('wx' + k) * v.w;
      const by = hash('wy' + k) * v.h;
      const off = Math.sin(this.t * 0.6 + k) * 6;
      c.moveTo(bx + off, by);
      c.quadraticCurveTo(bx + off + 6, by - 3, bx + off + 12, by);
    }
    c.stroke();
    // 岛周围的浅水
    c.fillStyle = this.theme.seaDeep;
    for (const t of m.all) {
      if (!t.edge) continue;
      const [x, y] = this.iso(t.i, t.j);
      c.globalAlpha = 0.35;
      c.beginPath();
      c.ellipse(x, y + hh * 1.2, hw * 1.5, hh * 1.6, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    // 地块
    const occupiedSlots = new Set(s.villages.map((x) => x.slot));
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      let col = this.tileCol.get(t)!;
      if (t.type === 'plaza' && t.village >= 0 && !occupiedSlots.has(t.village)) col = this.grassCol(s.season, t);
      const wat = t.type === 'water';
      if (!m.at(t.i, t.j + 1)) this.poly(wat ? '#5f93a8' : '#b38957', x - hw, y, x, y + hh, x, y + hh + D, x - hw, y + D);
      if (!m.at(t.i + 1, t.j)) this.poly(wat ? '#4f8197' : '#957043', x, y + hh, x + hw, y, x + hw, y + D, x, y + hh + D);
      this.poly(col, x, y - hh - 0.4, x + hw + 0.5, y, x, y + hh + 0.4, x - hw - 0.5, y);
      if (t.type === 'field') {
        c.strokeStyle = shade(col, -0.14);
        c.lineWidth = Math.max(0.6, tw * 0.025);
        c.beginPath();
        for (let k = 1; k < 4; k++) {
          const f = k / 4;
          c.moveTo(x - hw * f, y - hh + hh * f);
          c.lineTo(x + hw - hw * f, y + hh * f);
        }
        c.stroke();
      } else if (wat) {
        c.strokeStyle = 'rgba(255,255,255,.35)';
        c.lineWidth = Math.max(0.6, tw * 0.025);
        c.beginPath();
        c.moveTo(x - hw * 0.35, y + hh * 0.1);
        c.lineTo(x - hw * 0.05, y - hh * 0.05);
        c.moveTo(x + hw * 0.05, y + hh * 0.3);
        c.lineTo(x + hw * 0.3, y + hh * 0.15);
        c.stroke();
      }
    }

    // 码头栈桥与船
    const [di, dj] = m.pierDir;
    for (let k = 0; k <= m.pierLen; k++) {
      const pi = m.dock.i + di * (k + 0.2);
      const pj = m.dock.j + dj * (k + 0.2);
      const [x, y] = this.iso(pi, pj);
      const w = 0.28;
      const a = this.iso(pi - w, pj - 0.5);
      const b = this.iso(pi + w, pj - 0.5);
      const cc = this.iso(pi + w, pj + 0.5);
      const d = this.iso(pi - w, pj + 0.5);
      this.poly('#6b4a30', a[0], a[1] + tw * 0.06, b[0], b[1] + tw * 0.06, cc[0], cc[1] + tw * 0.06, d[0], d[1] + tw * 0.06);
      this.poly('#a8794a', a[0], a[1], b[0], b[1], cc[0], cc[1], d[0], d[1]);
      c.fillStyle = '#5a3c26';
      c.fillRect(x - hw * 0.32, y + hh * 0.1, tw * 0.03, tw * 0.12);
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
    const night = s.light !== 'day';
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      if (t.type === 'mountain') this.drawMountain(x, y, t, tw, s.season);
      if (t === m.lighthouse) this.drawLighthouse(x, y, tw, s.light);
      if (t === m.granary) this.drawGranary(x, y, tw, s.granaryRatio);
      if (t === m.chores) {
        this.drawHouse(x + hw * 0.2, y - hh * 0.2, tw * 0.3, '#8a8578', '#e3dccb');
      }
      if (t.type === 'plaza' && t.village >= 0) {
        const vv = occupied.get(t.village);
        if (vv) {
          c.fillStyle = '#8f8a7a';
          c.beginPath();
          c.ellipse(x, y, tw * 0.09, tw * 0.045, 0, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = vv.stage >= 2 ? '#7d8a8c' : '#5a7f95';
          c.beginPath();
          c.ellipse(x, y, tw * 0.06, tw * 0.028, 0, 0, Math.PI * 2);
          c.fill();
          if (vv.stage >= 2) this.drawWeeds(x, y + hh * 0.3, tw, t.i * 31 + t.j);
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
          const win = this.drawHouse(x, y, tw * 0.36 * k, roof, wall, boarded);
          if (vv.stage >= 2 && t.slotIdx % 2 === 0) this.drawWeeds(x - hw * 0.4, y + hh * 0.2, tw, t.i * 17 + t.j);
          const litFrac = [0.9, 0.5, 0.25, 0.12][vv.stage];
          if (night && !boarded && hash(vv.projectId + t.slotIdx) < litFrac) this.lights.push([win[0], win[1], tw * 0.2]);
        }
      }
      for (const tr of t.trees) this.drawTree(x + (tr.dx - tr.dy) * hw, y + (tr.dx + tr.dy) * hh, tw * 0.42 * tr.s, tr.kind, s.season);
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
      this.drawPerson(x, y, s0, p, night && s.light === 'night' ? 0.85 : 1);
    }

    // 黄昏与夜晚
    if (s.light === 'dusk') {
      c.fillStyle = 'rgba(255,128,48,.13)';
      c.fillRect(0, 0, v.w, v.h);
      c.fillStyle = 'rgba(60,30,80,.12)';
      c.fillRect(0, 0, v.w, v.h);
    } else if (s.light === 'night') {
      c.fillStyle = 'rgba(14,22,52,.42)';
      c.fillRect(0, 0, v.w, v.h);
    }
    if (night) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const [x, y, r] of this.lights) {
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,214,120,.8)');
        g.addColorStop(0.35, 'rgba(255,200,100,.35)');
        g.addColorStop(1, 'rgba(255,190,90,0)');
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
      c.restore();
    }

    // 落砖时的光圈
    for (const pl of this.pulses) {
      const ctr = m.villages[pl.slot].center;
      const [x, y] = this.iso(ctr.i, ctr.j);
      const k = pl.t / 1.4;
      c.strokeStyle = `rgba(226,173,47,${(1 - k) * 0.9})`;
      c.lineWidth = 3;
      c.beginPath();
      c.ellipse(x, y, tw * (0.4 + k * 1.6), tw * (0.2 + k * 0.8), 0, 0, Math.PI * 2);
      c.stroke();
    }

    // 海雾：未结算的日子
    if (s.fog > 0.01) {
      const [cx, cy] = this.iso(m.N / 2, m.N / 2);
      for (let k = 0; k < 9; k++) {
        const a = hash('fog' + k) * Math.PI * 2 + this.t * 0.03 * (k % 2 ? 1 : -1);
        const rr = tw * (1.5 + hash('fr' + k) * 3.2);
        const x = cx + Math.cos(a) * tw * 3.2 * hash('fd' + k) * 1.4 + Math.sin(this.t * 0.1 + k) * tw * 0.4;
        const y = cy + Math.sin(a) * tw * 1.6 * hash('fe' + k) * 1.4;
        const g = c.createRadialGradient(x, y, 0, x, y, rr * 2);
        const al = 0.55 * s.fog;
        g.addColorStop(0, `rgba(236,240,240,${al})`);
        g.addColorStop(1, 'rgba(236,240,240,0)');
        c.fillStyle = g;
        c.fillRect(x - rr * 2, y - rr * 2, rr * 4, rr * 4);
      }
      c.fillStyle = `rgba(230,234,235,${0.18 * s.fog})`;
      c.fillRect(0, 0, v.w, v.h);
    }

    // 标签
    const sel = s.selected;
    for (const vv of s.villages) {
      const ctr = m.villages[vv.slot].center;
      const [x, y0] = this.iso(ctr.i, ctr.j);
      const stageTxt = vv.stage ? ` · ${['', '安静', '蒙灰', '搬离'][vv.stage]}` : '';
      this.label(x, y0 - tw * 1.05, `${vv.name} ${vv.openCount}人${stageTxt}`, vv.roof, sel?.kind === 'project' && sel.id === vv.projectId, vv.stage >= 2);
    }
    {
      const [x, y] = this.iso(m.dock.i + 0.2, m.dock.j + m.pierLen + 0.6);
      this.label(x, y + tw * 0.2, s.dockShips ? `码头 · ${s.dockShips} 船` : '码头', null, sel?.kind === 'dock');
      const [gx, gy] = this.iso(m.granary.i, m.granary.j);
      this.label(gx, gy + tw * 0.32, s.granaryLabel, '#e2ad2f', sel?.kind === 'granary');
      if (s.choresCount) {
        const [cx2, cy2] = this.iso(m.chores.i, m.chores.j);
        this.label(cx2, cy2 + tw * 0.3, `杂务 ${s.choresCount}`, '#8a8578', sel?.kind === 'chores', true);
      }
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
