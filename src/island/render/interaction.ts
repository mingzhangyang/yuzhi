import { BANNERS_MAX, DRIFT_BOTTLES_MAX } from '../../logic/config';
import { CHORES } from '../../types';
import { moonPhase } from '../ambience';
import { describe, type InfoContext, type InfoTarget } from '../info';
import { tileHash, type Tile } from '../map';
import type { AgendaView, Ambience, ChoresView, Hit, SceneryCandidate, SceneryFocus, SceneryInspection, VillageView, Walker } from './model';
import { clamp } from './utils';
import { IslandViewport } from './viewport';

/** 命中、说明和键盘浏览；不推进动画，也不绘制。 */
export abstract class IslandInteraction extends IslandViewport {
  protected abstract walkers: Map<string, Walker>;
  protected abstract amb: Ambience;
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  protected focus: SceneryFocus | null = null;
  private sceneryIndex = -1;
  onTap: (hit: Hit, pt: { x: number; y: number }) => void = () => {};

  protected bindInteraction() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, px: this.view.panX, py: this.view.panY, moved: false };
    });
    this.canvas.addEventListener('pointermove', (e) => {
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
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved) {
        const pt = this.localPt(e);
        this.onTap(this.hitAt(pt), pt);
      }
    });
    this.canvas.addEventListener('pointercancel', () => (this.drag = null));
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    window.addEventListener('resize', () => this.resize());
  }

  protected villageLabelText(v: VillageView): string {
    const stageTxt = v.stage ? ` · ${['', '安静', '蒙灰', '搬离'][v.stage]}` : '';
    const ag = v.agenda;
    const live = ag?.live?.[0];
    const soon = ag?.soon?.[0];
    const agendaParts = [
      live ? `${live.title} 至 ${this.timeText(live.end)}` : '',
      soon ? `${soon.title} 将开始` : '',
      ag?.later ? `稍后 ${ag.later} 场` : '',
      ag?.ended ? `待结算 ${ag.ended}` : '',
    ].filter(Boolean);
    return `${v.name} ${v.openCount}人${agendaParts.map((part) => ` · ${part}`).join('')}${stageTxt}`;
  }

  protected villageLabelAnchor(v: VillageView): [number, number] {
    const ctr = this.map.villages[v.slot].center;
    const [x, y] = this.iso(ctr.i, ctr.j);
    return [x, y - this.view.tw * 1.05];
  }

  protected choresLabelText(ch: ChoresView): string {
    const parts = [`杂务 ${ch.count}`];
    if (ch.live) parts.push(`${ch.live.title} 至 ${this.timeText(ch.live.until)}`);
    if (ch.soon) parts.push(`${ch.soon.title} 将开始`);
    if (ch.later) parts.push(`稍后 ${ch.later}`);
    if (ch.ended) parts.push(`待结算 ${ch.ended}`);
    return parts.join(' · ');
  }

  protected labelHitAt(pt: { x: number; y: number }, x: number, y: number, text: string, dot: boolean): boolean {
    const tw = this.view.tw;
    const c = this.ctx;
    c.save();
    c.font = `600 ${tw < 30 ? 10.5 : 12}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    const bw = c.measureText(text).width + (dot ? 22 : 14);
    c.restore();
    const bh = tw < 30 ? 18 : 21;
    return Math.abs(pt.x - x) <= bw / 2 && Math.abs(pt.y - y) <= bh / 2;
  }

  protected pointToSegmentDistance(
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

  protected pointInPolygon(pt: { x: number; y: number }, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** 命中区域跟随真实扫帚的刷头和木柄，不用会盖住小屋的最小圆半径。 */
  protected broomHitAt(pt: { x: number; y: number }, moving: boolean): boolean {
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

  protected villageAgendaAnchor(v: VillageView): [number, number] {
    const center = this.map.villages[v.slot].center;
    return this.iso(center.i - 0.72, center.j - 0.72);
  }

  /** 告示牌数的是今天还没开始的场次（即将开始 + 稍后）；已结束的由砖坯表示，只有全天条幅时不立牌 */
  protected hasNoticeBoard(agenda: AgendaView): boolean {
    return (agenda.soon?.length ?? 0) > 0 || agenda.later > 0;
  }

  /** 杂务的此刻层只在即将开始 / 进行中画扫帚，锚点就是扫帚的位置 */
  protected choresAgendaAnchor(): [number, number] {
    const [x, y] = this.iso(this.map.chores.i, this.map.chores.j);
    const tw = this.view.tw;
    return [x + tw * 0.36, y + tw * 0.03];
  }

  /**
   * 灯塔条幅挂在廊台外侧：塔身在山顶上方总是露出来，挂在旁边既不被前面的山挡住，
   * 也不盖住塔身（塔身要留给「档案馆」的点击）。
   */
  protected lighthouseBannerAnchor(): [number, number] {
    const [x, y] = this.iso(this.map.lighthouse.i, this.map.lighthouse.j);
    const tw = this.view.tw;
    return [x + tw * 0.7, y - tw * 1.3];
  }

  protected isOpenWater(i: number, j: number): boolean {
    const m = this.map;
    for (const [di, dj] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]) if (m.at(Math.round(i + di), Math.round(j + dj))) return false;
    return true;
  }

  /**
   * 漂流瓶的位置：沿栈桥两侧找确实是海面、又离「码头」标签足够远的地方，
   * 避免瓶子画在陆地上或被标签盖住。地图不变时结果不变。
   */
  protected driftBottleSpots(): [number, number][] {
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

  protected driftBottleAnchor(index: number): [number, number] {
    return this.driftBottleSpots()[index] ?? this.driftBottleSpots()[0];
  }

  /** 实际画出来的岸边码头和每一段栈桥；扩大的海上命中区不能抢走这里的点击。 */
  protected dockHitAt(pt: { x: number; y: number }): boolean {
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
  protected driftHitAt(pt: { x: number; y: number }): Hit {
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
  protected agendaHitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;
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

  protected timeText(stamp: string | undefined): string {
    if (!stamp) return '稍后';
    const d = new Date(stamp);
    if (!Number.isFinite(d.getTime())) return '稍后';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  protected infoTargetForHit(hit: Hit): InfoTarget | null {
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
        start: c.soon?.start,
        live: c.live ? [{ title: c.live.title, end: c.live.until }] : [],
        soon: c.soon ? [{ title: c.soon.title, start: c.soon.start }] : [],
        later: c.later,
        ended: c.ended,
        banners: [],
      };
    }
    const v = s.villages.find((item) => item.projectId === hit.target);
    if (!v?.agenda) return null;
    return { kind: 'agenda', target: v.projectId, targetName: v.name, ...v.agenda };
  }

  protected inspectAgenda(hit: Hit, x: number, y: number, ctx: InfoContext): SceneryInspection | null {
    const target = this.infoTargetForHit(hit);
    if (!target) return null;
    return this.selectScenery(target, null, x, y, ctx);
  }

  /** 屏幕上的这一点是不是海面（用于海上的反光、星星倒影） */
  protected onSea(x: number, y: number) {
    const { fi, fj } = this.tileCoords({ x, y });
    return !this.map.at(Math.round(fi), Math.round(fj)) && !this.map.at(Math.round(fi - 0.6), Math.round(fj - 0.6));
  }

  /** 前景可动实体永远优先于其经过的码头、瓶子和日程道具。 */
  protected walkerHitAt(pt: { x: number; y: number }): Hit {
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
    return best ? { kind: 'task', id: best.id } : null;
  }

  hitAt(pt: { x: number; y: number }): Hit {
    const s = this.scene;
    if (!s) return null;

    // 固定命中层级：前景实体 > 精确结构 > 海上辅助目标 > 日程道具 > 宽泛区域。
    const walker = this.walkerHitAt(pt);
    if (walker) return walker;
    if (this.dockHitAt(pt)) return { kind: 'dock' };
    const drift = this.driftHitAt(pt);
    if (drift) return drift;
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
  protected infoContext(): InfoContext | null {
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

  protected selectScenery(target: InfoTarget, focus: SceneryFocus | null, x: number, y: number, ctx: InfoContext): SceneryInspection {
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
    // Inspection and click selection intentionally have different semantics:
    // clicks obey foreground z-order, while inspection can still describe a
    // visible agenda prop or bottle even when a moving walker crosses it.
    const inspectable = this.driftHitAt(pt) ?? this.agendaHitAt(pt);
    if (inspectable) return this.inspectAgenda(inspectable, pt.x, pt.y, ctx);
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


  protected bannerStep(): number {
    return Math.max(this.view.tw * 0.36, 11);
  }

  protected bannerWidth(title: string): number {
    const tw = this.view.tw;
    return Math.min(tw * 1.35, Math.max(tw * 0.72, title.length * tw * 0.095));
  }

  /**
   * 村落条幅横着排在告示牌上方：竖着叠会撞上村名标签。按每条布的实际宽度留间距，
   * 整排以告示牌为中心。
   */
  protected villageBannerLayout(v: VillageView): { x: number; y: number; w: number; title: string }[] {
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

  protected bannerHitAt(
    pt: { x: number; y: number },
    banner: { x: number; y: number; w: number },
  ): boolean {
    const tw = this.view.tw;
    return Math.abs(pt.x - banner.x) < banner.w * 0.48
      && pt.y > banner.y - Math.max(tw * 0.2, 6)
      && pt.y < banner.y + Math.max(tw * 0.15, 5);
  }

  protected lighthouseBannerLayout(titles: string[]): { x: number; y: number; w: number; title: string }[] {
    const [x, y] = this.lighthouseBannerAnchor();
    return titles.slice(0, BANNERS_MAX).map((title, k) => ({
      x,
      y: y - k * this.bannerStep(),
      w: this.bannerWidth(title),
      title,
    }));
  }

}
