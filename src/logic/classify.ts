import type { CalendarEvent, ClassifyRule } from '../types';

const norm = (s: string) => s.trim().toLowerCase();

/** 找到匹配的归类规则：标题包含规则文字；多条都匹配时取文字最长（最具体）的那条 */
export function matchRule(title: string, rules: ClassifyRule[]): ClassifyRule | undefined {
  const t = norm(title);
  let best: ClassifyRule | undefined;
  for (const r of rules) {
    const c = norm(r.contains);
    if (!c || !t.includes(c)) continue;
    if (!best || c.length > norm(best.contains).length) best = r;
  }
  return best;
}

/** 对还没归类的事件套用规则，返回被改动的事件 */
export function applyRules(events: CalendarEvent[], rules: ClassifyRule[]): CalendarEvent[] {
  const changed: CalendarEvent[] = [];
  for (const e of events) {
    if (e.classified) continue;
    const r = matchRule(e.title, rules);
    if (!r) continue;
    e.projectId = r.projectId;
    e.classified = true;
    changed.push(e);
  }
  return changed;
}

/** 还没归类的事件，按标题分组（同标题只问一次） */
export function unclassifiedGroups(events: CalendarEvent[]): { title: string; events: CalendarEvent[] }[] {
  const m = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (e.classified || e.allDay) continue;
    const k = e.title.trim();
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  }
  return [...m.entries()].map(([title, events]) => ({ title, events })).sort((a, b) => a.events[0].start.localeCompare(b.events[0].start));
}

/** 从标题里猜一个规则关键词：去掉日期、序号和括号里的内容 */
export function suggestKeyword(title: string): string {
  const s = title
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/\d{1,4}[\/\-.月]\d{1,2}日?/g, '')
    .replace(/#?\d+/g, '')
    .replace(/[\s·:：\-—_]+$/g, '')
    .trim();
  return s || title.trim();
}
