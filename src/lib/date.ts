import type { ISODate } from '../types';
import { formatCalendarDay, formatFullDate, formatWeekday, t } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

/** 某个时刻在用户本地时区的日期 */
export function localDate(d: Date = new Date()): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 用户可以选的日期范围；超出的多半是输错了（例如逐位输入年份时停在 0002 年）。 */
export const MIN_PICK_DATE: ISODate = '1900-01-01';
export const MAX_PICK_DATE: ISODate = '2999-12-31';

/** 合法的 YYYY-MM-DD，真实存在的一天，并且在可选范围内 */
export function isPlausibleDate(d: unknown): d is ISODate {
  if (typeof d !== 'string') return false;
  const m = YMD.exec(d);
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(2000, mo - 1, day));
  t.setUTCFullYear(y);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== day) return false;
  return d >= MIN_PICK_DATE && d <= MAX_PICK_DATE;
}

/** ISO 时间戳 → 本地日期 */
export function dateOfStamp(stamp: string): ISODate {
  return localDate(new Date(stamp));
}

function parts(d: ISODate): [number, number, number] {
  const [y, m, day] = d.split('-').map(Number);
  return [y, m, day];
}

/** 用 UTC 计算日期加减，避免夏令时干扰 */
export function addDays(d: ISODate, n: number): ISODate {
  const [y, m, day] = parts(d);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** b − a 的天数 */
export function diffDays(a: ISODate, b: ISODate): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** 闭区间 [a, b] 内的每一天 */
export function eachDay(a: ISODate, b: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 本地日期在当天 00:00 的时刻 */
export function startOfLocalDay(d: ISODate): Date {
  const [y, m, day] = parts(d);
  return new Date(y, m - 1, day);
}

export const SEASONS = ['春', '夏', '秋', '冬'] as const;

/** 北半球季节：3–5 春，6–8 夏，9–11 秋，12–2 冬 */
export function seasonOf(d: ISODate): 0 | 1 | 2 | 3 {
  const m = parts(d)[1];
  if (m >= 3 && m <= 5) return 0;
  if (m >= 6 && m <= 8) return 1;
  if (m >= 9 && m <= 11) return 2;
  return 3;
}

export function weekday(d: ISODate): string {
  return formatWeekday(d);
}

/** 10月3日 */
export function fmtDay(d: ISODate): string {
  return formatCalendarDay(d);
}

/** 和今天同一年时是「10月3日」，否则带上年份，避免不同年份的日子看起来一样 */
export function fmtDayFrom(d: ISODate, today: ISODate): string {
  return d.slice(0, 4) === today.slice(0, 4) ? formatCalendarDay(d) : formatFullDate(d);
}

/** 相对今天的说法：今天、昨天、明天、10月3日 */
export function relDay(d: ISODate, today: ISODate): string {
  const n = diffDays(today, d);
  if (n === 0) return t('date.today');
  if (n === -1) return t('date.yesterday');
  if (n === 1) return t('date.tomorrow');
  if (n === -2) return t('date.dayBeforeYesterday');
  if (n === 2) return t('date.dayAfterTomorrow');
  return fmtDayFrom(d, today);
}

/** "09:30" → 分钟数 */
export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
