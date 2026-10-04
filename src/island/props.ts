interface PropAtlasDef {
  src: string;
  width: number;
  height: number;
}

interface PropSpriteDef {
  atlas: string;
  x: number;
  y: number;
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
}

interface PropManifest {
  atlases: Record<string, PropAtlasDef>;
  sprites: Record<string, PropSpriteDef>;
}

/**
 * Lazy runtime loader for generated island prop atlases.
 * Rendering is a no-op until the manifest and requested atlas have loaded,
 * so procedural Canvas art remains the fallback.
 */
export class IslandPropArt {
  private manifest: PropManifest | null = null;
  private images = new Map<string, HTMLImageElement>();

  constructor() {
    if (typeof window !== 'undefined') void this.loadManifest();
  }

  private async loadManifest() {
    try {
      const res = await fetch('/assets/island/props/manifest.json', { cache: 'force-cache' });
      if (!res.ok) return;
      this.manifest = (await res.json()) as PropManifest;
    } catch {
      // Generated art is optional enrichment; keep procedural rendering intact.
    }
  }

  private image(atlasId: string, src: string): HTMLImageElement | null {
    let img = this.images.get(atlasId);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = src;
      this.images.set(atlasId, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  draw(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, width: number, alpha = 1): boolean {
    const manifest = this.manifest;
    const sprite = manifest?.sprites[id];
    if (!manifest || !sprite) return false;
    const atlas = manifest.atlases[sprite.atlas];
    if (!atlas) return false;
    const img = this.image(sprite.atlas, atlas.src);
    if (!img) return false;

    const height = width * (sprite.h / sprite.w);
    const dx = x - width * sprite.anchorX;
    const dy = y - height * sprite.anchorY;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(img, sprite.x, sprite.y, sprite.w, sprite.h, dx, dy, width, height);
    ctx.restore();
    return true;
  }
}
