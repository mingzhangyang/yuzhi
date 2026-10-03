import type { CalendarEvent, Data, ISODate, SettlementEntry, Task } from '../types';
import { addDays, dateOfStamp, diffDays } from '../lib/date';
import { ARCHIVE_AFTER_DAYS } from './config';
import { taskStates, taskStatesForDates } from './read-model';

export interface SettleItem {
  key: string;
  type: 'task' | 'event';
  id: string;
  title: string;
  projectId?: string;
  /** 事件的开始时间 */
  start?: string;
  end?: string;
  /** 已有的结算记录（重新打开已结算日子时） */
  entry?: SettlementEntry;
}

export const itemKey = (type: 'task' | 'event', id: string) => `${type}|${id}`;
export const entryId = (date: ISODate, type: 'task' | 'event', id: string) => `${date}|${type}|${id}`;

/** 一天内可结算的事件：非全天、开始于这一天 */
export function eventsOn(events: CalendarEvent[], date: ISODate): CalendarEvent[] {
  return events.filter((e) => !e.allDay && dateOfStamp(e.start) === date).sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 某一天要结算的条目：安排在这天且还没完成的任务、这天的日历事件，
 * 以及这天已经有结算记录的条目。没有日期的任务不会自动出现。
 */
export function itemsForDay(data: Data, date: ISODate): SettleItem[] {
  const entries = new Map<string, SettlementEntry>();
  for (const e of data.entries) if (e.date === date) entries.set(itemKey(e.itemType, e.itemId), e);
  const out: SettleItem[] = [];
  const seen = new Set<string>();
  const tasks = taskStates(data, date);
  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]));

  for (const ev of eventsOn(data.events, date)) {
    const key = itemKey('event', ev.id);
    seen.add(key);
    const entry = entries.get(key);
    out.push({ key, type: 'event', id: ev.id, title: entry?.title ?? ev.title, projectId: entry ? entry.projectId : ev.projectId, start: ev.start, end: ev.end, entry });
  }
  for (const t of tasks) {
    const key = itemKey('task', t.id);
    if (t.status === 'open' && t.scheduledFor === date && t.projectId) {
      seen.add(key);
      const entry = entries.get(key);
      out.push({ key, type: 'task', id: t.id, title: entry?.title ?? t.title, projectId: entry ? entry.projectId : t.projectId, entry });
    }
  }
  // 已结算过、但任务已经改期或完成的条目，也保留在这一天
  for (const [key, e] of entries) {
    if (seen.has(key)) continue;
    const t = e.itemType === 'task' ? taskById.get(e.itemId) : undefined;
    out.push({ key, type: e.itemType, id: e.itemId, title: e.title, projectId: e.projectId, entry: e });
  }
  return out;
}

/**
 * 今天之前、有条目却还没结算也没归档的日子（最早的在前）。
 * 直接从条目本身收集日期，不设回看上限：离开很久再回来，旧日子也会被找到并归档。
 */
export function pendingDays(data: Data, today: ISODate): ISODate[] {
  const recorded = new Set(data.days.map((d) => d.date));
  const first = data.settings.firstDay;
  const found = new Set<ISODate>();
  const candidateDatesByTask = new Map<string, Set<ISODate>>();
  const addTaskCandidate = (date: ISODate | undefined, taskId: string) => {
    if (!date) return;
    let dates = candidateDatesByTask.get(taskId);
    if (!dates) candidateDatesByTask.set(taskId, (dates = new Set()));
    dates.add(date);
  };

  // Reconstruct every date a task could historically have been pending.
  // Looking only at today's effective task state loses overdue dates after a
  // later drop/move/reschedule and makes current village replay disagree with
  // the stage timeline.
  for (const task of data.tasks) addTaskCandidate(task.scheduledFor, task.id);
  for (const event of data.operations) {
    if (!event.taskId) continue;
    if (event.kind === 'task-created' || event.kind === 'task-arranged' || event.kind === 'task-state-baseline') {
      const scheduledFor = event.payload?.scheduledFor;
      if (typeof scheduledFor === 'string') addTaskCandidate(scheduledFor, event.taskId);
    } else if (event.kind === 'task-rescheduled') {
      const toDate = event.payload?.toDate;
      if (typeof toDate === 'string') addTaskCandidate(toDate, event.taskId);
    }
  }
  for (const entry of data.entries) {
    if (entry.itemType !== 'task') continue;
    if (entry.outcome === 'partial' || entry.reason === 'postponed') addTaskCandidate(addDays(entry.date, 1), entry.itemId);
    else if (entry.outcome === 'skipped' && entry.reason !== 'not_important') addTaskCandidate(entry.date, entry.itemId);
  }

  const taskById = new Map(data.tasks.map((task) => [task.id, task] as const));
  for (const [taskId, dates] of candidateDatesByTask) {
    const task = taskById.get(taskId);
    if (!task) continue;
    const candidates = [...dates]
      .filter((date) => date >= first && date < today && !recorded.has(date) && task.createdAt <= date)
      .sort();
    if (!candidates.length) continue;

    const states = taskStatesForDates(data, task, candidates);
    for (const date of candidates) {
      const state = states.get(date);
      if (state?.status === 'open' && state.projectId && state.scheduledFor === date) found.add(date);
    }
  }

  for (const event of data.events) {
    if (event.allDay) continue;
    const date = dateOfStamp(event.start);
    if (date >= first && date < today && !recorded.has(date)) found.add(date);
  }
  return [...found].sort();
}

/** 需要自动归档为「未记录」的日子：未结算超过 3 天 */
export function daysToArchive(data: Data, today: ISODate): ISODate[] {
  return pendingDays(data, today).filter((d) => diffDays(d, today) > ARCHIVE_AFTER_DAYS);
}

export type DayStatus = 'settled' | 'unrecorded' | 'pending' | 'empty';

/** 每一天的状态，供衰败计算使用 */
export function dayStatusFn(data: Data, today: ISODate): (d: ISODate) => DayStatus {
  const rec = new Map(data.days.map((d) => [d.date, d.status] as const));
  const pending = new Set(pendingDays(data, today));
  return (d) => rec.get(d) ?? (pending.has(d) ? 'pending' : 'empty');
}
