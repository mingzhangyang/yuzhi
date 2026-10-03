/**
 * 所有改动数据的操作。界面只调用这里，不直接改 store.data。
 */
import type { CalendarEvent, ChronicleKind, ISODate, LifeEntry, LifeKind, OperationEvent, OperationKind, OperationLifeSnapshot, Outcome, Project, SettlementEntry, SkipReason, Task } from './types';
import { CHORES } from './types';
import type { Store } from './store';
import { uid } from './lib/id';
import { addDays, fmtDay } from './lib/date';
import { MAX_VILLAGES, PROMPT_SNOOZE_DAYS, STAGE_NAMES, TRIM_TO_NEGLECT, type Stage } from './logic/config';
import { daysToArchive, entryId, itemsForDay, type SettleItem } from './logic/days';
import { dayLine, stageChangeText, type StageChange } from './logic/chronicle';
import { applyRules, matchRule } from './logic/classify';
import { backlog } from './logic/metrics';
import { nextFactSeq } from './logic/operations';
import { ringOfLandmark, totalLandmarkCapacity } from './island/map';

export const REASON_TEXT: Record<SkipReason, string> = {
  interrupted: '被打断',
  no_energy: '没精力',
  not_important: '不重要了',
  postponed: '推到明天',
};

export class ActionError extends Error {}

const q = (s: string) => `「${s}」`;

function life(store: Store, o: { date: ISODate; kind: LifeKind; text: string; projectId?: string; taskId?: string; reason?: SkipReason; fromStage?: number }, id = uid('l')) {
  const e: LifeEntry = { id, ...o };
  store.put('life', e);
}

function chronicle(store: Store, date: ISODate, text: string, kind: ChronicleKind, id = uid('c')) {
  store.put('chronicle', { id, date, text, kind });
}

function operation(
  store: Store,
  o: {
    date?: ISODate;
    kind: OperationKind;
    projectId?: string;
    taskId?: string;
    payload?: OperationEvent['payload'];
    life?: OperationLifeSnapshot[];
  },
) {
  const payload = o.life?.length ? { ...(o.payload ?? {}), life: o.life } : o.payload;
  const event: OperationEvent = {
    id: uid('o'),
    seq: nextFactSeq(store.data),
    date: o.date ?? store.today(),
    kind: o.kind,
    projectId: o.projectId,
    taskId: o.taskId,
    payload,
  };
  store.put('operations', event);
}

/* ---------------- 项目 ---------------- */

export function createProject(store: Store, name: string): Project {
  const n = name.trim();
  if (!n) throw new ActionError('给村落起个名字吧');
  const used = new Set(store.activeProjects().map((p) => p.islandSlot));
  let slot = -1;
  for (let k = 0; k < MAX_VILLAGES; k++) if (!used.has(k)) { slot = k; break; }
  if (slot < 0) throw new ActionError(`岛上暂时住不下更多村落了（最多 ${MAX_VILLAGES} 个）。先关闭一个吧。`);
  const today = store.today();
  const p: Project = { id: uid('p'), name: n, createdAt: today, status: 'active', islandSlot: slot, lastStage: 0 };
  store.put('projects', p);
  operation(store, {
    date: today,
    kind: 'project-created',
    projectId: p.id,
    payload: { name: n, islandSlot: slot },
    life: [{ kind: 'start', projectId: p.id, text: `立项，村落${q(n)}在岛上落成` }],
  });
  chronicle(store, today, `岛上立起了新村落${q(n)}。`, 'event');
  return p;
}

export function renameProject(store: Store, id: string, name: string) {
  const p = store.project(id);
  const n = name.trim();
  if (!p || !n || n === p.name) return;
  operation(store, {
    kind: 'project-renamed',
    projectId: id,
    payload: { fromName: p.name, toName: n },
    life: [{ kind: 'event', projectId: id, text: `改名：${q(p.name)} → ${q(n)}` }],
  });
  store.put('projects', { ...p, name: n });
}

function resetPostpones(store: Store, projectId: string) {
  for (const t of store.data.tasks) if (t.projectId === projectId && t.status === 'open' && t.postponeCount) store.put('tasks', { ...t, postponeCount: 0 });
}

