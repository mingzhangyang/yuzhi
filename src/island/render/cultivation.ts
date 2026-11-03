import type { CultivationAreaState } from '../../logic/cultivation';
import { CULTIVATION, withAlpha } from './palette';

function diamond(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  hw: number,
  hh: number,
  fill: string,
  stroke: string,
) {
  c.beginPath();
  c.moveTo(x, y - hh);
  c.lineTo(x + hw, y);
  c.lineTo(x, y + hh);
  c.lineTo(x - hw, y);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = stroke;
  c.lineWidth = Math.max(0.7, hw * 0.03);
  c.stroke();
}

function drawField(c: CanvasRenderingContext2D, x: number, y: number, tw: number, level: number, snow: boolean) {
  diamond(c, x, y, tw * 0.47, tw * 0.24, snow ? CULTIVATION.field.soilSnow : CULTIVATION.field.soil, CULTIVATION.field.edge);
  c.strokeStyle = snow ? CULTIVATION.field.furrowSnow : CULTIVATION.field.furrow;
  c.lineWidth = Math.max(0.7, tw * 0.018);
  for (let r = -2; r <= 2; r++) {
    c.beginPath();
    c.moveTo(x - tw * 0.34 + r * tw * 0.08, y + tw * 0.1);
    c.lineTo(x + tw * 0.2 + r * tw * 0.08, y - tw * 0.1);
    c.stroke();
  }
  if (!level) return;
  for (let k = 0; k < 2 + level * 2; k++) {
    const col = k % 4;
    const row = Math.floor(k / 4);
    const px = x - tw * 0.25 + col * tw * 0.17 + row * tw * 0.02;
    const py = y + tw * 0.09 - col * tw * 0.035 + row * tw * 0.07;
    const h = tw * (0.06 + level * 0.025);
    c.strokeStyle = snow ? (level >= 4 ? CULTIVATION.field.stalkRipeSnow : CULTIVATION.field.stalkSnow) : level >= 4 ? CULTIVATION.field.stalkRipe : CULTIVATION.field.stalk;
    c.lineWidth = Math.max(1, tw * 0.025);
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px, py - h);
    c.stroke();
    if (level >= 2) {
      c.fillStyle = snow ? (level >= 4 ? CULTIVATION.field.earRipeSnow : CULTIVATION.field.earSnow) : level >= 4 ? CULTIVATION.field.earRipe : CULTIVATION.field.ear;
      c.beginPath();
      c.ellipse(px + tw * 0.025, py - h * 0.72, tw * 0.025, tw * 0.012, -0.5, 0, Math.PI * 2);
      c.fill();
    }
  }
}

