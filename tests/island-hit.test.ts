import { describe, expect, it } from 'vitest';
import { IslandInteraction } from '../src/island/render/interaction';
import { cultivationOcclusionOutlines, cultivationOutline } from '../src/island/render/cultivation';
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

  installCultivation(kind: CultivationKind, level: number) {
    const area = { kind, level } as CultivationAreaState;
    const site = this.map.cultivation[kind];
    const [x, y] = this.iso(site.i, site.j);
    const tw = this.view.tw;
    const d = site.i + site.j + 0.08;
    this.occluders = cultivationOcclusionOutlines(area, x, y, tw).map((poly) => ({ d, poly }));
    this.occluders.push({
      d, poly: cultivationOutline(area, x, y, tw),
      hit: { kind: 'cultivation', area: kind }, hitOnly: true,
    });
    return { x, y, tw };
  }

  cultivationTarget(pt: { x: number; y: number }) {
    return this.cultivationHitAt(pt);
  }

  placeWalkerUnderPointer(pt: { x: number; y: number }) {
    const s0 = personSize(this.view.tw);
    const { fi, fj } = this.tileCoords({ x: pt.x, y: pt.y + s0 * 0.7 });
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