/** 搬离阶段的三个选择之一：重新启动 */
export function restartProject(store: Store, id: string) {
  const p = store.project(id);
  if (!p) return;
  const today = store.today();
  resetPostpones(store, id);
  store.put('projects', { ...p, resets: [...(p.resets ?? []), { date: today, neglect: 0, kind: 'restart' }], promptSnoozeUntil: undefined, lastStage: 0 });
  operation(store, {
    date: today,
    kind: 'project-restarted',
    projectId: id,
    payload: { source: 'manual' },
    life: [{ kind: 'restart', projectId: id, text: '重新启动，村落重新热闹起来' }],
  });
  chronicle(store, today, `${q(p.name)}重新启动了。`, 'recover');
}

/** 搬离阶段的三个选择之一：缩小规模，放下一部分任务 */
export function trimProject(store: Store, id: string, dropTaskIds: string[]) {
  const p = store.project(id);
  if (!p) return;
  const today = store.today();
  for (const tid of dropTaskIds) dropTask(store, tid, '缩小规模时放下');
  resetPostpones(store, id);
  store.put('projects', { ...p, resets: [...(p.resets ?? []), { date: today, neglect: TRIM_TO_NEGLECT, kind: 'trim' }], promptSnoozeUntil: undefined, lastStage: 1 });
  operation(store, {
    date: today,
    kind: 'project-trimmed',
    projectId: id,
    payload: { droppedTaskIds: [...dropTaskIds] },
    life: [{ kind: 'trim', projectId: id, text: dropTaskIds.length ? `缩小规模，放下了 ${dropTaskIds.length} 件事` : '缩小规模，轻装继续' }],
  });
  chronicle(store, today, `${q(p.name)}缩小了规模，轻装继续。`, 'recover');
}

/** 搬离阶段的三个选择之一：正式关闭（需要用户确认后调用） */
export function closeProject(store: Store, id: string, reason: string) {
  const p = store.project(id);
  if (!p || p.status !== 'active') return;
  const today = store.today();
  const droppedTaskIds = store.data.tasks.filter((t) => t.projectId === id && t.status === 'open').map((t) => t.id);
  for (const t of store.data.tasks) if (t.projectId === id && t.status === 'open') store.put('tasks', { ...t, status: 'dropped', closedAt: today });
  const r = reason.trim();
  store.put('projects', { ...p, status: 'closed', closedAt: today, closeReason: r || undefined });
  operation(store, {
    date: today,
    kind: 'project-closed',
    projectId: id,
    payload: { reason: r || undefined, droppedTaskIds },
    life: [{ kind: 'close', projectId: id, text: r ? `正式关闭：${r}` : '正式关闭' }],
  });
  chronicle(store, today, `${q(p.name)}正式关闭，放进了「未竟之书」。`, 'quiet');
}

/** 把关闭的项目重新立起来 */
export function reopenProject(store: Store, id: string) {
  const p = store.project(id);
  if (!p || p.status !== 'closed') return;
  const used = new Set(store.activeProjects().map((x) => x.islandSlot));
  let slot = -1;
  for (let k = 0; k < MAX_VILLAGES; k++) if (!used.has(k)) { slot = k; break; }
  if (slot < 0) throw new ActionError('岛上暂时没有空地了');
  const today = store.today();
  store.put('projects', { ...p, status: 'active', islandSlot: slot, closedAt: undefined, resets: [...(p.resets ?? []), { date: today, neglect: 0, kind: 'restart' }], lastStage: 0 });
  operation(store, {
    date: today,
    kind: 'project-restarted',
    projectId: id,
    payload: { source: 'reopen', islandSlot: slot },
    life: [{ kind: 'restart', projectId: id, text: '从「未竟之书」里重新立起' }],
  });
  chronicle(store, today, `${q(p.name)}被重新立起。`, 'recover');
}

export function snoozePrompt(store: Store, id: string) {
  const p = store.project(id);
  if (p) store.put('projects', { ...p, promptSnoozeUntil: addDays(store.today(), PROMPT_SNOOZE_DAYS) });
}