function drawOrchard(c: CanvasRenderingContext2D, x: number, y: number, tw: number, level: number, snow: boolean) {
  diamond(c, x, y, tw * 0.46, tw * 0.23, snow ? CULTIVATION.orchard.grassSnow : CULTIVATION.orchard.grass, CULTIVATION.orchard.edge);
  const count = Math.max(1, Math.min(5, level + 1));
  for (let k = 0; k < count; k++) {
    const ox = (k % 3 - 1) * tw * 0.22 + (k > 2 ? tw * 0.1 : 0);
    const oy = (Math.floor(k / 3) - 0.25) * tw * 0.12 + (k % 3) * tw * 0.035;
    const h = tw * (0.18 + level * 0.025);
    c.fillStyle = CULTIVATION.orchard.trunk;
    c.fillRect(x + ox - tw * 0.018, y + oy - h * 0.55, tw * 0.036, h * 0.55);
    c.fillStyle = level === 0 || snow ? CULTIVATION.orchard.crownBare : CULTIVATION.orchard.crown;
    c.beginPath();
    c.arc(x + ox, y + oy - h * 0.68, tw * (0.08 + level * 0.012), 0, Math.PI * 2);
    c.fill();
    if (level >= 3 && !snow) {
      c.fillStyle = level === 3 ? CULTIVATION.orchard.blossom : CULTIVATION.orchard.fruit;
      for (let f = 0; f < level - 1; f++) {
        c.beginPath();
        c.arc(x + ox + (f - 1) * tw * 0.035, y + oy - h * 0.68 + (f % 2) * tw * 0.025, tw * 0.014, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}

function drawPond(c: CanvasRenderingContext2D, x: number, y: number, tw: number, level: number, t: number, frozen: boolean) {
  c.fillStyle = frozen ? CULTIVATION.pond.ice : CULTIVATION.pond.water;
  c.strokeStyle = CULTIVATION.pond.bank;
  c.lineWidth = Math.max(0.8, tw * 0.025);
  c.beginPath();
  c.ellipse(x, y, tw * 0.48, tw * 0.22, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  if (level >= 1) {
    c.strokeStyle = frozen ? withAlpha(CULTIVATION.pond.crack, 0.55) : withAlpha(CULTIVATION.pond.ripple, 0.6);
    for (let k = 0; k < Math.min(3, level); k++) {
      const ph = frozen ? 0.35 + k * 0.12 : (t * 0.2 + k * 0.31) % 1;
      c.beginPath();
      c.ellipse(x + (k - 1) * tw * 0.15, y - tw * 0.02, tw * (0.03 + ph * 0.06), tw * (0.012 + ph * 0.025), 0, 0, Math.PI * 2);
      c.stroke();
    }
  }
  if (level >= 2) {
    c.strokeStyle = frozen ? CULTIVATION.pond.reedSnow : CULTIVATION.pond.reed;
    c.lineWidth = Math.max(1, tw * 0.02);
    for (let k = 0; k < level; k++) {
      const px = x - tw * 0.38 + k * tw * 0.11;
      c.beginPath();
      c.moveTo(px, y + tw * 0.12);
      c.lineTo(px + tw * 0.02, y + tw * 0.025);
      c.stroke();
    }
  }
  if (level >= 3) {
    c.strokeStyle = frozen ? CULTIVATION.pond.fishIce : CULTIVATION.pond.fish;
    c.lineWidth = Math.max(1, tw * 0.018);
    for (let k = 0; k < level - 1; k++) {
      const px = x - tw * 0.17 + k * tw * 0.13;
      const py = frozen ? y + (k % 2 ? tw * 0.018 : -tw * 0.018) : y + Math.sin(t * 1.2 + k) * tw * 0.025;
      c.beginPath();
      c.arc(px, py, tw * 0.04, 0.25, Math.PI - 0.25);
      c.stroke();
      c.beginPath();
      c.moveTo(px + tw * 0.038, py);
      c.lineTo(px + tw * 0.07, py - tw * 0.025);
      c.moveTo(px + tw * 0.038, py);
      c.lineTo(px + tw * 0.07, py + tw * 0.025);
      c.stroke();
    }
  }
}

function drawGarden(c: CanvasRenderingContext2D, x: number, y: number, tw: number, level: number, snow: boolean) {
  diamond(c, x, y, tw * 0.45, tw * 0.23, snow ? CULTIVATION.garden.grassSnow : CULTIVATION.garden.grass, CULTIVATION.garden.edge);
  const count = Math.max(2, 2 + level * 2);
  const palette = CULTIVATION.garden.petals;
  for (let k = 0; k < count; k++) {
    const col = k % 4;
    const row = Math.floor(k / 4);
    const px = x - tw * 0.25 + col * tw * 0.16 + row * tw * 0.02;
    const py = y + tw * 0.08 - col * tw * 0.035 + row * tw * 0.08;
    c.strokeStyle = CULTIVATION.garden.stem;
    c.lineWidth = Math.max(0.8, tw * 0.018);
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px, py - tw * (0.04 + level * 0.012));
    c.stroke();
    if (!level || snow) continue;
    c.fillStyle = palette[k % palette.length];
    const rr = tw * (0.018 + level * 0.003);
    for (let p = 0; p < 4; p++) {
      const angle = (Math.PI * 2 * p) / 4;
      c.beginPath();
      c.arc(px + Math.cos(angle) * rr, py - tw * 0.06 + Math.sin(angle) * rr, rr * 0.72, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = CULTIVATION.garden.heart;
    c.beginPath();
    c.arc(px, py - tw * 0.06, rr * 0.45, 0, Math.PI * 2);
    c.fill();
  }
}

export function drawCultivationArea(
  c: CanvasRenderingContext2D,
  area: CultivationAreaState,
  x: number,
  y: number,
  tw: number,
  cover: number,
  t: number,
) {
  c.save();
  const snow = cover > 0.6;
  if (area.kind === 'field') drawField(c, x, y, tw, area.level, snow);
  else if (area.kind === 'orchard') drawOrchard(c, x, y, tw, area.level, snow);
  else if (area.kind === 'pond') drawPond(c, x, y, tw, area.level, t, snow);
  else drawGarden(c, x, y, tw, area.level, snow);
  c.restore();
}


/**
 * Conservative opaque footprint for walker hit occlusion.
 * Orchard needs extra height for tree canopies; the other areas stay near the tile.
 */
export function cultivationOutline(
  area: CultivationAreaState,
  x: number,
  y: number,
  tw: number,
): [number, number][] {
  const half = area.kind === 'pond' ? 0.49 : 0.47;
  const above = area.kind === 'orchard' ? 0.4 : area.kind === 'pond' ? 0.23 : 0.26;
  const below = area.kind === 'pond' ? 0.23 : 0.24;
  return [
    [x - tw * half, y + tw * below],
    [x + tw * half, y + tw * below],
    [x + tw * half, y - tw * above],
    [x - tw * half, y - tw * above],
  ];
}
