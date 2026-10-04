import type { Store } from './store';
import type { CalendarSource } from './types';
import { fetchIcs, parseIcs } from './ics';
import { mergeEvents } from './actions';
import { uid } from './lib/id';
import { ICS_FUTURE_DAYS, ICS_PAST_DAYS } from './logic/config';

function windowNow(now: Date) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ICS_PAST_DAYS);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ICS_FUTURE_DAYS);
  return { from, to };
}

/** 把 .ics 文本并入某个来源，返回事件数 */
export function ingest(store: Store, src: CalendarSource, text: string): number {
  const { from, to } = windowNow(store.clock());
  const r = parseIcs(text, src.id, from, to);
  mergeEvents(store, src.id, r.events, from.toISOString());
  return r.events.length;
}

/** 刷新一个订阅链接 */
export async function syncSource(store: Store, id: string): Promise<number> {
  if (store.isReadOnly) throw new Error('当前标签页是只读的，不能刷新日历');
  const src = store.data.sources.find((s) => s.id === id);
  if (!src?.icsUrl) return 0;
  try {
    const text = await fetchIcs(src.icsUrl);
    // Writer ownership or the source itself may change while the network
    // request is in flight. Only the still-current source may consume it.
    if (store.isReadOnly) throw new Error('刷新期间写权限已转移，已丢弃这次日历结果');
    const current = store.data.sources.find((s) => s.id === id);
    if (!current || current.icsUrl !== src.icsUrl) return 0;
    return store.batch(() => {
      const n = ingest(store, current, text);
      store.put('sources', { ...current, lastFetchedAt: new Date().toISOString(), lastError: undefined });
      return n;
    });
  } catch (e) {
    // Never turn a demotion race into a second rejected write.
    if (store.isReadOnly) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const current = store.data.sources.find((s) => s.id === id);
    if (current) store.put('sources', { ...current, lastError: msg });
    throw e;
  }
}

export async function addUrlSource(store: Store, name: string, url: string): Promise<number> {
  if (store.isReadOnly) throw new Error('当前标签页是只读的，不能添加日历');
  const u = url.trim();
  if (!/^(https?|webcals?):\/\//i.test(u)) throw new Error('请粘贴以 https:// 或 webcal:// 开头的订阅链接');
  const text = await fetchIcs(u);
  if (store.isReadOnly) throw new Error('读取期间写权限已转移，已丢弃这次日历结果');
  const src: CalendarSource = { id: uid('s'), name: name.trim() || '日历', icsUrl: u };
  const { from, to } = windowNow(store.clock());
  const r = parseIcs(text, src.id, from, to);
  src.name = name.trim() || r.calendarName || '日历';
  src.lastFetchedAt = new Date().toISOString();
  return store.batch(() => {
    store.put('sources', src);
    mergeEvents(store, src.id, r.events, from.toISOString());
    return r.events.length;
  });
}

export async function addFileSource(store: Store, file: File): Promise<number> {
  if (store.isReadOnly) throw new Error('当前标签页是只读的，不能添加日历');
  const text = await file.text();
  if (store.isReadOnly) throw new Error('读取期间写权限已转移，已丢弃这次日历结果');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new Error('这不是 .ics 日历文件');
  const src: CalendarSource = { id: uid('s'), name: file.name.replace(/\.ics$/i, '') || '上传的日历', lastFetchedAt: new Date().toISOString() };
  const { from, to } = windowNow(store.clock());
  const r = parseIcs(text, src.id, from, to);
  if (r.calendarName) src.name = r.calendarName;
  return store.batch(() => {
    store.put('sources', src);
    mergeEvents(store, src.id, r.events, from.toISOString());
    return r.events.length;
  });
}

/** 打开时刷新超过 2 小时没更新的订阅 */
export async function autoRefresh(store: Store): Promise<number> {
  if (store.isReadOnly) return 0;
  const stale = store.data.sources.filter((s) => s.icsUrl && (!s.lastFetchedAt || Date.now() - new Date(s.lastFetchedAt).getTime() > 2 * 3600 * 1000));
  let ok = 0;
  for (const s of stale) {
    if (store.isReadOnly) break;
    try {
      await syncSource(store, s.id);
      ok++;
    } catch {
      // Network failures are recorded by syncSource while this tab remains
      // writer. A writer-transfer abort is intentionally silent here.
    }
  }
  return ok;
}