/** 需要询问「重新启动 / 缩小规模 / 正式关闭」的项目 */
export function projectsNeedingPrompt(store: Store): Project[] {
  const v = store.villages();
  const today = store.today();
  return store.activeProjects().filter((p) => v.get(p.id)?.stage === 3 && !(p.promptSnoozeUntil && p.promptSnoozeUntil > today));
}

/* ---------------- 任务 ---------------- */

export function createTask(store: Store, o: { title: string; projectId?: string; scheduledFor?: ISODate }): Task {
  const title = o.title.trim();
  if (!title) throw new ActionError('写一句要做的事吧');
  const today = store.today();
  const projectId = o.projectId && store.project(o.projectId)?.status === 'active' ? o.projectId : undefined;
  const t: Task = { id: uid('t'), title, projectId, scheduledFor: projectId ? o.scheduledFor : undefined, postponeCount: 0, status: 'open', createdAt: today };
  // 停在码头的任务也可以先带着日期，安排时沿用
  if (!projectId && o.scheduledFor) t.scheduledFor = o.scheduledFor;
  store.put('tasks', t);
  operation(store, {
    date: today,
    kind: 'task-created',
    projectId,
    taskId: t.id,
    payload: { title, scheduledFor: t.scheduledFor },
    life: projectId ? [{ kind: 'task', projectId, taskId: t.id, text: `新任务${q(title)}住进村落` }] : undefined,
  });
  return t;
}

/** 码头：决定任务住进哪个村落、排在什么时候 */
export function arrangeTask(store: Store, taskId: string, projectId: string, date?: ISODate) {
  const t = store.task(taskId);
  const p = store.project(projectId);
  if (!t || !p || p.status !== 'active') return;
  const today = store.today();
  store.put('tasks', { ...t, projectId, scheduledFor: date });
  operation(store, {
    date: today,
    kind: 'task-arranged',
    projectId,
    taskId,
    payload: { fromProjectId: t.projectId, toProjectId: projectId, scheduledFor: date },
    life: [{ kind: 'task', projectId, taskId, text: `${q(t.title)}从码头上岸，住进村落${date ? `，排在${fmtDay(date)}` : ''}` }],
  });
}

/** 码头：婉拒 */
export function declineTask(store: Store, taskId: string) {
  const t = store.task(taskId);
  if (!t) return;
  const today = store.today();
  store.put('tasks', { ...t, status: 'dropped', closedAt: today });
  operation(store, { date: today, kind: 'task-dropped', projectId: t.projectId, taskId, payload: { source: 'decline' } });
}

export function rescheduleTask(store: Store, taskId: string, date: ISODate | undefined) {
  const t = store.task(taskId);
  if (!t || t.status !== 'open') return;
  const today = store.today();
  store.put('tasks', { ...t, scheduledFor: date });
  operation(store, {
    date: today,
    kind: 'task-rescheduled',
    projectId: t.projectId,
    taskId,
    payload: { fromDate: t.scheduledFor, toDate: date },
    life: t.projectId ? [{ kind: 'event', projectId: t.projectId, taskId, text: date ? `${q(t.title)}改到${fmtDay(date)}` : `${q(t.title)}暂不定日期` }] : undefined,
  });
}

export function moveTask(store: Store, taskId: string, projectId: string | undefined) {
  const t = store.task(taskId);
  if (!t || t.projectId === projectId) return;
  const today = store.today();
  const fromProjectId = t.projectId;
  store.put('tasks', { ...t, projectId, scheduledFor: projectId ? t.scheduledFor : undefined });
  operation(store, {
    date: today,
    kind: 'task-moved',
    projectId,
    taskId,
    payload: { fromProjectId, toProjectId: projectId },
    life: [
      ...(fromProjectId ? [{ kind: 'event' as const, projectId: fromProjectId, taskId, text: `${q(t.title)}搬去了别的村落` }] : []),
      ...(projectId ? [{ kind: 'task' as const, projectId, taskId, text: `${q(t.title)}搬进村落` }] : []),
    ],
  });
}

export function renameTask(store: Store, taskId: string, title: string) {
  const t = store.task(taskId);
  const n = title.trim();
  if (t && n) store.put('tasks', { ...t, title: n });
}

