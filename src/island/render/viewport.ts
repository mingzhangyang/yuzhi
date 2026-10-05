import { buildIsland, type IslandMap } from '../map';
import type { Hit, Scene } from './model';
import { clamp } from './utils';

export interface RenderView {
  w: number; h: number; dpr: number; zoom: number; panX: number; panY: number; tw: number; ox: number; oy: number;
}

export interface RenderTheme {
  label: string; ink: string; line: string; accent: string; accentInk: string; sea: string; seaDeep: string;
}

/** Canvas 尺寸、视口、主题与等距坐标；不处理场景语义。 */
export abstract class IslandViewport {
  map: IslandMap = buildIsland(0);
  protected ctx: CanvasRenderingContext2D;
  /**
   * 上一帧绘制队列里不透明物体的屏幕轮廓与深度（i + j）。命中判定用它判断小人是否被挡住，
   * 与绘制共用同一份几何，生长动画中的房子、井、树、山都自动一致。
   */
  protected occluders: { d: number; poly: [number, number][]; hit?: Hit }[] = [];
  protected view: RenderView = { w: 0, h: 0, dpr: 1, zoom: 1, panX: 0, panY: 0, tw: 30, ox: 0, oy: 0 };
  protected scene: Scene | null = null;
  protected theme: RenderTheme = { label: '#fff', ink: '#263022', line: '#dfe2d2', accent: '#4f7136', accentInk: '#fff', sea: '#a9d3dc', seaDeep: '#8cc0cc' };
  protected t = 0;
  protected calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(protected canvas: HTMLCanvasElement, protected wrap: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  protected onThemeChanged() {}

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
    this.onThemeChanged();
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

  protected resize() {
    const r = this.wrap.getBoundingClientRect();
    if (!r.width) return;
    const v = this.view;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(r.width * dpr);
    const pixelHeight = Math.round(r.height * dpr);
    const sameGeometry =
      Math.abs(v.w - r.width) < 0.01
      && Math.abs(v.h - r.height) < 0.01
      && v.dpr === dpr
      && this.canvas.width === pixelWidth
      && this.canvas.height === pixelHeight;

    // Mobile browsers can emit window resize events when the software keyboard
    // opens even though the map itself has not changed size. Reassigning the
    // canvas backing store in that case clears it and makes the island visibly
    // jump. Only resize when the observed element geometry (or DPR) changed.
    if (sameGeometry) return;

    v.w = r.width;
    v.h = r.height;
    v.dpr = dpr;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.layout();
  }

  protected layout() {
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

  protected iso(i: number, j: number): [number, number] {
    const v = this.view;
    return [v.ox + ((i - j) * v.tw) / 2, v.oy + ((i + j) * v.tw) / 4];
  }

  protected localPt(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  protected tileCoords(pt: { x: number; y: number }) {
    const v = this.view;
    const u = (pt.x - v.ox) / (v.tw / 2);
    const w = (pt.y - v.oy) / (v.tw / 4);
    return { fi: (u + w) / 2, fj: (w - u) / 2 };
  }

}
