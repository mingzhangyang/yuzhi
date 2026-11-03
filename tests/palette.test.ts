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
 * 原则 7：绘制颜色只能从调色板派生。豁免仅限 MARKER 对象、
 * 已审核的 viewport 主题默认值/CSS 回退表达式，以及 shade() 两个端点。
 */
const COLOR_LITERAL = /(['"`])(?:#[0-9a-fA-F]{3,8}|\d{1,3},\s*\d{1,3},\s*\d{1,3})\1|\brgba?\(\s*\d/gi;

function unapprovedColors(path: string, source: string): string[] {
  if (path.endsWith('/render/palette.ts')) return [];
  let code = source;
  if (path.endsWith('/render/style.ts')) {
    code = code.replace(/export const MARKER = \{[\s\S]*?\} as const;/, '');
  }
  if (path.endsWith('/render/viewport.ts')) {
    // Exact existing fallbacks, not whole-file exemptions. New literals still fail.
    const allowed = [
      "protected theme: RenderTheme = { label: '#fff', ink: '#263022', line: '#dfe2d2', accent: '#4f7136', accentInk: '#fff', sea: '#a9d3dc', seaDeep: '#8cc0cc' };",
      "label: g('--label', '#fff')",
      "ink: g('--ink', '#263022')",
      "line: g('--line', '#dfe2d2')",
      "accent: g('--accent', '#4f7136')",
      "accentInk: g('--accent-ink', '#fff')",
      "sea: g('--sea', '#a9d3dc')",
      "seaDeep: g('--sea-deep', '#8cc0cc')",
    ];
    for (const expr of allowed) {
      code = code.replace(expr, expr.replace(/(['"`])#[0-9a-fA-F]{3,8}\1/g, "'approved'"));
    }
  }
  if (path.endsWith('/render/utils.ts')) {
    code = code.replace(
      "return t > 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);",
      'return t > 0 ? mix(c, white, t) : mix(c, black, -t);',
    );
  }
  return code.split('\n').flatMap((line, i) =>
    (line.match(COLOR_LITERAL) ?? []).map((lit) => String(i + 1) + ': ' + lit));
}

describe('island color literals', () => {
  it('scans the island sources', () => {
    expect(Object.keys(islandSources).length).toBeGreaterThan(10);
  });

  it('recognizes single, double, and backtick hex and RGB literals', () => {
    const sample = [
      "const a = '#fff';",
      'const b = "#123456";',
      'const c = `#abcdef80`;',
      "const d = '12,34,56';",
      'const e = rgba(1, 2, 3, 0.5);',
    ].join('\n');
    expect(unapprovedColors('src/island/render/paint/terrain.ts', sample)).toHaveLength(5);
  });

  it('allows only reviewed fallback expressions, not extra viewport colors', () => {
    const viewport = "label: g('--label', '#fff');\nconst stray = \"#abcdef\";";
    expect(unapprovedColors('src/island/render/viewport.ts', viewport)).toEqual(['2: "#abcdef"']);
    expect(unapprovedColors('src/island/render/utils.ts', "const stray = '#fff';")).toHaveLength(1);
    expect(unapprovedColors('src/island/render/utils.ts',
      "return t > 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);")).toEqual([]);
  });

  for (const [path, source] of Object.entries(islandSources)) {
    if (path.endsWith('/render/palette.ts')) continue;
    it(path.replace('../', '') + ' draws only palette colors', () => {
      expect(unapprovedColors(path, source)).toEqual([]);
    });
  }
});
