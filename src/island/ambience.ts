/**
 * 小岛的「天时」：由现实的日期和时刻推出光线、季节进度、天气、月相和节日。
 * 全是纯函数，不碰 DOM；同一天得到的天气和节日总是一样的。
 */
import type { ISODate } from '../types';

export type Festival = 'newyear' | 'chunjie' | 'yuanxiao' | 'duanwu' | 'zhongqiu' | 'guoqing' | 'christmas';
export type Weather = 'clear' | 'cloudy' | 'rain' | 'snow';

export const FESTIVAL_NAMES: Record<Festival, string> = {
  newyear: '元旦',
  chunjie: '春节',
  yuanxiao: '元宵',
  duanwu: '端午',
  zhongqiu: '中秋',
  guoqing: '国庆',
  christmas: '圣诞',
};

/** 农历节日的公历日期（正月初一、五月初五、八月十五） */
const LUNAR: Record<number, [string, string, string]> = {
  2024: ['02-10', '06-10', '09-17'],
  2025: ['01-29', '05-31', '10-06'],
  2026: ['02-17', '06-19', '09-25'],
  2027: ['02-06', '06-09', '09-15'],
  2028: ['01-26', '05-28', '10-03'],
  2029: ['02-13', '06-16', '09-22'],
  2030: ['02-03', '06-05', '09-12'],
};

const DAY = 86400000;
const utc = (d: ISODate) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};
/** a − b 的天数 */
const daysBetween = (a: ISODate, b: ISODate) => Math.round((utc(a) - utc(b)) / DAY);

/** 某一天正在过的节日（可能同时有两个，比如中秋碰上国庆） */
export function festivalsOf(d: ISODate): Festival[] {
  const [y, m, day] = d.split('-').map(Number);
  const out: Festival[] = [];
  if ((m === 1 && day === 1) || (m === 12 && day === 31)) out.push('newyear');
  if (m === 10 && day <= 7) out.push('guoqing');
  if (m === 12 && (day === 24 || day === 25)) out.push('christmas');
  // 春节可能落在上一年的农历表里（除夕在 1 月）
  for (const yy of [y, y + 1]) {
    const row = LUNAR[yy];
    if (!row) continue;
    const cny = `${yy}-${row[0]}`;
    const k = daysBetween(d, cny);
    if (k >= -1 && k <= 6) out.push('chunjie');
    if (k === 14) out.push('yuanxiao');
    if (yy === y) {
      if (daysBetween(d, `${yy}-${row[1]}`) === 0) out.push('duanwu');
      if (Math.abs(daysBetween(d, `${yy}-${row[2]}`)) <= 1) out.push('zhongqiu');
    }
  }
  return out;
}

/** 当季已过去多少（0–1）：3 月 1 日是春的 0，5 月 31 日接近 1 */
export function seasonProgress(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number);
  const startMonth = m >= 3 && m <= 5 ? 3 : m >= 6 && m <= 8 ? 6 : m >= 9 && m <= 11 ? 9 : 12;
  const sy = m < 3 ? y - 1 : y;
  const start = Date.UTC(sy, startMonth - 1, 1);
  const end = Date.UTC(sy, startMonth - 1 + 3, 1);
  return Math.min(1, Math.max(0, (Date.UTC(y, m - 1, day) - start) / (end - start)));
}

/** 冬天地上积雪的厚度（0–1）：初冬薄，一月最厚，二月末化开；其余季节为 0 */
export function snowCover(season: number, progress: number, weather: Weather): number {
  if (season !== 3) return 0;
  const p = Math.min(1, Math.max(0, progress));
  // 初冬已有一层薄雪；隆冬最厚；基础积雪在季末严格归零。
  // 4p(1-p) 是两端为 0 的隆冬隆起项，(1-p) 则保留初冬的薄雪。
  const base = 0.35 * (1 - p) + 0.8 * 4 * p * (1 - p);
  return Math.min(1, base + (weather === 'snow' ? 0.25 : 0));
}

function dayHash(d: ISODate, salt: number): number {
  let h = salt * 2654435761;
  for (let k = 0; k < d.length; k++) h = Math.imul(h ^ d.charCodeAt(k), 2246822519);
  h ^= h >>> 15;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** 当天的天气：由日期决定，一整天不变。节日里总是晴天 */
export function weatherOf(d: ISODate, season: number): Weather {
  if (festivalsOf(d).length) return 'clear';
  const r = dayHash(d, 7);
  const [rain, cloudy] = [
    [0.18, 0.2],
    [0.14, 0.16],
    [0.1, 0.24],
    [0.26, 0.2],
  ][season];
  if (r < rain) return season === 3 ? 'snow' : 'rain';
  if (r < rain + cloudy) return 'cloudy';
  return 'clear';
}

/** 月相（0 新月，0.5 满月），以 2000-01-06 18:14 UTC 的新月为基准 */
export function moonPhase(at: Date): number {
  const days = (at.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / DAY;
  const p = (days / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}

export interface DayLight {
  /** 叠加在画面上的环境光（multiply），白色表示不改变 */
  tint: [number, number, number];
  /** 0 白天 – 1 深夜 */
  night: number;
  /** 0–1，日出日落时暖色的强度 */
  warm: number;
}

type Key = [number, [number, number, number], number, number];

/**
 * 一天里的光线。日出日落随季节前后移动：夏天天亮得早、黑得晚，冬天反过来。
 * hour 为本地时间的小时（可带小数）。
 */
export function dayLight(hour: number, season: number): DayLight {
  const shift = [0, 0.6, 0, -0.6][season];
  const keys: Key[] = [
    [0, [92, 104, 158], 1, 0],
    [5 - shift, [92, 104, 158], 1, 0],
    [6 - shift, [236, 190, 196], 0.35, 1],
    [7.4 - shift, [255, 244, 232], 0, 0.3],
    [9, [255, 255, 255], 0, 0],
    [16 + shift, [255, 255, 255], 0, 0],
    [17.4 + shift, [255, 226, 186], 0, 0.7],
    [18.6 + shift, [226, 150, 140], 0.3, 1],
    [19.8 + shift, [128, 120, 170], 0.75, 0.3],
    [21, [92, 104, 158], 1, 0],
    [24, [92, 104, 158], 1, 0],
  ];
  const h = ((hour % 24) + 24) % 24;
  let k = 0;
  while (k < keys.length - 2 && keys[k + 1][0] <= h) k++;
  const [h0, c0, n0, w0] = keys[k];
  const [h1, c1, n1, w1] = keys[k + 1];
  const f = h1 > h0 ? Math.min(1, Math.max(0, (h - h0) / (h1 - h0))) : 0;
  const s = f * f * (3 - 2 * f);
  const lerp = (a: number, b: number) => a + (b - a) * s;
  return { tint: [lerp(c0[0], c1[0]), lerp(c0[1], c1[1]), lerp(c0[2], c1[2])], night: lerp(n0, n1), warm: lerp(w0, w1) };
}
