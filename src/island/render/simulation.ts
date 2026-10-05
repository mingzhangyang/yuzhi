import { dayLight, festivalsOf, seasonProgress, snowCover, weatherOf, type DayLight } from '../ambience';
import { diffScene, pickBell, type BellCandidate, type Cue } from '../cues';
import { buildIsland, mulberry32, type Tile, type VillageSite } from '../map';
import type { Ambience, BellRipple, Drift, PickedBottle, Scene, Spark, StageCue, Walker } from './model';
import { FIREWORK, HAIR, SKIN, SNOW } from './style';
import { hash } from './utils';
import { IslandInteraction } from './interaction';

/** Scene 安装、cue、人物和天气粒子状态；绘制层只读取这些状态。 */
export abstract class IslandSimulation extends IslandInteraction {
  paused = false;
  protected walkers = new Map<string, Walker>();
  protected grow = new Map<string, { houses: number; anim: number }>();
  protected pulses: { at: Tile; t: number }[] = [];
  protected bellRipples: BellRipple[] = [];
  protected pickedBottles: PickedBottle[] = [];
  protected stageCues: StageCue[] = [];
  private belled = new Set<string>();
  private lastBellAt: number | null = null;
  protected granaryTransition: { from: number; to: number; t: number } | null = null;
  protected fogTransition: { from: number; to: number; t: number } | null = null;
  protected rnd = mulberry32(7);
  protected amb: Ambience = { date: '', season: 0, progress: 0, weather: 'clear', cover: 0, fest: new Set(), fireworks: false };
  protected day: DayLight = dayLight(12, 0);
  protected drifts: Drift[] = [];
  protected driftKind = '';
  protected sparks: Spark[] = [];
  private nextRocket = 0;
  private suppressCuesOnce = false;
  private cueSuppressionDepth = 0;

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

  protected step(dt: number) {
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

}
