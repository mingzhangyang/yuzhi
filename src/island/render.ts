/**
 * 小岛的 Canvas 绘制与交互。绘制手法来自禾境（等距地块、小房子、小人、标签），
 * 加上屿志自己的东西：村落阶段、码头与船、粮仓、灯塔、海雾。
 * 画面跟着现实走：一天里的光线连续变化，四季改变地表、树和衣着，
 * 每天有自己的天气，夜里看得到当天的月相，节日里岛上会挂灯笼、插旗、放烟花。
 *
 * 地块（连同小路和地面纹理）画进一张离屏缓存，只有视图或季节变化时才重画；
 * 树、房子、小人、海浪和天气每帧绘制。
 */
import { BANNERS_MAX, DRIFT_BOTTLES_MAX } from '../logic/config';
import type { Stage } from '../logic/config';
import { CHORES } from '../types';
import type { ISODate } from '../types';
import { buildIsland, mulberry32, tileHash, type IslandMap, type Tile, type VillageSite } from './map';
import { describe, type InfoContext, type InfoTarget, type MapInfo } from './info';
import { dayLight, festivalsOf, moonPhase, seasonProgress, snowCover, weatherOf, type DayLight, type Festival, type Weather } from './ambience';
import { IslandPropArt } from './props';
import { diffScene, pickBell, type BellCandidate, type Cue } from './cues';

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
  agenda?: AgendaView;
  /** 今天结算为做了 / 做了一部分的日程数；只用于烧窑转场 */
  firedToday?: number;
}

export interface AgendaView {
  /** allday：只有全天条幅，没有任何定时场次 */
  phase: 'allday' | 'later' | 'soon' | 'live' | 'ended';
  title?: string;
  until?: string;
  /** 即将开始那一场的开始时间 */
  start?: string;
  later: number;
  ended: number;
  banners: string[];
  live?: { eventId: string; title: string; end: string }[];
  soon?: { eventId: string; title: string; start: string }[];
}

export interface ChoresView {
  /** 近 7 天结算为做了 / 做了一部分的杂务数 */
  count: number;
  woodpile: 0 | 1 | 2 | 3;
  live?: { title: string; until: string };
  soon?: { title: string; start: string };
  later: number;
  ended: number;
}

export interface LandmarkView {
  projectId: string;
  name: string;
  roof: string;
  /** 地标位编号 */
  index: number;
  /** 规模：由村落当年的房子数决定，1–10 */
  size: number;
}

export type Light = 'day' | 'dusk' | 'night';

export interface Scene {
  season: 0 | 1 | 2 | 3;
  light: Light;
  /** 今天（本地日期），决定天气、节日、季节进度 */
  date: ISODate;
  /** 本地时刻（小时，可带小数），决定光线和月亮 */
  hour: number;
  /** 构建场景时的精确时间戳（毫秒）；钟声冷却按它计算，hour 会丢掉秒 */
  now: number;
  villages: VillageView[];
  dockShips: number;
  /** 兼容旧调用方；新 UI 从 chores.count 读取。 */
  choresCount: number;
  chores: ChoresView;
  drifting: { title: string }[];
  lighthouseBanners: string[];
  granaryBusy: boolean;
  /** 0–1 */
  granaryRatio: number;
  granaryLabel: string;
  /** 0–1 */
  fog: number;
  selected: Selection | null;
  /** 地标越多，岛向外长出的年轮越多 */
  rings: number;
  landmarks: LandmarkView[];
}

export type Selection = { kind: 'project'; id: string } | { kind: 'task'; id: string } | { kind: 'dock' } | { kind: 'granary' } | { kind: 'chores' } | { kind: 'archive' };
export type Hit = Selection | { kind: 'agenda'; target: string } | { kind: 'drift'; title: string } | null;

type SceneryFocus = { i: number; j: number; tree?: [number, number, number] };

export interface SceneryInspection {
  info: MapInfo;
  x: number;
  y: number;
  /** 可从说明卡执行的对象；目前只有漂流瓶需要动作。 */
  target?: Extract<InfoTarget, { kind: 'drift' }>;
}

interface SceneryCandidate extends SceneryInspection {
  focus: SceneryFocus | null;
}

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
  /** 朝向：1 向右，-1 向左 */
  face: number;
  /** 走路的步伐相位 */
  walk: number;
  moving: boolean;
  /** 0–1 的个人随机数：决定帽子之类的小差异 */
  r: number;
}

/** 屏幕坐标里的飘落物：花瓣、落叶、雪、雨 */
interface Drift {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  /** 还没炸开的火箭 */
  rocket: boolean;
  /** 炸开瞬间的闪光 */
  flash?: boolean;
  burstAt: number;
}

interface BellRipple {
  at: Tile;
  t: number;
}

interface StageCue {
  projectId: string;
  to: Stage;
  t: number;
}

interface PickedBottle {
  x: number;
  y: number;
  title: string;
  index: number;
  t: number;
}

/** 当天的天时，setScene 时算好 */
interface Ambience {
  date: string;
  season: number;
  progress: number;
  weather: Weather;
  cover: number;
  fest: Set<Festival>;
  fireworks: boolean;
}

/** [x, y, 半径, 颜色 r,g,b] */
type Glow = [number, number, number, string];

const SKIN = ['#f1c9a5', '#e6b48c', '#d9a074', '#c98d62'];
const HAIR = ['#2f2620', '#4a3426', '#1f1c1a', '#6b4a2e', '#3b2f2a'];
const SNOW = '#f3f6f8';
const SNOW_SHADE = '#d6e0e8';
const WARM = '255,206,110';
const LANTERN = '255,120,70';
const FIREWORK = ['#ffd36b', '#ff7a6b', '#8fd3ff', '#c99bff', '#9dff9b', '#ffffff', '#ffb3d9'];
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
const rgb = (c: number[]) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