/** 不重要了：任务移出，不算惩罚 */
export function dropTask(store: Store, taskId: string, note = '不重要了，移出村落') {
  const t = store.task(taskId);
  if (!t || t.status !== 'open') return;
  const today = store.today();
  store.put('tasks', { ...t, status: 'dropped', closedAt: today });
  operation(store, {
    date: today,
    kind: 'task-dropped',
    projectId: t.projectId,
    taskId,
    payload: { source: 'manual', note },
    life: t.projectId ? [{ kind: 'drop', projectId: t.projectId, taskId, text: `${q(t.title)}${note}`, reason: 'not_important' }] : undefined,
  });
}

/** 在结算之外直接记下「今天做完了」（例如没有日期的任务） */
export function markTaskDone(store: Store, taskId: string) {
  const t = store.task(taskId);
  if (!t || t.status !== 'open' || !t.projectId) return;
  const today = store.today();
  recordEntry(store, today, { key: `task|${t.id}`, type: 'task', id: t.id, title: t.title, projectId: t.projectId }, 'done');
}

/* ---------------- 结算 ---------------- */

export interface Decision {
  outcome: Outcome;
  reason?: SkipReason;
}

/** 结算记录派生出的一生之书条目、打断记录用固定 id，改判时能找到并撤销 */
const lifeIdOf = (entryId: string) => `l|${entryId}`;
const interruptionIdOf = (entryId: string) => `i|${entryId}`;
/** 结算带来的阶段变化：每个村落每天一条，重新结算时替换或撤掉 */
const stageLifeIdOf = (date: ISODate, projectId: string) => `stage|${date}|${projectId}`;

/** 项目的「最近一次真实推进」由结算记录重新算出 */
function recomputeLastProgress(store: Store, projectId: string | undefined) {
  const p = store.project(projectId);
  if (!p) return;
  let last: ISODate | undefined;
  for (const e of store.data.entries) if (e.projectId === projectId && e.outcome !== 'skipped' && (!last || e.date > last)) last = e.date;
  if (p.lastProgressAt !== last) store.put('projects', { ...p, lastProgressAt: last });
}

/** 撤销一条结算记录留下的所有后果：一生之书、打断记录、任务状态与推迟次数 */
function revertEntry(store: Store, prev: SettlementEntry) {
  store.del('life', lifeIdOf(prev.id));
  store.del('interruptions', interruptionIdOf(prev.id));
  if (prev.itemType !== 'task') return;
  const t = store.task(prev.itemId);
  if (!t) return;
  const later = store.data.entries.some((e) => e.itemType === 'task' && e.itemId === t.id && e.date > prev.date);
  if (later) {
    // 之后的日子已经接着结算过这件事，只撤销推迟次数
    if (prev.reason === 'postponed') store.put('tasks', { ...t, postponeCount: Math.max(0, t.postponeCount - 1) });
    return;
  }
  // 回到结算前的样子：还开着，排在那一天
  store.put('tasks', {
    ...t,
    status: 'open',
    closedAt: undefined,
    scheduledFor: prev.date,
    postponeCount: prev.reason === 'postponed' ? Math.max(0, t.postponeCount - 1) : t.postponeCount,
  });
}

