import { describe, expect, it } from 'vitest';
import { IslandInteraction } from '../src/island/render/interaction';
import { cultivationOcclusionOutlines, cultivationOutline } from '../src/island/render/cultivation';
import { granaryHitOutline, granaryOcclusionOutlines } from '../src/island/render/paint/structures';
import type { CultivationAreaState, CultivationKind } from '../src/logic/cultivation';
import type { Ambience, Scene, Walker } from '../src/island/render/model';
import { personSize } from '../src/island/render/style';

/** 只测试真实 hitAt / walkerHitAt，不需要 Canvas 绘制和 DOM。 */
class HitHarness extends IslandInteraction {
  protected walkers = new Map<string, Walker>();
  protected amb = {} as Ambience;

  constructor() {
    super({ getContext: () => ({}) } as unknown as HTMLCanvasElement, {} as HTMLElement);
    this.view = { w: 600, h: 450, dpr: 1, zoom: 1, panX: 0, panY: 0, tw: 100, ox: 300, oy: 100 };
    this.scene = {
      villages: [], drifting: [], landmarks: [], cultivation: [], lighthouseBanners: [],
      chores: { count: 0, woodpile: 0, later: 0, ended: 0 },
    } as unknown as Scene;
  }

  oldBarnUpperStrip(): { x: number; y: number } {
    const [x, y] = this.iso(this.map.granary.i, this.map.granary.j);
    return { x, y: y - this.view.tw * 0.70 };
  }

  installCultivation(kind: CultivationKind, level: number, snow = false) {
    const area = { kind, level } as CultivationAreaState;
    const site = this.map.cultivation[kind];
    const [x, y] = this.iso(site.i, site.j);
    const tw = this.view.tw;
    const d = site.i + site.j + 0.08;
    this.occluders = cultivationOcclusionOutlines(area, x, y, tw, snow).map((poly) => ({ d, poly }));
    this.occluders.push({
      d, poly: cultivationOutline(area, x, y, tw),
      hit: { kind: 'cultivation', area: kind }, hitOnly: true,
    });
    return { x, y, tw };
  }

  installGranary(ratio: number, busy = false) {
    const site = this.map.granary;
    const [x, y] = this.iso(site.i, site.j);
    const tw = this.view.tw, d = site.i + site.j;
    this.occluders = granaryOcclusionOutlines(x, y, tw, ratio, busy).map((poly) => ({ d, poly }));
    this.occluders.push({ d, poly: granaryHitOutline(x, y, tw), hit: { kind: 'granary' }, hitOnly: true });
    return { x, y, tw };
  }

  cultivationTarget(pt: { x: number; y: number }) {
    return this.cultivationHitAt(pt);
  }

  placeWalkerUnderPointer(pt: { x: number; y: number }, feetY?: number) {
    const s0 = personSize(this.view.tw);
    const { fi, fj } = this.tileCoords({ x: pt.x, y: feetY ?? pt.y + s0 * 0.7 });
    this.walkers.set('visible-walker', { id: 'visible-walker', x: fi, y: fj } as Walker);
  }
}

describe('粮仓旧点击范围不会遮挡可见的小人', () => {
  it('旧矩形上方的空白只用于无小人时的粮仓点击兜底', () => {
    const h = new HitHarness();
    const pt = h.oldBarnUpperStrip();
    // 上方 0.70 格属于旧点击矩形，但已超出新仓房的不透明屋顶。
    expect(h.hitAt(pt)).toEqual({ kind: 'granary' });
    h.placeWalkerUnderPointer(pt);
    expect(h.hitAt(pt)).toEqual({ kind: 'task', id: 'visible-walker' });
  });
});


describe('培育区点击范围与不透明物体分离', () => {
  it('果园低等级仍能点击旧版 0.4 格高的上沿（即使标签未显示）', () => {
    for (const level of [0, 1]) {
      const h = new HitHarness();
      const { x, y, tw } = h.installCultivation('orchard', level);
      const oldTopBand = { x, y: y - tw * 0.39 };
      expect(h.cultivationTarget(oldTopBand)).toEqual({ kind: 'cultivation', area: 'orchard' });
    }
  });

  it('花园拱门旁边的高空白仍能点到可见小人，空白处仍能点花园', () => {
    const h = new HitHarness();
    const { x, y, tw } = h.installCultivation('garden', 4);
    const emptyBesideArch = { x: x + tw * 0.4, y: y - tw * 0.45 };
    expect(h.cultivationTarget(emptyBesideArch)).toEqual({ kind: 'cultivation', area: 'garden' });
    expect(h.hitAt(emptyBesideArch)).toEqual({ kind: 'cultivation', area: 'garden' });
    h.placeWalkerUnderPointer(emptyBesideArch);
    expect(h.hitAt(emptyBesideArch)).toEqual({ kind: 'task', id: 'visible-walker' });
  });

  it('真正站在拱门柱子后面的行人仍会被遮挡', () => {
    const h = new HitHarness();
    const { x, y, tw } = h.installCultivation('garden', 4);
    // 左柱脚在 (-0.148, -0.131)，柱子向上 0.24 格。
    const onArchPost = { x: x - tw * 0.148, y: y - tw * 0.3 };
    h.placeWalkerUnderPointer(onArchPost);
    expect(h.hitAt(onArchPost)).toEqual({ kind: 'cultivation', area: 'garden' });
  });
});


