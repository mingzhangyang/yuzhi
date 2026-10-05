import { IslandPropArt } from '../../props';
import type { Glow } from '../model';
import { IslandSimulation } from '../simulation';

/**
 * Shared Canvas primitives and paint-only frame state.
 * No scene synchronization, hit testing, or domain decisions live here.
 */
export abstract class IslandPaintBase extends IslandSimulation {
  protected lights: Glow[] = [];
  protected propArt = new IslandPropArt();
  protected ground = document.createElement('canvas');
  protected groundKey = '';

  protected override onThemeChanged() {
    this.groundKey = '';
  }

  protected poly(fill: string, ...pts: number[]) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) c.lineTo(pts[k], pts[k + 1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  protected rrect(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  protected dot(x: number, y: number, r: number, fill: string) {
    const c = this.ctx;
    c.fillStyle = fill;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  protected shadow(x: number, y: number, rx: number, ry: number, a = 0.15) {
    const c = this.ctx;
    c.fillStyle = `rgba(30,40,20,${a})`;
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
  }

  /** 夜里是否点灯 */

  protected get lit() {
    return this.scene?.light !== 'day' || this.day.night > 0.35;
  }

  /* ---------------- 地面（缓存） ---------------- */

  /** 当季的草地、田地底色 */
}