/** 写一条结算记录，并让任务、一生之书、打断记录随之变化。改判时先撤销上一次的后果 */
function recordEntry(store: Store, date: ISODate, item: SettleItem, outcome: Outcome, reason?: SkipReason) {
  const id = entryId(date, item.type, item.id);
  const prev = store.data.entries.find((e) => e.id === id);
  if (prev && prev.outcome === outcome && prev.reason === reason) return;
  if (prev) revertEntry(store, prev);
  const projectId = item.projectId && item.projectId !== CHORES ? item.projectId : undefined;
  const entry: SettlementEntry = {
    id,
    seq: prev?.seq ?? nextFactSeq(store.data),
    date,
    itemType: item.type,
    itemId: item.id,
    outcome,
    reason,
    projectId,
    title: item.title,
  };
  store.put('entries', entry);

  const title = q(item.title);
  const lifeBase = { date, projectId, taskId: item.type === 'task' ? item.id : undefined };
  const lid = lifeIdOf(id);
  if (outcome === 'done') life(store, { ...lifeBase, kind: 'done', text: item.type === 'task' ? `完成了${title}` : `${title}做了` }, lid);
  else if (outcome === 'partial') life(store, { ...lifeBase, kind: 'partial', text: `${title}做了一部分` }, lid);
  else life(store, { ...lifeBase, kind: 'skip', reason, text: `${title}没做${reason ? `：${REASON_TEXT[reason]}` : ''}` }, lid);

  recomputeLastProgress(store, projectId);
  if (prev?.projectId !== projectId) recomputeLastProgress(store, prev?.projectId);
  if (reason === 'interrupted') store.put('interruptions', { id: interruptionIdOf(id), date, itemType: item.type, itemId: item.id, title: item.title, projectId });

  if (item.type !== 'task') return;
  const t = store.task(item.id);
  if (!t) return;
  if (outcome === 'done') store.put('tasks', { ...t, status: 'done', closedAt: date });
  else if (outcome === 'partial') store.put('tasks', { ...t, status: 'open', closedAt: undefined, scheduledFor: addDays(date, 1) });
  else if (reason === 'postponed') store.put('tasks', { ...t, status: 'open', closedAt: undefined, scheduledFor: addDays(date, 1), postponeCount: t.postponeCount + 1 });
  else if (reason === 'not_important') store.put('tasks', { ...t, status: 'dropped', closedAt: date });
  else store.put('tasks', { ...t, status: 'open', closedAt: undefined, scheduledFor: date });
}

/** 撤掉一条结算记录（重新结算时取消了这一条的决定） */
function removeEntry(store: Store, prev: SettlementEntry) {
  revertEntry(store, prev);
  store.del('entries', prev.id);
  recomputeLastProgress(store, prev.projectId);
}

/** 当前每个活跃项目的阶段 */
function stagesNow(store: Store): Map<string, Stage> {
  const m = new Map<string, Stage>();
  for (const [id, v] of store.villages()) m.set(id, v.stage);
  return m;
}

/**
 * 结算一天：逐条写下结果，小岛随之变化，编年史自动多一行。
 * 没有给出决定的条目不写记录（相当于这一条没记）。
 */
export function settleDay(store: Store, date: ISODate, decisions: Map<string, Decision>): string {
  // 这一天结算之前的阶段。重新结算时，以第一次结算前的阶段为准，而不是上一次结算后的
  const before = stagesNow(store);
  for (const [id] of before) {
    const rec = store.data.life.find((l) => l.id === stageLifeIdOf(date, id));
    if (rec?.fromStage != null) before.set(id, rec.fromStage as Stage);
  }
  const items = itemsForDay(store.data, date);
  for (const it of items) {
    const d = decisions.get(it.key);
    if (d) recordEntry(store, date, it, d.outcome, d.outcome === 'skipped' ? d.reason : undefined);
    else if (it.entry) removeEntry(store, it.entry);
  }
  store.put('days', { date, status: 'settled' });

  const after = stagesNow(store);
  const changes: StageChange[] = [];
  for (const [id, to] of after) {
    const p = store.project(id)!;
    const from = before.get(id) ?? (p.lastStage as Stage | undefined) ?? 0;
    const lid = stageLifeIdOf(date, id);
    if (from !== to) {
      changes.push({ project: p, from, to });
      life(store, { date, kind: 'stage', projectId: id, fromStage: from, text: `村落进入「${STAGE_NAMES[to]}」阶段` }, lid);
    } else if (store.data.life.some((l) => l.id === lid)) {
      // 改判后这一天对这个村落不再有阶段变化
      store.del('life', lid);
    }
    if (p.lastStage !== to) store.put('projects', { ...p, lastStage: to });
  }
  const projects = new Map(store.data.projects.map((p) => [p.id, p] as const));
  const dayEntries = store.data.entries.filter((e) => e.date === date);
  const text = dayLine(dayEntries, projects, changes);
  const kind: ChronicleKind = changes.some((c) => c.to < c.from) ? 'recover' : changes.some((c) => c.to > c.from) ? 'quiet' : 'day';
  chronicle(store, date, text, kind, `day|${date}`);
  return text;
}

