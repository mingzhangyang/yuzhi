import { describe, expect, it } from 'vitest';
import * as palette from '../src/island/render/palette';
import {
  BOARD,
  DECAY_DUST,
  decayRoof,
  decayWall,
  GROUND,
  HOUSE,
  PLASTER,
  rgbOf,
  seasonField,
  seasonGrass,
  SNOW,
  snowBlend,
  withAlpha,
} from '../src/island/render/palette';
import { mix } from '../src/island/render/utils';

const islandSources = import.meta.glob('../src/island/**/*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const HEX = /^#[0-9a-f]{6}$/;
const TRIPLET = /^\d{1,3},\d{1,3},\d{1,3}$/;
const RGBA = /^rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\)$/;

/** 调色板里所有颜色字符串，带路径 */
function paletteStrings(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') out.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, k) => walk(x, `${path}[${k}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [name, v] of Object.entries(palette)) if (typeof v !== 'function') walk(v, name);
  return out;
}

/** 两色之间的 RGB 欧氏距离 */
function dist(a: string, b: string): number {
  const p = rgbOf(a).split(',').map(Number);
  const q = rgbOf(b).split(',').map(Number);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

describe('island palette', () => {
  it('keeps the ten direction-board base colors', () => {
    expect(Object.keys(BOARD)).toHaveLength(10);
    for (const c of Object.values(BOARD)) expect(c).toMatch(HEX);
  });

  it('stores every color in one canonical form', () => {
    const bad = paletteStrings().filter(([, v]) => !HEX.test(v) && !TRIPLET.test(v) && !RGBA.test(v));
    expect(bad).toEqual([]);
  });

  it('interpolates seasonal ground across the season and holds winter still', () => {
    for (let se = 0; se < 3; se++) {
      const [grassFrom, grassTo] = GROUND.grass[se];
      const [fieldFrom, fieldTo] = GROUND.field[se];
      expect(seasonGrass(se, 0)).toBe(grassFrom);
      expect(seasonGrass(se, 1)).toBe(grassTo);
      expect(seasonGrass(se, 0.5)).toBe(mix(grassFrom, grassTo!, 0.5));
      expect(seasonField(se, 0)).toBe(fieldFrom);
      expect(seasonField(se, 1)).toBe(fieldTo);
    }
    expect(seasonGrass(3, 0)).toBe(seasonGrass(3, 1));
    expect(seasonField(3, 0.2)).toBe(GROUND.field[3][0]);
  });

  it('blends snow monotonically and always leaves a little ground showing', () => {
    const grass = seasonGrass(3, 0.5);
    expect(snowBlend(grass, 0, 0.5)).toBe(grass);
    let last = dist(grass, SNOW);
    for (const cover of [0.2, 0.4, 0.6, 0.8, 1]) {
      const d = dist(snowBlend(grass, cover, 0.5), SNOW);
      expect(d).toBeLessThan(last);
      last = d;
    }
    // 最多盖住 92%
    expect(snowBlend(grass, 1, 1)).toBe(mix(grass, SNOW, 0.92));
    expect(snowBlend(grass, 1, 1)).not.toBe(SNOW);
  });

  it('greys village roofs and walls step by step as the stage worsens', () => {
    const roof = '#c8473a';
    expect(DECAY_DUST).toHaveLength(4);
    expect(decayRoof(roof, 0, 0.5)).toBe(roof);
    let last = dist(decayRoof(roof, 0, 0.5), HOUSE.roofDust);
    for (const stage of [1, 2, 3]) {
      const d = dist(decayRoof(roof, stage, 0.5), HOUSE.roofDust);
      expect(d).toBeLessThan(last);
      last = d;
    }
    expect(decayWall(0, false)).toBe(PLASTER.wall);
    expect(decayWall(1, false)).toBe(PLASTER.wall);
    expect(decayWall(2, false)).toBe(PLASTER.wallDusty);
    expect(decayWall(3, false)).toBe(PLASTER.wallDusty);
    expect(decayWall(3, true)).toBe(PLASTER.wallBoarded);
  });

  it('formats alpha colors from palette hex', () => {
    expect(rgbOf('#1e2814')).toBe('30,40,20');
    expect(rgbOf('#fff')).toBe('255,255,255');
    expect(withAlpha('#ffffff', 0.45)).toBe('rgba(255,255,255,0.45)');
    expect(withAlpha(SNOW, 0)).toBe('rgba(243,246,248,0)');
  });
});

/**
 * 原则 7：颜色只从调色板派生。小岛绘制代码里不写新的颜色字面量；
 * 例外只有标记色 MARKER（style.ts，按计划保持独立）、CSS 变量的回退值（viewport.ts）
 * 和 shade() 里的黑白两端（utils.ts）。
 */
describe('island color literals', () => {
  const LITERAL = /'#[0-9a-fA-F]{3,8}'|rgba?\(\s*\d|'\d{1,3},\s*\d{1,3},\s*\d{1,3}'/g;
  const ALLOWED = new Set(['palette.ts', 'viewport.ts', 'utils.ts']);

  it('scans the island sources', () => {
    expect(Object.keys(islandSources).length).toBeGreaterThan(10);
  });

  for (const [path, source] of Object.entries(islandSources)) {
    const file = path.split('/').pop()!;
    if (ALLOWED.has(file)) continue;
    it(`${path.replace('../', '')} draws only palette colors`, () => {
      const code = file === 'style.ts' ? source.replace(/export const MARKER = \{[\s\S]*?\} as const;/, '') : source;
      const hits = code
        .split('\n')
        .flatMap((line, k) => (line.match(LITERAL) ?? []).map((lit) => `${k + 1}: ${lit}`));
      expect(hits).toEqual([]);
    });
  }
});
