/** Calendar classification and ingestion mutations. */
import type { CalendarEvent, ISODate } from '../types';
import { CHORES, LOCAL_CALENDAR_SOURCE_ID } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { localDate, startOfLocalDay } from '../lib/date';
import { ActionError } from './shared';
import { entryId } from '../logic/days';
import { applyRules, matchRule } from '../logic/classify';

function classifyEventsImpl(store: Store, title: string, projectId: string, ruleText?: string) {
  const target = projectId || CHORES;
  const kw = ruleText?.trim();
  if (kw) {
    const existing = store.data.rules.find((r) => r.contains.trim().toLowerCase() === kw.toLowerCase());
    store.put('rules', { id: existing?.id ?? uid('r'), contains: kw, projectId: target });
  }
  const t = title.trim();
  for (const e of store.data.events) {
    if (e.classified) continue;
    if (e.title.trim() === t) store.put('events', { ...e, projectId: target, classified: true });
  }
  if (kw) for (const e of applyRules(store.data.events.filter((e) => !e.classified).map((e) => ({ ...e })), store.data.rules)) store.put('events', e);
}

/** 单独改一条事件的归属 */
function setEventProjectImpl(store: Store, eventId: string, projectId: string | undefined) {
  const e = store.data.events.find((x) => x.id === eventId);
  if (e) store.put('events', { ...e, projectId: projectId || CHORES, classified: true });
}

function deleteRuleImpl(store: Store, id: string) {
  store.del('rules', id);
}

/**
 * 把新解析出的事件合并进来：保留已有的归属；
 * 来源里已不存在、且还没结算过的未来事件会被移除。
 */
function mergeEventsImpl(store: Store, sourceId: string, incoming: CalendarEvent[], windowStart: string) {
  const old = new Map(store.data.events.filter((e) => e.sourceId === sourceId).map((e) => [e.id, e] as const));
  const settled = new Set(store.data.entries.filter((e) => e.itemType === 'event').map((e) => e.itemId));
  const keep = new Set<string>();
  const rules = store.data.rules;
  for (const e of incoming) {
    keep.add(e.id);
    // 旧版本的 id 是「UID + 实际开始时间」：认出来就改成新 id，归类和结算记录跟着走
    const legacy = `${e.sourceId}|${e.uid}|${e.start}`;
    if (!old.has(e.id) && legacy !== e.id && old.has(legacy)) {
      renameEvent(store, old.get(legacy)!, e.id);
      old.set(e.id, store.data.events.find((x) => x.id === e.id)!);
      old.delete(legacy);
      if (settled.delete(legacy)) settled.add(e.id);
    }
    const prev = old.get(e.id);
    const next: CalendarEvent = prev ? { ...e, projectId: prev.projectId, classified: prev.classified } : { ...e };
    if (!next.classified) {
      const r = matchRule(next.title, rules);
      if (r) {
        next.projectId = r.projectId;
        next.classified = true;
      }
    }
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) store.put('events', next);
  }
  for (const [id, e] of old) {
    if (keep.has(id) || settled.has(id)) continue;
    // 窗口之前的旧事件保留，避免历史消失
    if (e.start < windowStart) continue;
    store.del('events', id);
  }
}

/** 给事件换 id；一生之书和打断记录都由结算事实实时派生。 */
function renameEvent(store: Store, ev: CalendarEvent, newId: string) {
  store.put('events', { ...ev, id: newId });
  store.del('events', ev.id);
  for (const entry of store.data.entries.filter((row) => row.itemType === 'event' && row.itemId === ev.id)) {
    const id = entryId(entry.date, 'event', newId);
    store.renameFact('entries', entry.id, { ...entry, id, itemId: newId });
  }
}

function removeSourceImpl(store: Store, sourceId: string) {
  const settled = new Set(store.data.entries.filter((e) => e.itemType === 'event').map((e) => e.itemId));
  for (const e of store.data.events.filter((x) => x.sourceId === sourceId)) if (!settled.has(e.id)) store.del('events', e.id);
  store.del('sources', sourceId);
}

