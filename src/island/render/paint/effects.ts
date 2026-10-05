import { moonPhase } from '../../ambience';
import type { Scene, Walker } from '../model';
import { SNOW } from '../style';
import { clamp, hash, rgb, shade } from '../utils';
import { IslandStructurePainter } from './structures';

/** People, selection overlays, sky/weather effects, lighting, and labels. */
export abstract class IslandEffectsPainter extends IslandStructurePainter {
  protected drawPerson(x: number, y: number, s: number, p: Walker, dim: number) {
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

  protected drawFocus() {
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

  protected drawCloudShadows() {
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

  protected drawBirds() {
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

  protected drawDrifts() {
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

  protected drawMoon(s: Scene) {
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

  protected drawStars() {
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

  protected drawFireflies() {
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

  protected drawSkyLanterns() {
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

  protected drawSparks() {
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

  protected drawAmbient() {
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

  protected drawLights() {
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

  protected label(x: number, y: number, txt: string, dot: string | null, hl: boolean, muted = false) {
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
}
