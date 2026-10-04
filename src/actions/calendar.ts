/** Calendar classification and ingestion mutations. */
import type { CalendarEvent } from '../types';
import { CHORES } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
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
