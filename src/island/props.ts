import { PROP_SPRITES, type PropId } from './prop-sprites';

// 构建时带 hash 的 URL：换图后文件名随之变化，不会命中旧缓存
const URLS = import.meta.glob<string>('../assets/island/props/*.webp', {
  query: '?url',
  import: 'default',
  eager: true,
});

function urlOf(id: PropId): string | undefined {
  return URLS[`../assets/island/props/${id}.webp`];
}

/**
 * Lazy runtime loader for generated island prop sprites (one image per prop).
 * Each sprite is fetched on first draw; until it has decoded, draw() is a no-op
 * so procedural Canvas art remains the fallback.
 */
export class IslandPropArt {
  private images = new Map<PropId, HTMLImageElement>();

  private image(id: PropId): HTMLImageElement | null {
    let img = this.images.get(id);
    if (!img) {
      const src = urlOf(id);
      if (!src || typeof Image === 'undefined') return null;
      img = new Image();
      img.decoding = 'async';
      img.src = src;
      this.images.set(id, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** 以 (x, y) 为落地点绘制道具；width 为绘制宽度，高度按原图比例。 */
  draw(ctx: CanvasRenderingContext2D, id: PropId, x: number, y: number, width: number, alpha = 1): boolean {
    const img = this.image(id);
    if (!img) return false;
    const sprite = PROP_SPRITES[id];
    const height = width * (sprite.h / sprite.w);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(img, x - width * sprite.anchorX, y - height * sprite.anchorY, width, height);
    ctx.restore();
    return true;
  }
}
