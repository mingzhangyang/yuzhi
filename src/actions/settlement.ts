/** Settlement and time-passage mutations. */
import type {
  ChronicleKind,
  Data,
  ISODate,
  Outcome,
  SettlementEntry,
  SkipReason,
} from '../types';
import type { Store } from '../store';
import { type Stage } from '../logic/config';
import { daysToArchive, itemsForDay, type SettleItem } from '../logic/days';
import { dayEvents, stageChangeEvent, type StageChange } from '../logic/chronicle';
import { historyEvent } from '../history-types';
import { backlog } from '../logic/metrics';
import { computeAllVillages, stageTransitions } from '../logic/decay';
import { putSettlementEntry, semanticChronicle } from './shared';

export interface Decision {
  outcome: Outcome;
  reason?: SkipReason;
}

/** 改判时取消决定：只删事实，所有后果由 read model 自动消失。 */
function removeEntry(store: Store, prev: SettlementEntry) {
  store.del('entries', prev.id);
}

/**
 * 结算一天：逐条写下结果，小岛随之变化，编年史自动多一行。
 * 没有给出决定的条目不写记录（相当于这一条没记）。
 */
function settleDayImpl(store: Store, date: ISODate, decisions: Map<string, Decision>, extraItems: SettleItem[] = []): string {
  // Rebuild the stage immediately before this day's settlement from facts,
  // rather than remembering a fromStage snapshot.
  const beforeData: Data = {
    ...store.data,
    entries: store.data.entries.filter((entry) => entry.date !== date),
    days: store.data.days.filter((day) => day.date !== date),
  };
  const before = new Map<string, Stage>();
  for (const [id, village] of computeAllVillages(beforeData, date)) before.set(id, village.stage);

  const items = itemsForDay(store.data, date);
  const itemKeys = new Set(items.map((item) => item.key));
  for (const item of extraItems) if (!itemKeys.has(item.key)) {
    items.push(item);
    itemKeys.add(item.key);
  }
  for (const item of items) {
    const decision = decisions.get(item.key);
    if (decision) putSettlementEntry(store, date, item, decision.outcome, decision.outcome === 'skipped' ? decision.reason : undefined);
    else if (item.entry) removeEntry(store, item.entry);
  }
  store.put('days', { date, status: 'settled' });

  const changes: StageChange[] = [];
  for (const [id, village] of computeAllVillages(store.data, date)) {
    const project = store.project(id)!;
    const from = before.get(id) ?? 0;
    if (from !== village.stage) changes.push({ project, from, to: village.stage });
  }
  const projects = new Map(store.data.projects.map((project) => [project.id, project] as const));
  const dayEntries = store.data.entries.filter((entry) => entry.date === date);
  const events = dayEvents(dayEntries, projects, changes);
  const kind: ChronicleKind = changes.some((change) => change.to < change.from) ? 'recover' : changes.some((change) => change.to > change.from) ? 'quiet' : 'day';
  return semanticChronicle(store, date, events, kind, `day|${date}`);
}

/** 超过 3 天仍未结算的日子，自动归档为「未记录」：不算做了，也不算没做 */
function archiveOldDaysImpl(store: Store): ISODate[] {
  const days = daysToArchive(store.data, store.today());
  for (const d of days) {
    store.put('days', { date: d, status: 'unrecorded' });
    semanticChronicle(store, d, [historyEvent('history.chron.dayArchived', { date: d })], 'quiet', `day|${d}`);
  }
  return days;
}

/** 时间流逝带来的阶段变化：写进一生之书和编年史 */
function refreshStagesImpl(store: Store): StageChange[] {
  const today = store.today();
  const changes: StageChange[] = [];
  const legacyBoundary = store.data.operations.find((event) => event.kind === 'migration-boundary')?.date;
  const transitions = stageTransitions(store.data, today)
    .filter((transition) => transition.source === 'time')
    .filter((transition) => !legacyBoundary || transition.date > legacyBoundary)
    .sort((a, b) => a.date.localeCompare(b.date) || a.projectId.localeCompare(b.projectId));

  // Chronicle is a frozen narrative: never rewrite or delete a stage sentence
  // that was already told. Dynamic stage history lives in stageTransitions();
  // here we only append genuinely missed time boundaries.
  for (const transition of transitions) {
    const id = `stage|${transition.date}|${transition.projectId}`;
    if (store.data.chronicle.some((line) => line.id === id)) continue;
    const project = store.project(transition.projectId);
    if (!project) continue;
    const change: StageChange = { project, from: transition.from, to: transition.to };
    changes.push(change);
    semanticChronicle(
      store,
      transition.date,
      [stageChangeEvent(change)],
      transition.to < transition.from ? 'recover' : 'quiet',
      id,
    );
  }
  return changes;
}

/** 记下今天的积压数（当天最后一次的值），供积压走势使用 */
function recordBacklogSnapshotImpl(store: Store) {
  const today = store.today();
  const n = backlog(store.data, today).total;
  const cur = store.data.snapshots.find((x) => x.date === today);
  if (cur?.backlog !== n) store.put('snapshots', { date: today, backlog: n });
}

export const settleDay = (...args: Parameters<typeof settleDayImpl>): ReturnType<typeof settleDayImpl> =>
  args[0].batch(() => settleDayImpl(...args));

export const archiveOldDays = (...args: Parameters<typeof archiveOldDaysImpl>): ReturnType<typeof archiveOldDaysImpl> =>
  args[0].batch(() => archiveOldDaysImpl(...args));

export const refreshStages = (...args: Parameters<typeof refreshStagesImpl>): ReturnType<typeof refreshStagesImpl> =>
  args[0].batch(() => refreshStagesImpl(...args));

export const recordBacklogSnapshot = (...args: Parameters<typeof recordBacklogSnapshotImpl>): ReturnType<typeof recordBacklogSnapshotImpl> =>
  args[0].batch(() => recordBacklogSnapshotImpl(...args));