export const classifyEvents = (...args: Parameters<typeof classifyEventsImpl>): ReturnType<typeof classifyEventsImpl> =>
  args[0].batch(() => classifyEventsImpl(...args));

export const setEventProject = (...args: Parameters<typeof setEventProjectImpl>): ReturnType<typeof setEventProjectImpl> =>
  args[0].batch(() => setEventProjectImpl(...args));

export const deleteRule = (...args: Parameters<typeof deleteRuleImpl>): ReturnType<typeof deleteRuleImpl> =>
  args[0].batch(() => deleteRuleImpl(...args));

export const mergeEvents = (...args: Parameters<typeof mergeEventsImpl>): ReturnType<typeof mergeEventsImpl> =>
  args[0].batch(() => mergeEventsImpl(...args));

export const removeSource = (...args: Parameters<typeof removeSourceImpl>): ReturnType<typeof removeSourceImpl> =>
  args[0].batch(() => removeSourceImpl(...args));


export interface LocalScheduleInput {
  title: string;
  date: ISODate;
  start: string;
  end: string;
  projectId?: string;
}

const LOCAL_HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function localScheduleStamp(date: ISODate, hm: string): string {
  const d = startOfLocalDay(date);
  if (localDate(d) !== date) throw new ActionError('日程日期不存在');
  const [h, m] = hm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  const actual = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (localDate(d) !== date || actual !== hm) {
    throw new ActionError('这个当地时间因夏令时切换不存在，请重新选择');
  }
  return d.toISOString();
}

/** 用户在屿志里直接创建日程；它进入和外部日历相同的 agenda / 结算管线。 */
function createScheduleImpl(store: Store, input: LocalScheduleInput): CalendarEvent {
  const title = input.title.trim();
  if (!title) throw new ActionError('写一句日程标题吧');
  if (!LOCAL_YMD.test(input.date)) throw new ActionError('日程日期格式不对');
  if (!LOCAL_HM.test(input.start) || !LOCAL_HM.test(input.end)) {
    throw new ActionError('日程时间格式不对');
  }
  const start = localScheduleStamp(input.date, input.start);
  const end = localScheduleStamp(input.date, input.end);
  // Compare actual local instants after Date normalization. During a DST
  // spring-forward gap, wall-clock string order can be misleading.
  if (Date.parse(end) <= Date.parse(start)) {
    throw new ActionError('日程结束时间要晚于开始时间');
  }
  const requested = input.projectId;
  const projectId = requested === CHORES
    ? CHORES
    : requested && store.project(requested)?.status === 'active'
      ? requested
      : CHORES;
  const eventUid = uid('schedule');
  const event: CalendarEvent = {
    id: `${LOCAL_CALENDAR_SOURCE_ID}|${eventUid}`,
    sourceId: LOCAL_CALENDAR_SOURCE_ID,
    uid: eventUid,
    title,
    start,
    end,
    allDay: false,
    projectId,
    classified: true,
  };
  store.put('events', event);
  return event;
}

function deleteScheduleImpl(store: Store, eventId: string) {
  const event = store.data.events.find((item) => item.id === eventId);
  if (!event || event.sourceId !== LOCAL_CALENDAR_SOURCE_ID) return;
  if (store.data.entries.some((entry) => entry.itemType === 'event' && entry.itemId === eventId)) {
    throw new ActionError('这个日程已经留下结算记录，不能直接删除');
  }
  store.del('events', eventId);
}

export const createSchedule = (...args: Parameters<typeof createScheduleImpl>): ReturnType<typeof createScheduleImpl> =>
  args[0].batch(() => createScheduleImpl(...args));

export const deleteSchedule = (...args: Parameters<typeof deleteScheduleImpl>): ReturnType<typeof deleteScheduleImpl> =>
  args[0].batch(() => deleteScheduleImpl(...args));
