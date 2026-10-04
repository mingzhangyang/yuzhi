import type { CalendarEvent, Data, ISODate } from '../types';
import { CHORES } from '../types';
import { AGENDA_SOON_MINUTES, BANNERS_MAX, WOODPILE_STEPS } from './config';
import { dateOfStamp, localDate } from '../lib/date';
import { unclassifiedGroups } from './classify';

/** 项目 id，或表示杂务的 CHORES。 */
export interface AgendaSlot {
  target: string;
  live: { eventId: string; title: string; end: string }[];
  soon: { eventId: string; title: string; start: string }[];
  later: number;
  ended: number;
  /** 完整列表；Canvas 层只绘制前 BANNERS_MAX 条。 */
  banners: string[];
}

export interface Agenda {
  slots: Map<string, AgendaSlot>;
  /** 未归类事件组标题；「已捞起」由 UI 层过滤。 */
  drifting: string[];
  /** 杂务和未归类的全天事件完整标题列表。 */
  lighthouseBanners: string[];
  /** 今天处于区间内的全部全天事件标题。 */
  allDay: string[];
  /** 下一个会改变此刻层的时间边界。 */
  nextChange: Date | null;
  /** 今天结算为「做了 / 做了一部分」的日程数，按项目或 CHORES 分组；只给转场层判断烧窑用。 */
  fired: Map<string, number>;
}

type EventWithTime = { event: CalendarEvent; start: number; end: number; day: ISODate };

const titleOf = (event: CalendarEvent) => event.title.trim() || '未命名日程';

function validTime(event: CalendarEvent): EventWithTime | null {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { event, start, end, day: dateOfStamp(event.start) };
}

function isActiveProject(data: Data, projectId: string): boolean {
  return data.projects.some((p) => p.id === projectId && p.status === 'active');
}

/**
 * 已归类的日程才可以进入项目村落或杂务小屋。
 * 未归类事件即使残留了旧 projectId，也不会被此刻层误投到村落。
 */
function targetOf(data: Data, event: CalendarEvent): string | null {
  if (!event.classified || !event.projectId) return null;
  if (event.projectId === CHORES) return CHORES;
  return isActiveProject(data, event.projectId) ? event.projectId : null;
}

function emptySlot(target: string): AgendaSlot {
  return { target, live: [], soon: [], later: 0, ended: 0, banners: [] };
}

function isSettled(settled: Set<string>, event: CalendarEvent): boolean {
  return settled.has(event.id);
}

function allDayActive(item: EventWithTime, today: ISODate): boolean {
  // ICS all-day events are normalized to local-midnight intervals. Using the
  // half-open interval keeps the final day from leaking into the next day.
  const startDay = dateOfStamp(item.event.start);
  const endDay = dateOfStamp(item.event.end);
  return startDay <= today && today < endDay;
}

function nextChangeOf(items: EventWithTime[], nowMs: number, today: ISODate): Date | null {
  const changes: number[] = [];
  const soonMs = AGENDA_SOON_MINUTES * 60_000;
  for (const item of items) {
    for (const at of item.event.allDay ? [item.start, item.end] : [item.start - soonMs, item.start, item.end]) {
      if (at > nowMs) changes.push(at);
    }
  }
  // Even an empty calendar changes the meaning of "today" at local midnight;
  // include that boundary so drift groups and all-day banners refresh exactly.
  const [y, m, d] = today.split('-').map(Number);
  const midnight = new Date(y, m - 1, d + 1).getTime();
  if (midnight > nowMs) changes.push(midnight);
  const at = Math.min(...changes);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * 漂流瓶的范围：今天及以后的未归类组，加上过去还在等结算的日子里的。
 * 已经结算或已经归档为「未记录」的日子由海雾和归档负责，不再占瓶子位。
 */
function driftingTitles(data: Data, today: ISODate, settled: Set<string>): string[] {
  const recorded = new Set(data.days.map((day) => day.date));
  return unclassifiedGroups(data.events)
    .filter((group) => group.events.some((event) => {
      const day = dateOfStamp(event.start);
      return day >= today || (!settled.has(event.id) && !recorded.has(day));
    }))
    .map((group) => group.title);
}

/**
 * 从当前时间和日历事实推出「此刻层」。本函数只读输入，绝不写入数据，
 * 也不 import action；结算后的砖、阶段和衰败仍由原有事实回放决定。
 */
export function agendaAt(data: Data, now: Date): Agenda {
  const today = localDate(now);
  const nowMs = now.getTime();
  const soonMs = nowMs + AGENDA_SOON_MINUTES * 60_000;
  const settled = new Set(data.entries.filter((entry) => entry.itemType === 'event').map((entry) => entry.itemId));
  const slots = new Map<string, AgendaSlot>();
  const lighthouseBanners: string[] = [];
  const allDay: string[] = [];
  const items = data.events.map(validTime).filter((item): item is EventWithTime => !!item);

  for (const item of items) {
    const event = item.event;
    if (event.allDay) {
      if (!allDayActive(item, today)) continue;
      const title = titleOf(event);
      allDay.push(title);
      const target = targetOf(data, event);
      if (target && target !== CHORES) {
        const slot = slots.get(target) ?? emptySlot(target);
        slot.banners.push(title);
        slots.set(target, slot);
      } else {
        lighthouseBanners.push(title);
      }
      continue;
    }

    // A confirmed entry is already a consequence-layer fact. It must not
    // continue to look like an unconfirmed live/ended agenda item.
    if (isSettled(settled, event)) continue;
    const target = targetOf(data, event);
    if (!target) continue;
    const slot = slots.get(target) ?? emptySlot(target);
    const title = titleOf(event);
    if (item.start <= nowMs && nowMs < item.end) {
      slot.live.push({ eventId: event.id, title, end: event.end });
    } else if (item.start > nowMs && item.start <= soonMs) {
      slot.soon.push({ eventId: event.id, title, start: event.start });
    } else if (item.start > soonMs && item.day === today) {
      slot.later++;
    } else if (item.end <= nowMs && item.day === today) {
      slot.ended++;
    }
    slots.set(target, slot);
  }

  for (const slot of slots.values()) {
    slot.live.sort((a, b) => a.end.localeCompare(b.end));
    slot.soon.sort((a, b) => a.start.localeCompare(b.start));
  }

  const fired = new Map<string, number>();
  for (const entry of data.entries) {
    if (entry.itemType !== 'event' || entry.date !== today || !entry.projectId) continue;
    if (entry.outcome !== 'done' && entry.outcome !== 'partial') continue;
    fired.set(entry.projectId, (fired.get(entry.projectId) ?? 0) + 1);
  }

  return {
    slots,
    fired,
    drifting: driftingTitles(data, today, settled),
    lighthouseBanners,
    allDay,
    nextChange: nextChangeOf(items, nowMs, today),
  };
}

/** 四档柴堆：0 / 1–3 / 4–8 / 9+。 */
export function woodpileStep(count: number): 0 | 1 | 2 | 3 {
  if (count >= WOODPILE_STEPS[2]) return 3;
  if (count >= WOODPILE_STEPS[1]) return 2;
  if (count >= WOODPILE_STEPS[0]) return 1;
  return 0;
}

/** 对外暴露给 UI，避免每个调用点重复写上限规则。 */
export function visibleBanners(titles: string[]): string[] {
  return titles.slice(0, BANNERS_MAX);
}
