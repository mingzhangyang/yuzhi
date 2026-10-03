import ICAL from 'ical.js';
import type { CalendarEvent } from './types';

type Time = InstanceType<typeof ICAL.Time>;

/** 用 Intl 把「某时区的墙上时间」换算成时刻（VTIMEZONE 缺失时的兜底） */
function zonedToEpoch(t: Time, tz: string): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
    let guess = wall;
    for (let k = 0; k < 3; k++) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
      const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      const diff = wall - seen;
      if (!diff) break;
      guess += diff;
    }
    return guess;
  } catch {
    return null;
  }
}

function toIso(t: Time, tzid: string | null): string {
  if (!t.isDate && tzid && t.zone === ICAL.Timezone.localTimezone) {
    const ms = zonedToEpoch(t, tzid);
    if (ms != null) return new Date(ms).toISOString();
  }
  return t.toJSDate().toISOString();
}

function tzidOf(comp: InstanceType<typeof ICAL.Component>, prop: string): string | null {
  const p = comp.getFirstProperty(prop);
  const v = p?.getParameter('tzid');
  return typeof v === 'string' ? v : null;
}

export interface ParseResult {
  events: CalendarEvent[];
  calendarName?: string;
}

/**
 * 事件的稳定 id：来源 id + UID，重复事件再加上这一次「原本」的开始时间（RECURRENCE-ID）。
 * 某一次被改期后，实际开始时间变了，id 不变，归类和结算记录都还对得上。
 */
export function eventId(sourceId: string, uid: string, occurrence?: string): string {
  return occurrence ? `${sourceId}|${uid}|${occurrence}` : `${sourceId}|${uid}`;
}

/**
 * 解析 .ics 文本，把窗口 [from, to) 内的事件（含重复事件的每一次）展开。
 * id 见 eventId。
 */
export function parseIcs(text: string, sourceId: string, from: Date, to: Date): ParseResult {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
    } catch {
      /* 忽略坏掉的时区定义 */
    }
  }
  const calName = root.getFirstPropertyValue('x-wr-calname');
  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
  const exceptions: InstanceType<typeof ICAL.Event>[] = [];
  const singles: InstanceType<typeof ICAL.Event>[] = [];
  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    if (!ev.uid) continue;
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.isRecurring()) masters.set(ev.uid, ev);
    else singles.push(ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else singles.push(ex);
  }

  const out: CalendarEvent[] = [];
  const seen = new Set<string>();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const push = (ev: InstanceType<typeof ICAL.Event>, start: Time, end: Time | null, occurrence: string | undefined) => {
    const comp = ev.component;
    if (String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const allDay = start.isDate;
    const s = toIso(start, tzidOf(comp, 'dtstart'));
    let e = end ? toIso(end, tzidOf(comp, 'dtend') ?? tzidOf(comp, 'dtstart')) : s;
    if (allDay && (!end || e <= s)) e = new Date(new Date(s).getTime() + 86400000).toISOString();
    const sm = new Date(s).getTime();
    const em = new Date(e).getTime();
    if (em < fromMs && sm < fromMs) return;
    if (sm >= toMs) return;
    const title = (ev.summary || '（无标题）').trim();
    // 不守规矩的日历会给不同事件用同一个 UID：撞了就退回用实际开始时间区分
    let id = eventId(sourceId, ev.uid, occurrence);
    if (seen.has(id)) id = `${id}|${s}`;
    seen.add(id);
    out.push({ id, sourceId, uid: ev.uid, title, start: s, end: e, allDay, classified: false });
  };

  // 找不到主事件的例外仍然按它的 RECURRENCE-ID 识别
  for (const ev of singles) push(ev, ev.startDate, ev.endDate, ev.recurrenceId ? toIso(ev.recurrenceId, tzidOf(ev.component, 'recurrence-id') ?? tzidOf(ev.component, 'dtstart')) : undefined);
  for (const ev of masters.values()) {
    const it = ev.iterator();
    const masterTz = tzidOf(ev.component, 'dtstart');
    let n = 0;
    for (let next = it.next(); next && n < 5000; next = it.next(), n++) {
      if (next.toJSDate().getTime() >= toMs + 86400000) break;
      const det = ev.getOccurrenceDetails(next);
      const recTz = det.item === ev ? masterTz : (tzidOf(det.item.component, 'recurrence-id') ?? masterTz);
      push(det.item, det.startDate, det.endDate, toIso(det.recurrenceId, recTz));
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return { events: out, calendarName: typeof calName === 'string' ? calName : undefined };
}

/** 通过 Worker 取回订阅链接的内容 */
export async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(`/api/ics?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    let msg = `获取失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* 不是 JSON */
    }
    throw new Error(msg);
  }
  return res.text();
}