export class IslandRenderer {
  map: IslandMap = buildIsland(0);
  /** 落成仪式时小岛暂停 */
  paused = false;
  private ctx: CanvasRenderingContext2D;
  private view = { w: 0, h: 0, dpr: 1, zoom: 1, panX: 0, panY: 0, tw: 30, ox: 0, oy: 0 };
  private scene: Scene | null = null;
  private walkers = new Map<string, Walker>();
  private theme = { label: '#fff', ink: '#263022', line: '#dfe2d2', accent: '#4f7136', accentInk: '#fff', sea: '#a9d3dc', seaDeep: '#8cc0cc' };
  private raf = 0;
  private last = 0;
  private t = 0;
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private grow = new Map<string, { houses: number; anim: number }>();
  private pulses: { at: Tile; t: number }[] = [];
  private bellRipples: BellRipple[] = [];
  private pickedBottles: PickedBottle[] = [];
  private stageCues: StageCue[] = [];
  private belled = new Set<string>();
  private lastBellAt: number | null = null;
  private granaryTransition: { from: number; to: number; t: number } | null = null;
  private fogTransition: { from: number; to: number; t: number } | null = null;
  private lights: Glow[] = [];
  private propArt = new IslandPropArt();
  private rnd = mulberry32(7);
  private amb: Ambience = { date: '', season: 0, progress: 0, weather: 'clear', cover: 0, fest: new Set(), fireworks: false };
  private day: DayLight = dayLight(12, 0);
  private ground = document.createElement('canvas');
  private groundKey = '';
  private drifts: Drift[] = [];
  private driftKind = '';
  private sparks: Spark[] = [];
  private nextRocket = 0;
  private calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 被点中的景物：画一圈高亮 */
  private focus: SceneryFocus | null = null;
  private sceneryIndex = -1;
  private suppressCuesOnce = false;
  private cueSuppressionDepth = 0;
  onTap: (hit: Hit, pt: { x: number; y: number }) => void = () => {};

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
      if (d && !d.moved) {
        const pt = this.localPt(e);
        this.onTap(this.hitAt(pt), pt);
      }
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

  /* ---------------- 场景同步 ---------------- */

  private clearQueuedCues() {
    // 后台期间可能已经排进队列的提示（rAF 暂停时不会播完）也一并丢掉，
    // 回到前台只显示终态。
    this.bellRipples = [];
    this.stageCues = [];
    this.pulses = [];
    this.pickedBottles = [];
    this.granaryTransition = null;
    this.fogTransition = null;
    for (const g of this.grow.values()) g.anim = 1;
  }

  /** 只压掉下一次场景差分；用于已有的单次基线切换。 */
  suppressNextCues() {
    this.suppressCuesOnce = true;
    this.clearQueuedCues();
  }