/** 超过 3 天仍未结算的日子，自动归档为「未记录」：不算做了，也不算没做 */
export function archiveOldDays(store: Store): ISODate[] {
  const days = daysToArchive(store.data, store.today());
  for (const d of days) {
    store.put('days', { date: d, status: 'unrecorded' });
    chronicle(store, d, `${fmtDay(d)}没有记录，海雾在第四天散去了。`, 'quiet', `day|${d}`);
  }
  return days;
}

/** 时间流逝带来的阶段变化：写进一生之书和编年史 */
export function refreshStages(store: Store): StageChange[] {
  const today = store.today();
  const changes: StageChange[] = [];
  for (const [id, v] of store.villages()) {
    const p = store.project(id);
    if (!p) continue;
    const from = (p.lastStage ?? 0) as Stage;
    if (from === v.stage) continue;
    changes.push({ project: p, from, to: v.stage });
  }
  for (const c of changes) {
    life(store, { date: today, kind: 'stage', projectId: c.project.id, text: `村落进入「${STAGE_NAMES[c.to]}」阶段` });
    chronicle(store, today, stageChangeText(c) + '。', c.to < c.from ? 'recover' : 'quiet');
    store.put('projects', { ...store.project(c.project.id)!, lastStage: c.to });
  }
  return changes;
}

/* ---------------- 日历归类 ---------------- */

