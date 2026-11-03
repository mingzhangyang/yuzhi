export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function hash(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return (h >>> 0) / 4294967296;
}

function hx(c: string): number[] {
  c = c.trim();
  // getComputedStyle 读出的 CSS 变量可能是简写（#fff）
  if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/** 感知亮度 0–255。 */
export function luma(c: string): number {
  const [r, g, b] = hx(c);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/**
 * 混色结果的缓存：绘制时同一组（颜色、颜色、比例）每帧要算上百次（屋顶的明暗面、瓦线、墙角柱……），
 * 解析两段十六进制再拼回字符串比查表贵得多。键里的颜色和比例都来自调色板与少数几个连续量，
 * 条目数有上限，超过就整表清掉重来。
 */
const mixCache = new Map<string, string>();
const MIX_CACHE_MAX = 8192;

export function mix(a: string, b: string, t: number): string {
  const key = a + b + t;
  let out = mixCache.get(key);
  if (out !== undefined) return out;
  const A = hx(a);
  const B = hx(b);
  out = '#' + A.map((v, k) => clamp(Math.round(v + (B[k] - v) * t), 0, 255).toString(16).padStart(2, '0')).join('');
  if (mixCache.size >= MIX_CACHE_MAX) mixCache.clear();
  mixCache.set(key, out);
  return out;
}

export function shade(c: string, t: number): string {
  return t > 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);
}

export const rgb = (c: number[]) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
