import { describe, expect, it } from 'vitest';
import { IslandInteraction } from '../src/island/render/interaction';
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
