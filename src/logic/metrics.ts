import type { CalendarEvent, Data, ISODate, SettlementEntry } from '../types';
import { addDays, hmToMinutes, startOfLocalDay } from '../lib/date';
import { NO_ENERGY_CUT, NO_ENERGY_FLOOR, PARTIAL_WEIGHT } from './config';

const inLast7 = (d: ISODate, today: ISODate) => d > addDays(today, -7) && d <= today;

export interface Granary {
  /** 工作时段总长（小时） */
  workHours: number;
  /** 日历在工作时段内已排的时间（小时） */
  scheduledHours: number;
  /** 近 7 天「没精力」次数 */
  noEnergy: number;
  /** 精力系数 */
  factor: number;
  /** 今天还能用的时间（小时） */
  available: number;
}

/** 合并后的区间总长，避免重叠事件重复计算 */
function unionMinutes(ranges: [number, number][]): number {
  const rs = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const r of rs) {
    if (!cur || r[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [r[0], r[1]];
    } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** 粮仓：今天的可用时间 = 工作时段 − 日历上已排的时间，再按近 7 天的「没精力」下调 */
export function granary(data: Data, today: ISODate): Granary {
  const ws = hmToMinutes(data.settings.workStart);
  const we = Math.max(ws, hmToMinutes(data.settings.workEnd));
  const day0 = startOfLocalDay(today).getTime();
  const ranges: [number, number][] = [];
  for (const e of data.events as CalendarEvent[]) {
    if (e.allDay) continue;
    const s = (new Date(e.start).getTime() - day0) / 60000;
    const en = (new Date(e.end).getTime() - day0) / 60000;
    const a = Math.max(ws, s);
    const b = Math.min(we, en);
    if (b > a) ranges.push([a, b]);
  }
  const workHours = (we - ws) / 60;
  const scheduledHours = unionMinutes(ranges) / 60;
  const noEnergy = data.entries.filter((e) => e.reason === 'no_energy' && inLast7(e.date, today)).length;
  const factor = Math.max(NO_ENERGY_FLOOR, 1 - NO_ENERGY_CUT * noEnergy);
  return { workHours, scheduledHours, noEnergy, factor, available: Math.max(0, (workHours - scheduledHours) * factor) };
}

export const progressWeight = (e: SettlementEntry) => (e.outcome === 'done' ? 1 : e.outcome === 'partial' ? PARTIAL_WEIGHT : 0);

/** 推进度：近 7 天确认做了的条目数（做了一部分按权重计），以及每日走势 */
export function progress(data: Data, today: ISODate, days = 14): { week: number; series: number[] } {
  const perDay = new Map<ISODate, number>();
  let week = 0;
  for (const e of data.entries) {
    const w = progressWeight(e);
    if (!w) continue;
    perDay.set(e.date, (perDay.get(e.date) ?? 0) + w);
    if (inLast7(e.date, today)) week += w;
  }
  const series: number[] = [];
  for (let k = days - 1; k >= 0; k--) series.push(perDay.get(addDays(today, -k)) ?? 0);
  return { week, series };
}

/** 积压：码头上未安排的任务数 + 已过期未完成的任务数 */
export function backlog(data: Data, today: ISODate): { dock: number; overdue: number; total: number } {
  let dock = 0;
  let overdue = 0;
  for (const t of data.tasks) {
    if (t.status !== 'open') continue;
    if (!t.projectId) dock++;
    else if (t.scheduledFor && t.scheduledFor < today) overdue++;
  }
  return { dock, overdue, total: dock + overdue };
}

/** 积压的历史走势：用任务的创建与结束日期回推 */
export function backlogSeries(data: Data, today: ISODate, days = 14): number[] {
  const out: number[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = addDays(today, -k);
    let n = 0;
    for (const t of data.tasks) {
      if (t.createdAt > d) continue;
      if (t.closedAt && t.closedAt <= d) continue;
      if (!t.projectId || (t.scheduledFor && t.scheduledFor < d)) n++;
    }
    out.push(n);
  }
  return out;
}

/** 状态：近 7 天已结算条目中「做了」和「做了一部分」的占比 */
export function condition(data: Data, today: ISODate): { ratio: number | null; settled: number; good: number } {
  let settled = 0;
  let good = 0;
  for (const e of data.entries) {
    if (!inLast7(e.date, today)) continue;
    settled++;
    if (e.outcome !== 'skipped') good++;
  }
  return { ratio: settled ? good / settled : null, settled, good };
}

export function conditionSeries(data: Data, today: ISODate, days = 14): number[] {
  const out: number[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const c = condition(data, addDays(today, -k));
    out.push(c.ratio == null ? 0 : Math.round(c.ratio * 100));
  }
  return out;
}