/** 用户为一类事件指定归属；可同时记下一条规则 */
export function classifyEvents(store: Store, title: string, projectId: string, ruleText?: string) {
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
export function setEventProject(store: Store, eventId: string, projectId: string | undefined) {
  const e = store.data.events.find((x) => x.id === eventId);
  if (e) store.put('events', { ...e, projectId: projectId || CHORES, classified: true });
}

export function deleteRule(store: Store, id: string) {
  store.del('rules', id);
}

/**
 * 把新解析出的事件合并进来：保留已有的归属；
 * 来源里已不存在、且还没结算过的未来事件会被移除。
 */
export function mergeEvents(store: Store, sourceId: string, incoming: CalendarEvent[], windowStart: string) {
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

/** 给事件换 id，并把结算记录、一生之书、打断记录里的引用一并改过去 */
function renameEvent(store: Store, ev: CalendarEvent, newId: string) {
  store.put('events', { ...ev, id: newId });
  store.del('events', ev.id);
  for (const en of store.data.entries.filter((x) => x.itemType === 'event' && x.itemId === ev.id)) {
    const nid = entryId(en.date, 'event', newId);
    store.put('entries', { ...en, id: nid, itemId: newId });
    store.del('entries', en.id);
    const l = store.data.life.find((x) => x.id === lifeIdOf(en.id));
    if (l) {
      store.put('life', { ...l, id: lifeIdOf(nid) });
      store.del('life', l.id);
    }
    const i = store.data.interruptions.find((x) => x.id === interruptionIdOf(en.id));
    if (i) {
      store.put('interruptions', { ...i, id: interruptionIdOf(nid), itemId: newId });
      store.del('interruptions', i.id);
    }
  }
}

export function removeSource(store: Store, sourceId: string) {
  const settled = new Set(store.data.entries.filter((e) => e.itemType === 'event').map((e) => e.itemId));
  for (const e of store.data.events.filter((x) => x.sourceId === sourceId)) if (!settled.has(e.id)) store.del('events', e.id);
  store.del('sources', sourceId);
}

/** 结算时把一件别的任务拉进这一天（「今天还做了…」），不算改期 */
export function pullIntoDay(store: Store, taskId: string, date: ISODate) {
  const t = store.task(taskId);
  if (t && t.status === 'open' && t.projectId && t.scheduledFor !== date) {
    store.put('tasks', { ...t, scheduledFor: date });
    operation(store, {
      date: store.today(),
      kind: 'task-rescheduled',
      projectId: t.projectId,
      taskId,
      payload: { fromDate: t.scheduledFor, toDate: date, source: 'pull-into-day' },
    });
  }
}

/* ---------------- 落成 ---------------- */

/** 最小的空闲地标位 */
export function freeLandmarkIndex(store: Store, except?: string): number {
  const used = new Set(store.data.projects.filter((p) => p.id !== except && p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null).map((p) => p.landmarkIndex!));
  const cap = totalLandmarkCapacity();
  for (let k = 0; k < cap; k++) if (!used.has(k)) return k;
  return -1;
}

/** 地标越多，岛向外长出新陆地：需要几圈年轮 */
export function islandRings(store: Store): number {
  let max = -1;
  for (const p of store.data.projects) if (p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null) max = Math.max(max, p.landmarkIndex);
  return max < 0 ? 0 : ringOfLandmark(max);
}

/**
 * 完成一个项目（落成仪式里用户做出选择后调用）：
 * 没做完的任务随项目一起放下（不算没做），村落腾空，
 * 项目立为海岸上的地标，或收进山顶灯塔里的档案馆。
 */
export function completeProject(store: Store, id: string, resting: 'landmark' | 'archive'): 'landmark' | 'archive' {
  const p = store.project(id);
  if (!p || p.status !== 'active') throw new ActionError('这个项目已经不在岛上了');
  const today = store.today();
  for (const t of store.data.tasks) {
    if (t.projectId !== id || t.status !== 'open') continue;
    store.put('tasks', { ...t, status: 'dropped', closedAt: today });
    operation(store, {
      date: today,
      kind: 'task-dropped',
      projectId: id,
      taskId: t.id,
      payload: { source: 'project-completed' },
      life: [{ kind: 'drop', projectId: id, taskId: t.id, text: `${q(t.title)}随项目完成一起放下` }],
    });
  }
  let where = resting;
  let idx: number | undefined;
  if (where === 'landmark') {
    const k = freeLandmarkIndex(store, id);
    if (k < 0) where = 'archive';
    else idx = k;
  }
  store.put('projects', { ...p, status: 'done', doneAt: today, resting: where, landmarkIndex: idx, promptSnoozeUntil: undefined });
  operation(store, {
    date: today,
    kind: 'project-completed',
    projectId: id,
    payload: { resting: where, landmarkIndex: idx },
    life: [{ kind: 'complete', projectId: id, text: where === 'landmark' ? '落成，立为海岸上的地标' : '完成，收进山顶灯塔里的档案馆' }],
  });
  chronicle(store, today, where === 'landmark' ? `${q(p.name)}落成了，村落合成一座地标，立在海岸上。` : `${q(p.name)}完成了，收进了山顶的灯塔。`, 'landmark');
  return where;
}

/** 反悔：地标收进档案馆，或把档案里的项目重新立为地标 */
export function setResting(store: Store, id: string, resting: 'landmark' | 'archive') {
  const p = store.project(id);
  if (!p || p.status !== 'done' || p.resting === resting) return;
  const today = store.today();
  if (resting === 'landmark') {
    const k = freeLandmarkIndex(store, id);
    if (k < 0) throw new ActionError('海岸上已经没有空地了');
    store.put('projects', { ...p, resting, landmarkIndex: k });
    operation(store, {
      date: today,
      kind: 'project-resting-changed',
      projectId: id,
      payload: { from: p.resting, to: resting, landmarkIndex: k },
      life: [{ kind: 'event', projectId: id, text: '从档案馆里取出，重新立为地标' }],
    });
    chronicle(store, today, `${q(p.name)}重新立在了海岸上。`, 'landmark');
  } else {
    store.put('projects', { ...p, resting, landmarkIndex: undefined });
    operation(store, {
      date: today,
      kind: 'project-resting-changed',
      projectId: id,
      payload: { from: p.resting, to: resting },
      life: [{ kind: 'event', projectId: id, text: '地标收进了山顶的档案馆' }],
    });
    chronicle(store, today, `${q(p.name)}的地标收进了山顶的灯塔。`, 'quiet');
  }
}

/** 记下今天的积压数（当天最后一次的值），供积压走势使用 */
export function recordBacklogSnapshot(store: Store) {
  const today = store.today();
  const n = backlog(store.data, today).total;
  const cur = store.data.snapshots.find((x) => x.date === today);
  if (cur?.backlog !== n) store.put('snapshots', { date: today, backlog: n });
}