  /**
   * 持续压制提示直到调用方安装完 durable baseline；允许恢复与接管嵌套。
   * 返回的一次性 release 绑定这一层 scope，避免异步早退时误留 suppression。
   */
  beginCueSuppression(): () => void {
    this.cueSuppressionDepth++;
    this.clearQueuedCues();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.cueSuppressionDepth > 0) this.cueSuppressionDepth--;
    };
  }

  setScene(s: Scene) {
    const suppress = this.suppressCuesOnce || this.cueSuppressionDepth > 0;
    const prev = suppress ? null : this.scene;
    this.suppressCuesOnce = false;
    const cues = diffScene(prev, s);
    this.scene = s;
    if (s.date !== this.amb.date || s.season !== this.amb.season) {
      const weather = weatherOf(s.date, s.season);
      const progress = seasonProgress(s.date);
      const fest = new Set(festivalsOf(s.date));
      const [, mm, dd] = s.date.split('-').map(Number);
      this.amb = {
        date: s.date,
        season: s.season,
        progress,
        weather,
        cover: snowCover(s.season, progress, weather),
        fest,
        // 除夕到初七、元宵、跨年、国庆当天的夜里放烟花
        fireworks: fest.has('chunjie') || fest.has('yuanxiao') || fest.has('newyear') || (fest.has('guoqing') && mm === 10 && dd === 1),
      };
    }
    if (s.rings !== this.map.rings) {
      this.map = buildIsland(s.rings);
      this.layout();
    }
    for (const l of s.landmarks) {
      const key = 'lm:' + l.projectId;
      const g = this.grow.get(key);
      if (!g || g.houses !== l.index) this.grow.set(key, { houses: l.index, anim: prev ? 0 : 1 });
    }
    const keep = new Set<string>();
    for (const v of s.villages) {
      const site = this.map.villages[v.slot];
      const g = this.grow.get(v.projectId);
      if (!g) this.grow.set(v.projectId, { houses: v.houses, anim: 1 });
      else if (v.houses > g.houses) this.grow.set(v.projectId, { houses: v.houses, anim: prev ? 0 : 1 });
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
            face: r < 0.5 ? 1 : -1,
            walk: r * 6,
            moving: false,
            r: hash(w.id + 'r'),
          };
          this.walkers.set(w.id, p);
        }
        p.title = w.title;
        p.color = v.roof;
        p.leaving = v.stage === 3 && idx % 2 === 0;
        if (v.agenda?.phase === 'live') p.wait = 0;
      });
    }
    for (const id of [...this.walkers.keys()]) if (!keep.has(id)) this.walkers.delete(id);
    this.applyCues(cues, s);
  }

  private applyCues(cues: Cue[], scene: Scene) {
    const bellCandidates: BellCandidate[] = [];
    const pulsed = new Set<string>();
    for (const cue of cues) {
      if (cue.kind === 'house-built') {
        if (!pulsed.has(cue.projectId)) {
          pulsed.add(cue.projectId);
          this.triggerPulse(cue.projectId);
        }
      } else if (cue.kind === 'kiln') {
        if (!pulsed.has(cue.projectId)) {
          pulsed.add(cue.projectId);
          this.triggerPulse(cue.projectId);
        }
      } else if (cue.kind === 'stage-changed') {
        // 减弱动态效果时阶段直接到终态，不播灰尘落下 / 吹散
        if (!this.calm) this.stageCues.push({ projectId: cue.projectId, to: cue.to, t: 0 });
      } else if (cue.kind === 'granary-changed') {
        this.granaryTransition = { from: cue.from, to: cue.to, t: this.calm ? 1 : 0 };
      } else if (cue.kind === 'fog-changed') {
        this.fogTransition = { from: cue.from, to: cue.to, t: this.calm ? 1 : 0 };
      } else if (cue.kind === 'bell') {
        // Entering the soon window is a one-shot fact for this renderer. If
        // the global cooldown suppresses the sound, it is still considered
        // handled and will not ring again after the cooldown.
        if (this.belled.has(cue.eventId)) continue;
        this.belled.add(cue.eventId);
        const village = scene.villages.find((v) => v.projectId === cue.projectId);
        const item = village?.agenda?.soon?.find((x) => x.eventId === cue.eventId);
        if (village && item) {
          bellCandidates.push({ projectId: cue.projectId, eventId: cue.eventId, start: new Date(item.start).getTime(), slot: village.slot });
        }
      }
    }
    const selected = scene.selected?.kind === 'project' ? scene.selected.id : null;
    const chosen = pickBell(bellCandidates, this.lastBellAt, selected, scene.now);
    if (chosen) {
      // 冷却和去重照常记账；减弱动态效果时只是不画涟漪
      this.lastBellAt = scene.now;
      const village = scene.villages.find((v) => v.projectId === chosen.projectId);
      const at = village && this.map.villages[village.slot]?.center;
      if (at && !this.calm) this.bellRipples.push({ at, t: 0 });
    }
  }

  private triggerPulse(projectId: string) {
    if (this.calm) return;
    const v = this.scene?.villages.find((x) => x.projectId === projectId);
    if (v) this.pulses.push({ at: this.map.villages[v.slot].center, t: 0 });
    const l = this.scene?.landmarks.find((x) => x.projectId === projectId);
    const site = l && this.map.landmarks[l.index];
    if (site) this.pulses.push({ at: site, t: 0 });
  }

  /** 漂流瓶被捞起时的短暂出水动画；状态本身仍由 UI 的 localStorage 标记决定。 */
  pickDrift(title: string) {
    if (this.calm || !this.scene) return;
    const index = this.scene.drifting.findIndex((item) => item.title === title);
    if (index < 0) return;
    const [x, y] = this.driftBottleAnchor(index);
    this.pickedBottles.push({ x, y, title, index, t: 0 });
  }

  /** 一块砖飞进村落后，让村落亮一下 */
  pulse(projectId: string) {
    this.triggerPulse(projectId);
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
    const k = this.map.radius / 10.5;
    const base = Math.min((v.w * 0.97) / (15.2 * k), (v.h * 0.94) / (8.4 * k));
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

  private villageLabelText(v: VillageView): string {
    const stageTxt = v.stage ? ` · ${['', '安静', '蒙灰', '搬离'][v.stage]}` : '';
    const ag = v.agenda;
    const agendaParts = [
      ag?.phase === 'live' ? `${ag.title ?? '日程'} 至 ${this.timeText(ag.until)}` : ag?.phase === 'soon' ? `${ag.title ?? '日程'} 将开始` : '',
      ag?.later ? `稍后 ${ag.later} 场` : '',
      ag?.ended ? `待结算 ${ag.ended}` : '',
    ].filter(Boolean);
    return `${v.name} ${v.openCount}人${agendaParts.map((part) => ` · ${part}`).join('')}${stageTxt}`;
  }

  private villageLabelAnchor(v: VillageView): [number, number] {
    const ctr = this.map.villages[v.slot].center;
    const [x, y] = this.iso(ctr.i, ctr.j);
    return [x, y - this.view.tw * 1.05];
  }

  private choresLabelText(ch: ChoresView): string {
    const parts = [`杂务 ${ch.count}`];
    if (ch.live) parts.push(`${ch.live.title} 至 ${this.timeText(ch.live.until)}`);
    else if (ch.soon) parts.push(`${ch.soon.title} 将开始`);
    if (ch.later) parts.push(`稍后 ${ch.later}`);
    if (ch.ended) parts.push(`待结算 ${ch.ended}`);
    return parts.join(' · ');
  }

  private labelHitAt(pt: { x: number; y: number }, x: number, y: number, text: string, dot: boolean): boolean {
    const tw = this.view.tw;
    const c = this.ctx;
    c.save();
    c.font = `600 ${tw < 30 ? 10.5 : 12}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    const bw = c.measureText(text).width + (dot ? 22 : 14);
    c.restore();
    const bh = tw < 30 ? 18 : 21;
    return Math.abs(pt.x - x) <= bw / 2 && Math.abs(pt.y - y) <= bh / 2;
  }

  private pointToSegmentDistance(
    pt: { x: number; y: number },
    a: [number, number],
    b: [number, number],
  ): number {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.hypot(pt.x - a[0], pt.y - a[1]);
    const t = clamp(((pt.x - a[0]) * vx + (pt.y - a[1]) * vy) / len2, 0, 1);
    return Math.hypot(pt.x - (a[0] + vx * t), pt.y - (a[1] + vy * t));
  }

  private pointInPolygon(pt: { x: number; y: number }, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** 命中区域跟随真实扫帚的刷头和木柄，不用会盖住小屋的最小圆半径。 */
  private broomHitAt(pt: { x: number; y: number }, moving: boolean): boolean {
    const [x, y] = this.choresAgendaAnchor();
    const tw = this.view.tw;
    const swing = moving && !this.calm ? Math.sin(this.t * 5) * tw * 0.05 : 0;
    const brush: [number, number][] = [
      [x - tw * 0.2 + swing, y - tw * 0.08],
      [x + tw * 0.02 + swing, y - tw * 0.08],
      [x + tw * 0.08 + swing, y + tw * 0.02],
      [x - tw * 0.24 + swing, y + tw * 0.02],
    ];
    if (this.pointInPolygon(pt, brush)) return true;
    const handleA: [number, number] = [x - tw * 0.08, y - tw * 0.13];
    const handleB: [number, number] = [x + tw * 0.1 + swing, y - tw * 0.38];
    return this.pointToSegmentDistance(pt, handleA, handleB) <= Math.max(1.25, tw * 0.05);
  }

  private villageAgendaAnchor(v: VillageView): [number, number] {
    const center = this.map.villages[v.slot].center;
    return this.iso(center.i - 0.72, center.j - 0.72);
  }

  /** 告示牌数的是今天还没开始的场次（即将开始 + 稍后）；已结束的由砖坯表示，只有全天条幅时不立牌 */
  private hasNoticeBoard(agenda: AgendaView): boolean {
    return (agenda.soon?.length ?? 0) > 0 || agenda.later > 0;
  }

  /** 杂务的此刻层只在即将开始 / 进行中画扫帚，锚点就是扫帚的位置 */
  private choresAgendaAnchor(): [number, number] {
    const [x, y] = this.iso(this.map.chores.i, this.map.chores.j);
    const tw = this.view.tw;
    return [x + tw * 0.36, y + tw * 0.03];
  }

  /**
   * 灯塔条幅挂在廊台外侧：塔身在山顶上方总是露出来，挂在旁边既不被前面的山挡住，
   * 也不盖住塔身（塔身要留给「档案馆」的点击）。
   */
  private lighthouseBannerAnchor(): [number, number] {
    const [x, y] = this.iso(this.map.lighthouse.i, this.map.lighthouse.j);
    const tw = this.view.tw;
    return [x + tw * 0.7, y - tw * 1.3];
  }

  private isOpenWater(i: number, j: number): boolean {
    const m = this.map;
    for (const [di, dj] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]) if (m.at(Math.round(i + di), Math.round(j + dj))) return false;
    return true;
  }

  /**
   * 漂流瓶的位置：沿栈桥两侧找确实是海面、又离「码头」标签足够远的地方，
   * 避免瓶子画在陆地上或被标签盖住。地图不变时结果不变。
   */
  private driftBottleSpots(): [number, number][] {
    const m = this.map;
    const [di, dj] = m.pierDir;
    const [pi, pj] = [-dj, di];
    const tw = this.view.tw;
    const [lx, ly0] = this.iso(m.dock.i + 0.2, m.dock.j + m.pierLen + 0.6);
    const ly = ly0 + tw * 0.2;
    const spots: [number, number][] = [];
    for (const side of [1, -1]) {
      for (const t of [0.8, 1.6, 2.4, 3.2]) {
        for (const off of [1.1, 1.7]) {
          const i = m.dock.i + di * t + side * pi * off;
          const j = m.dock.j + dj * t + side * pj * off;
          if (!this.isOpenWater(i, j)) continue;
          const [x, y] = this.iso(i, j);
          if (Math.hypot(x - lx, y - ly) < tw * 1.1) continue;
          if (spots.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < tw * 0.45)) continue;
          spots.push([x, y]);
          break;
        }
      }
    }
    // 极端地形下找不到合适位置时，退回原来的固定排布
    for (let k = spots.length; k < DRIFT_BOTTLES_MAX; k++) spots.push(this.iso(m.dock.i + 0.95 + k * 0.55, m.dock.j + m.pierLen + 0.75 + k * 0.28));
    return spots;
  }

  private driftBottleAnchor(index: number): [number, number] {
    return this.driftBottleSpots()[index] ?? this.driftBottleSpots()[0];
  }

  /** 实际画出来的岸边码头和每一段栈桥；扩大的海上命中区不能抢走这里的点击。 */
  private dockHitAt(pt: { x: number; y: number }): boolean {
    const m = this.map;
    const { fi, fj } = this.tileCoords(pt);
    // 岸边码头地块本身。
    if (Math.abs(fi - m.dock.i) + Math.abs(fj - m.dock.j) <= 0.95) return true;

    const [di, dj] = m.pierDir;
    for (let k = 0; k <= m.pierLen; k++) {
      const pi = m.dock.i + di * (k + 0.2);
      const pj = m.dock.j + dj * (k + 0.2);
      const w = 0.28;
      const deck: [number, number][] = [
        this.iso(pi - w, pj - 0.5),
        this.iso(pi + w, pj - 0.5),
        this.iso(pi + w, pj + 0.5),
        this.iso(pi - w, pj + 0.5),
      ];
      if (this.pointInPolygon(pt, deck)) return true;
    }
    return false;
  }

  /** 漂流瓶在海上；窄屏重叠时取离点击点最近的瓶子，但不覆盖真实码头/栈桥。 */
  private driftHitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;
    const bottleRadius = Math.max(14, this.view.tw * 0.42);
    let nearest: { distance: number; title: string } | null = null;
    for (let k = 0; k < s.drifting.length; k++) {
      const [x, y] = this.driftBottleAnchor(k);
      const distance = Math.hypot(pt.x - x, pt.y - y);
      if (distance >= bottleRadius) continue;
      if (!nearest || distance < nearest.distance) nearest = { distance, title: s.drifting[k].title };
    }
    return nearest ? { kind: 'drift', title: nearest.title } : null;
  }

  /**
   * 告示牌、条幅、扫帚：只认画出来的那一小块，不能盖住村落中心和杂务小屋本身，
   * 否则点村落、点小人、点小屋都会变成看日程说明。
   */
  private agendaHitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;
    const drift = this.driftHitAt(pt);
    if (drift) return drift;
    const tw = this.view.tw;
    const r = Math.max(8, tw * 0.22);
    for (const v of s.villages) {
      if (!v.agenda) continue;
      const [x, y] = this.villageAgendaAnchor(v);
      const hasBoard = this.hasNoticeBoard(v.agenda);
      if (hasBoard && Math.hypot(pt.x - x, pt.y - y) < r) return { kind: 'agenda', target: v.projectId };
      const banners = this.villageBannerLayout(v);
      for (const b of banners) {
        if (this.bannerHitAt(pt, b)) return { kind: 'agenda', target: v.projectId };
      }
      // 进行中 / 仅待结算没有额外道具；用已经画出的村名标签承载说明，
      // 避开井和小人，保持项目点击区域不变。
      if (!hasBoard && !banners.length) {
        const [lx, ly] = this.villageLabelAnchor(v);
        if (this.labelHitAt(pt, lx, ly, this.villageLabelText(v), true)) return { kind: 'agenda', target: v.projectId };
      }
    }
    if ((s.chores.live || s.chores.soon) && this.broomHitAt(pt, !!s.chores.live)) {
      return { kind: 'agenda', target: CHORES };
    }
    if (s.lighthouseBanners.length) {
      const [lx] = this.iso(this.map.lighthouse.i, this.map.lighthouse.j);
      // 条幅区域，但塔身两侧 0.25 格留给档案馆。
      for (const banner of this.lighthouseBannerLayout(s.lighthouseBanners)) {
        if (this.bannerHitAt(pt, banner) && Math.abs(pt.x - lx) >= tw * 0.25) {
          return { kind: 'agenda', target: '__lighthouse__' };
        }
      }
    }
    return null;
  }

  private timeText(stamp: string | undefined): string {
    if (!stamp) return '稍后';
    const d = new Date(stamp);
    if (!Number.isFinite(d.getTime())) return '稍后';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private infoTargetForHit(hit: Hit): InfoTarget | null {
    const s = this.scene;
    if (!s || !hit) return null;
    if (hit.kind === 'drift') return { kind: 'drift', title: hit.title };
    if (hit.kind !== 'agenda') return null;
    if (hit.target === '__lighthouse__') {
      return { kind: 'agenda', target: hit.target, targetName: '灯塔', phase: 'allday', later: 0, ended: 0, banners: s.lighthouseBanners };
    }
    if (hit.target === CHORES) {
      const c = s.chores;
      return {
        kind: 'agenda',
        target: CHORES,
        targetName: '杂务',
        phase: c.live ? 'live' : c.soon ? 'soon' : c.ended ? 'ended' : 'later',
        title: c.live?.title ?? c.soon?.title,
        until: c.live?.until,
        start: c.live ? undefined : c.soon?.start,
        later: c.later,
        ended: c.ended,
        banners: [],
      };
    }
    const v = s.villages.find((item) => item.projectId === hit.target);
    if (!v?.agenda) return null;
    return { kind: 'agenda', target: v.projectId, targetName: v.name, ...v.agenda };
  }

  private inspectAgenda(hit: Hit, x: number, y: number, ctx: InfoContext): SceneryInspection | null {
    const target = this.infoTargetForHit(hit);
    if (!target) return null;
    return this.selectScenery(target, null, x, y, ctx);
  }

  /** 屏幕上的这一点是不是海面（用于海上的反光、星星倒影） */
  private onSea(x: number, y: number) {
    const { fi, fj } = this.tileCoords({ x, y });
    return !this.map.at(Math.round(fi), Math.round(fj)) && !this.map.at(Math.round(fi - 0.6), Math.round(fj - 0.6));
  }

  hitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;
    if (this.dockHitAt(pt)) return { kind: 'dock' };
    const drift = this.driftHitAt(pt);
    if (drift) return drift;
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
    const agendaHit = this.agendaHitAt(pt);
    if (agendaHit) return agendaHit;
    const { fi, fj } = this.tileCoords(pt);
    const m = this.map;
    const near = (t: Tile, r: number) => Math.hypot(t.i - fi, t.j - fj) < r;
    if (fj > m.dock.j - 0.6 && Math.abs(fi - m.dock.i) < 1.8 && fj < m.dock.j + m.pierLen + 1) return { kind: 'dock' };
    if (near(m.granary, 0.9)) return { kind: 'granary' };
    if (near(m.chores, 0.9)) return { kind: 'chores' };
    if (near(m.lighthouse, 1.3)) return { kind: 'archive' };
    {
      // 灯塔立在山顶，塔身在屏幕上比地块高出一截
      const [lx, ly] = this.iso(m.lighthouse.i, m.lighthouse.j);
      const tw = this.view.tw;
      if (Math.abs(pt.x - lx) < tw * 0.25 && pt.y < ly - tw * 0.5 && pt.y > ly - tw * 1.9) return { kind: 'archive' };
    }
    for (const l of s.landmarks) {
      const site = m.landmarks[l.index];
      if (site && near(site, 0.8)) return { kind: 'project', id: l.projectId };
    }
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

  /** 当前场景的景物说明上下文；指针和键盘浏览共用。 */
  private infoContext(): InfoContext | null {
    const s = this.scene;
    if (!s) return null;
    const a = this.amb;
    const [yy, mm, dd] = s.date.split('-').map(Number);
    return {
      season: a.season,
      progress: a.progress,
      cover: a.cover,
      weather: a.weather,
      light: s.light,
      hour: s.hour,
      fest: [...a.fest],
      moon: moonPhase(new Date(yy, mm - 1, dd, Math.floor(s.hour), (s.hour % 1) * 60)),
    };
  }

  private selectScenery(target: InfoTarget, focus: SceneryFocus | null, x: number, y: number, ctx: InfoContext): SceneryInspection {
    this.focus = focus;
    return {
      info: describe(target, ctx),
      x,
      y,
      target: target.kind === 'drift' ? target : undefined,
    };
  }

  /** 点到的景物（树、山、田、溪、空地、海）及其说明；anchor 是信息卡指向的位置 */
  inspect(pt: { x: number; y: number }): SceneryInspection | null {
    const s = this.scene;
    const ctx = this.infoContext();
    if (!s || !ctx) return null;
    const agendaHit = this.agendaHitAt(pt);
    if (agendaHit) return this.inspectAgenda(agendaHit, pt.x, pt.y, ctx);
    const m = this.map;
    const { tw } = this.view;
    const hw = tw / 2;
    const hh = tw / 4;
    const occupied = new Set(s.villages.map((v) => v.slot));
    const built = new Set(s.landmarks.map((l) => l.index));
    // 树：树冠比地块高，按屏幕上的外框找，取最靠前的一棵
    let best: { t: Tile; x: number; y: number; s: number; kind: 'pine' | 'round'; seed: number } | null = null;
    for (const t of m.all) {
      if (!t.trees.length || (t.landmark >= 0 && built.has(t.landmark))) continue;
      const [x0, y0] = this.iso(t.i, t.j);
      for (const tr of t.trees) {
        const x = x0 + (tr.dx - tr.dy) * hw;
        const y = y0 + (tr.dx + tr.dy) * hh;
        const sz = tw * 0.42 * tr.s;
        if (Math.abs(pt.x - x) < sz * 0.4 && pt.y < y + sz * 0.1 && pt.y > y - sz * 1.3 && (!best || y > best.y)) {
          best = { t, x, y, s: sz, kind: tr.kind, seed: tileHash(t.i, t.j, 70 + Math.round(tr.dx * 100)) };
        }
      }
    }
    if (best) {
      const target: InfoTarget = { kind: 'tree', tree: best.kind, cherry: best.seed % 1 < 0.35, forest: best.t.type === 'forest' };
      return this.selectScenery(target, { i: best.t.i, j: best.t.j, tree: [best.x, best.y, best.s] }, best.x, best.y - best.s * (best.kind === 'pine' ? 1.3 : 1), ctx);
    }
    // 山：同样按屏幕外框
    let mt: Tile | null = null;
    for (const t of m.all) {
      if (t.type !== 'mountain') continue;
      const [x, y] = this.iso(t.i, t.j);
      const h = tw * (0.75 + t.v * 0.55);
      const k = (y + tw * 0.1 - pt.y) / (h + tw * 0.1);
      if (k >= 0 && k <= 1 && Math.abs(pt.x - x) < tw * 0.48 * (1 - k) && (!mt || t.i + t.j > mt.i + mt.j)) mt = t;
    }
    const { fi, fj } = this.tileCoords(pt);
    const t = mt ?? m.at(Math.round(fi), Math.round(fj));
    if (!t) return this.selectScenery({ kind: 'sea' }, null, pt.x, pt.y, ctx);
    const site = t.village >= 0 && !occupied.has(t.village) ? 'village' : t.landmark >= 0 && !built.has(t.landmark) ? 'landmark' : undefined;
    const [x, y] = this.iso(t.i, t.j);
    const top = t.type === 'mountain' ? y - tw * (0.75 + t.v * 0.55) : y - hh;
    return this.selectScenery({ kind: 'ground', type: t.type, ring: t.ring, site }, { i: t.i, j: t.j }, x, top, ctx);
  }

  /**
   * 键盘浏览真实景物。候选来自当前地图对象，并按最终说明去重：
   * 键盘用户能访问所有不同的说明，同时不会被几十棵同类树或草地淹没。
   */
  browseScenery(step: 1 | -1): SceneryInspection | null {
    const s = this.scene;
    const ctx = this.infoContext();
    if (!s || !ctx) return null;
    const m = this.map;
    const { tw, w, h } = this.view;
    const hw = tw / 2;
    const hh = tw / 4;
    const occupied = new Set(s.villages.map((v) => v.slot));
    const built = new Set(s.landmarks.map((l) => l.index));
    const candidates: SceneryCandidate[] = [];
    const seen = new Set<string>();
    const add = (target: InfoTarget, focus: SceneryFocus | null, x: number, y: number) => {
      const info = describe(target, ctx);
      const key = [info.title, info.sub ?? '', ...info.lines].join('\u0000');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        info,
        focus,
        x,
        y,
        target: target.kind === 'drift' ? target : undefined,
      });
    };

    for (const t of m.all) {
      if (!t.trees.length || (t.landmark >= 0 && built.has(t.landmark))) continue;
      const [x0, y0] = this.iso(t.i, t.j);
      for (const tr of t.trees) {
        const x = x0 + (tr.dx - tr.dy) * hw;
        const y = y0 + (tr.dx + tr.dy) * hh;
        const sz = tw * 0.42 * tr.s;
        const anchorY = y - sz * (tr.kind === 'pine' ? 1.3 : 1);
        if (x < 0 || x > w || anchorY < 0 || anchorY > h) continue;
        const seed = tileHash(t.i, t.j, 70 + Math.round(tr.dx * 100));
        add(
          { kind: 'tree', tree: tr.kind, cherry: seed % 1 < 0.35, forest: t.type === 'forest' },
          { i: t.i, j: t.j, tree: [x, y, sz] },
          x,
          anchorY,
        );
      }
    }

    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      const top = t.type === 'mountain' ? y - tw * (0.75 + t.v * 0.55) : y - hh;
      if (x < 0 || x > w || top < 0 || top > h) continue;
      const site = t.village >= 0 && !occupied.has(t.village) ? 'village' : t.landmark >= 0 && !built.has(t.landmark) ? 'landmark' : undefined;
      add({ kind: 'ground', type: t.type, ring: t.ring, site }, { i: t.i, j: t.j }, x, top);
    }

    for (const v of s.villages) {
      if (!v.agenda) continue;
      const hasProp = this.hasNoticeBoard(v.agenda) || v.agenda.banners.length > 0;
      const [x, y] = hasProp ? this.villageAgendaAnchor(v) : this.villageLabelAnchor(v);
      add({ kind: 'agenda', target: v.projectId, targetName: v.name, ...v.agenda }, null, x, y);
    }
    if (s.chores.live || s.chores.soon) {
      const [x, y] = this.choresAgendaAnchor();
      const target = this.infoTargetForHit({ kind: 'agenda', target: CHORES });
      if (target) add(target, null, x, y);
    }
    if (s.lighthouseBanners.length) {
      const [x, y] = this.lighthouseBannerAnchor();
      add({ kind: 'agenda', target: '__lighthouse__', targetName: '灯塔', phase: 'allday', later: 0, ended: 0, banners: s.lighthouseBanners }, null, x, y);
    }
    for (let k = 0; k < s.drifting.length; k++) {
      const [x, y] = this.driftBottleAnchor(k);
      add({ kind: 'drift', title: s.drifting[k].title }, null, x, y);
    }

    // 海面没有单独的地块对象，但说明本身也是同一套 describe() 语义。
    add({ kind: 'sea' }, null, Math.max(16, w * 0.08), Math.max(16, h * 0.14));

    if (!candidates.length) return null;
    if (this.sceneryIndex < 0) this.sceneryIndex = step > 0 ? 0 : candidates.length - 1;
    else this.sceneryIndex = (this.sceneryIndex + step + candidates.length) % candidates.length;
    const current = candidates[this.sceneryIndex];
    this.focus = current.focus;
    return { info: current.info, x: current.x, y: current.y, target: current.target };
  }

  clearFocus() {
    this.focus = null;
  }

  /* ---------------- 动画 ---------------- */

  private step(dt: number) {
    const s = this.scene;
    if (!s) return;
    for (const g of this.grow.values()) if (g.anim < 1) g.anim = Math.min(1, g.anim + dt * (this.paused ? 0.6 : 1.6));
    for (const pl of this.pulses) pl.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < 1.4);
    for (const ripple of this.bellRipples) ripple.t += dt;
    this.bellRipples = this.bellRipples.filter((ripple) => ripple.t < 1.2);
    for (const bottle of this.pickedBottles) bottle.t += dt;
    this.pickedBottles = this.pickedBottles.filter((bottle) => bottle.t < 0.4);
    for (const cue of this.stageCues) cue.t += dt;
    this.stageCues = this.stageCues.filter((cue) => cue.t < 1.2);
    if (this.granaryTransition) {
      this.granaryTransition.t = Math.min(1, this.granaryTransition.t + dt / (this.calm ? 0.001 : 0.8));
      if (this.granaryTransition.t >= 1) this.granaryTransition = null;
    }
    if (this.fogTransition) {
      this.fogTransition.t = Math.min(1, this.fogTransition.t + dt / (this.calm ? 0.001 : 1.5));
      if (this.fogTransition.t >= 1) this.fogTransition = null;
    }
    this.stepDrifts(dt);
    this.stepSparks(dt);
    if (this.paused) return;
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
        p.moving = true;
        p.walk += dt * 9;
        // 屏幕上的水平方向是 i − j
        if (Math.abs(dx - dy) > 0.01) p.face = dx - dy > 0 ? 1 : -1;
        continue;
      }
      p.moving = false;
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
  }

  private retarget(p: Walker, site: VillageSite, s: Scene) {
    const r = this.rnd();
    const v = s.villages.find((x) => x.slot === p.slot);
    const houses = Math.max(1, v?.houses ?? 1);
    let t: { i: number; j: number };
    if (v?.agenda?.phase === 'live') {
      const angle = hash(p.id + ':gathering') * Math.PI * 2;
      t = { i: site.center.i + Math.cos(angle) * 0.72, j: site.center.j + Math.sin(angle) * 0.72 };
    } else if (p.leaving && r < 0.5) t = { i: this.map.dock.i, j: this.map.dock.j + 0.6 };
    else if (r < 0.45) t = site.center;
    else t = site.slots[Math.floor(this.rnd() * houses)] ?? site.center;
    p.tx = t.i + (this.rnd() - 0.5) * 0.6;
    p.ty = t.j + (this.rnd() - 0.5) * 0.6;
    const quiet = v ? [1, 2.2, 3.5, 2][v.stage] : 1;
    // 下雨天和夜里，大家都待在家附近
    const stay = (s.light === 'night' ? 2 : 1) * (this.amb.weather === 'rain' ? 1.5 : 1);
    p.wait = (1 + this.rnd() * 4) * quiet * stay;
  }

  /** 当前该飘什么：雪、雨、春天的花瓣、秋天的落叶 */
  private driftWanted(): [string, number] {
    const a = this.amb;
    const k = this.calm ? 0.35 : 1;
    // 降水粒子只由当天真实天气决定；地面积雪不等于正在下雪。
    if (a.weather === 'snow') return ['snow', Math.round(110 * k)];
    if (a.weather === 'rain') return ['rain', Math.round(140 * k)];
    if (a.season === 0 && a.progress < 0.75) return ['petal', Math.round(26 * k)];
    if (a.season === 2) return ['leaf', Math.round((14 + 22 * a.progress) * k)];
    return ['', 0];
  }

  private spawnDrift(kind: string, anywhere: boolean): Drift {
    const v = this.view;
    const r = this.rnd;
    const x = r() * (v.w + 80) - 40;
    const y = anywhere ? r() * v.h : -20 - r() * 40;
    const a = this.amb;
    if (kind === 'rain') return { x, y, vx: -40, vy: 520 + r() * 180, rot: 0, vr: 0, size: 8 + r() * 8, color: '' };
    if (kind === 'snow') return { x, y, vx: (r() - 0.5) * 14, vy: 18 + r() * 26, rot: r() * 6, vr: 0.6 + r(), size: 1.1 + r() * 1.9, color: SNOW };
    if (kind === 'petal') return { x, y, vx: 16 + r() * 18, vy: 16 + r() * 16, rot: r() * 6, vr: (r() - 0.5) * 4, size: 2.2 + r() * 1.8, color: r() < 0.7 ? '#f6c1cf' : '#fbe3ea' };
    const leaf = a.progress < 0.4 ? ['#e2b13c', '#d98a2b', '#c9a23a'] : ['#c4532e', '#d9782a', '#a8432a', '#e0a33a'];
    return { x, y, vx: 10 + r() * 20, vy: 20 + r() * 18, rot: r() * 6, vr: (r() - 0.5) * 5, size: 2.6 + r() * 2, color: leaf[Math.floor(r() * leaf.length)] };
  }

  private stepDrifts(dt: number) {
    const [kind, n] = this.driftWanted();
    if (kind !== this.driftKind) {
      this.driftKind = kind;
      this.drifts = [];
    }
    while (this.drifts.length < n) this.drifts.push(this.spawnDrift(kind, true));
    if (this.drifts.length > n) this.drifts.length = n;
    const v = this.view;
    for (let k = 0; k < this.drifts.length; k++) {
      const d = this.drifts[k];
      const sway = kind === 'rain' ? 0 : Math.sin(this.t * 1.3 + k) * (kind === 'snow' ? 8 : 18);
      d.x += (d.vx + sway) * dt;
      d.y += d.vy * dt;
      d.rot += d.vr * dt;
      if (d.y > v.h + 20 || d.x > v.w + 50 || d.x < -50) this.drifts[k] = this.spawnDrift(kind, false);
    }
  }

  private stepSparks(dt: number) {
    const v = this.view;
    const show = this.amb.fireworks && !this.calm && (this.day.night > 0.45 || this.scene?.light === 'night');
    if (show && this.t > this.nextRocket) {
      this.nextRocket = this.t + 0.6 + this.rnd() * 1.4;
      const x = v.w * (0.15 + this.rnd() * 0.7);
      this.sparks.push({ x, y: v.h * 0.78, vx: (this.rnd() - 0.5) * 30, vy: -v.h * (0.7 + this.rnd() * 0.35), life: 0, max: 2, color: FIREWORK[Math.floor(this.rnd() * FIREWORK.length)], rocket: true, burstAt: 0.7 + this.rnd() * 0.35 });
    }
    const born: Spark[] = [];
    for (const p of this.sparks) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.rocket) {
        p.vy *= 1 - dt * 1.3;
        if (p.life > p.burstAt) {
          p.life = p.max;
          const n = 34 + Math.floor(this.rnd() * 24);
          const sp = v.h * (0.16 + this.rnd() * 0.12);
          const twin = this.rnd() < 0.35 ? FIREWORK[Math.floor(this.rnd() * FIREWORK.length)] : p.color;
          born.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0, max: 0.45, color: p.color, rocket: false, burstAt: 0, flash: true });
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2 + this.rnd() * 0.2;
            const s = sp * (0.35 + this.rnd() * 0.75);
            born.push({ x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 1.3 + this.rnd() * 0.6, color: k % 2 ? twin : p.color, rocket: false, burstAt: 0 });
          }
        }
      } else {
        if (p.flash) continue;
        p.vx *= 1 - dt * 1.6;
        p.vy = p.vy * (1 - dt * 1.6) + v.h * 0.12 * dt;
      }
    }
    this.sparks = this.sparks.filter((p) => p.life < p.max).concat(born);
  }

  /* ---------------- 绘制工具 ---------------- */

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
  private bannerStep(): number {
    return Math.max(this.view.tw * 0.36, 11);
  }

  private bannerWidth(title: string): number {
    const tw = this.view.tw;
    return Math.min(tw * 1.35, Math.max(tw * 0.72, title.length * tw * 0.095));
  }

  /**
   * 村落条幅横着排在告示牌上方：竖着叠会撞上村名标签。按每条布的实际宽度留间距，
   * 整排以告示牌为中心。
   */
  private villageBannerLayout(v: VillageView): { x: number; y: number; w: number; title: string }[] {
    if (!v.agenda?.banners.length) return [];
    const [ax, ay] = this.villageAgendaAnchor(v);
    const tw = this.view.tw;
    const gap = Math.max(tw * 0.08, 3);
    const titles = v.agenda.banners.slice(0, BANNERS_MAX);
    const widths = titles.map((title) => this.bannerWidth(title));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (titles.length - 1);
    let x = ax - total / 2;
    return titles.map((title, k) => {
      const item = { x: x + widths[k] / 2, y: ay - tw * 0.28, w: widths[k], title };
      x += widths[k] + gap;
      return item;
    });
  }

  private bannerHitAt(
    pt: { x: number; y: number },
    banner: { x: number; y: number; w: number },
  ): boolean {
    const tw = this.view.tw;
    return Math.abs(pt.x - banner.x) < banner.w * 0.48
      && pt.y > banner.y - Math.max(tw * 0.2, 6)
      && pt.y < banner.y + Math.max(tw * 0.15, 5);
  }

  private lighthouseBannerLayout(titles: string[]): { x: number; y: number; w: number; title: string }[] {
    const [x, y] = this.lighthouseBannerAnchor();
    return titles.slice(0, BANNERS_MAX).map((title, k) => ({
      x,
      y: y - k * this.bannerStep(),
      w: this.bannerWidth(title),
      title,
    }));
  }

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
