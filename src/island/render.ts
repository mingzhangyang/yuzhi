/**
 * Island Canvas orchestration.
 *
 * Viewport, interaction, simulation, and paint layers own their respective
 * state. This facade only owns the rAF lifecycle and frame composition.
 */
import { dayLight } from './ambience';
import { tileHash } from './map';
import type { LandmarkView, VillageView, Walker } from './render/model';
import { IslandEffectsPainter } from './render/paint/effects';
import type { HouseVariant } from './render/paint/structures';
import { isDeterioratingStageCue } from './render/simulation';
import { HOUSE_SCALE, personSize, SNOW, WARM } from './render/style';
import { hash, mix, shade } from './render/utils';

/**
 * 同一村落里逐户取值。hash(projectId + slotIdx) 只改了末位字符，FNV 的结果几乎不变，
 * 一个村子的房子会全是同一种样式、同时亮灯或同时熄灯；这里再用地块哈希把户号充分打散。
 */
function houseHash(projectId: string, slot: number, salt: number): number {
  return tileHash(slot, Math.floor(hash(projectId) * 1e6), 200 + salt);
}

export type { AgendaView, ChoresView, Hit, LandmarkView, Light, Scene, SceneryInspection, Selection, VillageView, WalkerView } from './render/model';
export { mix, shade } from './render/utils';

export class IslandRenderer extends IslandEffectsPainter {
  private raf = 0;
  private last = 0;

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement) {
    super(canvas, wrap);
    this.readTheme();
    this.bindInteraction();
    this.resize();
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

    // 地块上的东西：建筑、树木与小人进同一个队列，按落地点的深度（i + j）排序后统一绘制，
    // 这样人走到房子或树后面时会被正确挡住。sort 是稳定的，同深度下保持地块原有顺序。
    const queue: { d: number; draw: () => void }[] = [];
    const put = (d: number, draw: () => void) => queue.push({ d, draw });
    const occupied = new Map<number, VillageView>();
    for (const vv of s.villages) occupied.set(vv.slot, vv);
    const lmAt = new Map<number, LandmarkView>();
    for (const l of s.landmarks) lmAt.set(l.index, l);
    for (const t of m.all) {
      const [x, y] = this.iso(t.i, t.j);
      const d = t.i + t.j;
      if (t.type === 'mountain') put(d, () => this.drawMountain(x, y, t, tw));
      if (t === m.lighthouse) {
        put(d, () => {
          this.drawLighthouse(x, y, tw);
          for (const banner of this.lighthouseBannerLayout(s.lighthouseBanners)) {
            this.drawBanner(banner.x, banner.y, tw, banner.title, '#d8c9a7');
          }
        });
      }
      if (t === m.granary) put(d, () => this.drawGranary(x, y, tw, this.shownGranaryRatio(s), s.granaryBusy));
      if (t === m.chores) {
        put(d, () => {
          this.drawHouse(x + hw * 0.2, y - hh * 0.2, tw * 0.3, '#8a8578', '#e3dccb', false, false, !!s.chores.live);
          this.drawWoodpile(x + hw * 0.55, y + hh * 0.22, tw, s.chores.woodpile);
          // 即将开始：扫帚靠在门口；进行中：扫帚动起来
          if (s.chores.live || s.chores.soon) this.drawBroom(x + hw * 0.72, y + hh * 0.12, tw, !!s.chores.live);
        });
      }
      if (t === m.dock) put(d, () => this.drawHarborProps(tw));
      if (t.type === 'plaza' && t.village >= 0) {
        const vv = occupied.get(t.village);
        if (vv) {
          put(d, () => {
            this.drawWell(x, y, tw, vv, t);
            if (vv.agenda) {
              const [ax, ay] = this.villageAgendaAnchor(vv);
              if (this.hasNoticeBoard(vv.agenda)) this.drawNoticeBoard(ax, ay, tw, vv.agenda);
              if (vv.agenda.ended) this.drawUnfiredBricks(x, y, tw, vv.agenda.ended);
              for (const b of this.villageBannerLayout(vv)) this.drawBanner(b.x, b.y, tw, b.title, vv.roof);
            }
          });
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
          // 房屋样式：四坡顶居多，夹几座双坡顶、两层和带披屋的
          const vr = houseHash(vv.projectId, t.slotIdx, 1);
          const variant: HouseVariant = vr < 0.42 ? 0 : vr < 0.72 ? 1 : vr < 0.87 ? 2 : 3;
          put(d, () => {
            this.drawHouse(x, y, tw * HOUSE_SCALE * k, roof, wall, boarded, vv.stage < 2, houseHash(vv.projectId, t.slotIdx, 2) < litFrac, variant);
            if (vv.stage >= 2 && t.slotIdx % 2 === 0) this.drawWeeds(x - hw * 0.4, y + hh * 0.2, tw, t.i * 17 + t.j);
          });
        }
      }
      const lm = t.landmark >= 0 ? lmAt.get(t.landmark) : undefined;
      if (lm) {
        const g = this.grow.get('lm:' + lm.projectId);
        put(d, () => this.drawLandmark(x, y, tw, lm, g ? g.anim : 1, s.selected?.kind === 'project' && s.selected.id === lm.projectId));
        continue;
      }
      for (const tr of t.trees) {
        put(d + tr.dx + tr.dy, () => this.drawTree(x + (tr.dx - tr.dy) * hw, y + (tr.dx + tr.dy) * hh, tw * 0.42 * tr.s, tr.kind, tileHash(t.i, t.j, 70 + Math.round(tr.dx * 100))));
      }
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

    // 小人：和房子同一套比例。手机上保留一个能看清的下限，但不再比屋檐还高。
    const s0 = personSize(tw);
    let selW: [Walker, number, number] | null = null;
    for (const p of this.walkers.values()) {
      const [x, y] = this.iso(p.x, p.y);
      const selected = s.selected?.kind === 'task' && s.selected.id === p.id;
      if (selected) selW = [p, x, y];
      put(p.x + p.y, () => {
        if (selected) {
          c.strokeStyle = this.theme.accent;
          c.lineWidth = 2;
          c.beginPath();
          c.ellipse(x, y, s0 * 0.75, s0 * 0.32, 0, 0, Math.PI * 2);
          c.stroke();
        }
        this.drawPerson(x, y, s0, p, s.light === 'night' ? 0.88 : 1);
      });
    }
    queue.sort((a, b) => a.d - b.d);
    for (const item of queue) item.draw();
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
      c.strokeStyle = isDeterioratingStageCue(cue) ? `rgba(130,130,115,${(1 - k) * 0.5})` : `rgba(225,235,205,${(1 - k) * 0.65})`;
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