describe('作物、篱笆和粮仓门扇的真实遮挡范围', () => {
  it('4 级农田的外围成熟穗会挡住后方任务；0 级和冬季高处不应误挡', () => {
    for (const level of [3, 4]) {
      const h = new HitHarness();
      const { x, y, tw } = h.installCultivation('field', level);
      const outerEar = { x: x + tw * 0.306, y: y - tw * (level === 4 ? 0.125 : 0.115) };
      h.placeWalkerUnderPointer(outerEar);
      expect(h.hitAt(outerEar)).toEqual({ kind: 'cultivation', area: 'field' });
    }

    for (const [level, snow] of [[0, false], [4, true]] as const) {
      const h = new HitHarness();
      const { x, y, tw } = h.installCultivation('field', level, snow);
      const upperGap = { x: x + tw * 0.306, y: y - tw * 0.125 };
      h.placeWalkerUnderPointer(upperGap);
      expect(h.hitAt(upperGap)).toEqual({ kind: 'task', id: 'visible-walker' });
    }
  });

  it('0 级花园篱笆的后立柱能挡住任务，空隙仍能点到可见行人', () => {
    const h = new HitHarness();
    const { x, y, tw } = h.installCultivation('garden', 0);
    // Back fence post: P(-0.1148, -0.41, 0.06 tw).
    const post = { x: x + tw * 0.1476, y: y - tw * 0.1912 };
    h.placeWalkerUnderPointer(post);
    expect(h.hitAt(post)).toEqual({ kind: 'cultivation', area: 'garden' });

    const gapHarness = new HitHarness();
    const p = gapHarness.installCultivation('garden', 0);
    const gap = { x: p.x + p.tw * 0.37, y: p.y - p.tw * 0.24 };
    gapHarness.placeWalkerUnderPointer(gap);
    expect(gapHarness.hitAt(gap)).toEqual({ kind: 'task', id: 'visible-walker' });
  });

  it('stocked barn door-adjacent empty space allows walker taps; open door actually occludes', () => {
    const stocked = new HitHarness();
    const pos = stocked.installGranary(0.6);
    const doorSide = { x: pos.x + pos.tw * 0.255, y: pos.y - pos.tw * 0.15 };
    expect(stocked.hitAt(doorSide)).toEqual({ kind: 'granary' }); // broad click target
    stocked.placeWalkerUnderPointer(doorSide);
    expect(stocked.hitAt(doorSide)).toEqual({ kind: 'task', id: 'visible-walker' });

    const empty = new HitHarness();
    const p = empty.installGranary(0.1);
    const doorLeaf = { x: p.x + p.tw * 0.255, y: p.y - p.tw * 0.15 };
    empty.placeWalkerUnderPointer(doorLeaf);
    expect(empty.hitAt(doorLeaf)).toEqual({ kind: 'granary' });
  });

  it('only stocked barn sacks occlude; empty doorway has no invisible sacks', () => {
    const stocked = new HitHarness();
    const { x, y, tw } = stocked.installGranary(0.6);
    // First sack at P(-0.11, 0.39): top of the bag in front of the walls.
    const sack = { x: x - tw * 0.25, y: y + tw * 0.025 };
    // Place the walker's feet behind the barn (lower scene depth), while its
    // visible head remains within the tap radius at this sack silhouette.
    // The old test placed the feet in FRONT of the barn, so no occlusion was valid.
    const behindFeetY = sack.y - tw * 0.07;
    stocked.placeWalkerUnderPointer(sack, behindFeetY);
    expect(stocked.hitAt(sack)).toEqual({ kind: 'granary' });

    const empty = new HitHarness();
    empty.installGranary(0.1);
    empty.placeWalkerUnderPointer(sack, behindFeetY);
    expect(empty.hitAt(sack)).toEqual({ kind: 'task', id: 'visible-walker' });
  });
});
