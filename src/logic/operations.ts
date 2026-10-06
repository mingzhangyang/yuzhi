import type { Data, LifeEntry, LifeKind, LifeSubjectType, OperationEvent, OperationLifeSnapshot, SettlementEntry, SkipReason } from '../types';
import { CHORES, LOCAL_CALENDAR_SOURCE_ID } from '../types';
import type { LifeHistoryEventKey } from '../history-types';
import { historyEvent, isLifeHistoryEvent } from '../history-types';
import { formatHistoryEvent } from '../history';

const LIFE_KINDS = new Set<LifeKind>([
  'start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete',
]);
const REASONS = new Set<SkipReason>(['interrupted', 'no_energy', 'not_important', 'postponed']);

const SKIP_HISTORY: Record<SkipReason, LifeHistoryEventKey> = {
  interrupted: 'history.life.settlementSkippedInterrupted',
  no_energy: 'history.life.settlementSkippedNoEnergy',
  not_important: 'history.life.settlementSkippedNotImportant',
  postponed: 'history.life.settlementSkippedPostponed',
};

function settlementHistoryEvent(entry: SettlementEntry) {
  if (entry.outcome === 'done') {
    return historyEvent(
      entry.itemType === 'task' ? 'history.life.settlementTaskDone' : 'history.life.settlementEventDone',
      { title: entry.title },
    );
  }
  if (entry.outcome === 'partial') return historyEvent('history.life.settlementPartial', { title: entry.title });
  return historyEvent(entry.reason ? SKIP_HISTORY[entry.reason] : 'history.life.settlementSkipped', { title: entry.title });
}

export function settlementLifeEntries(data: Data): LifeEntry[] {
  const localScheduleIds = new Set(
    data.events
      .filter((event) => event.sourceId === LOCAL_CALENDAR_SOURCE_ID)
      .map((event) => event.id),
  );
  return data.entries.map((entry) => {
    const taskId = entry.itemType === 'task' ? entry.itemId : undefined;
    const localSchedule = entry.itemType === 'event' && localScheduleIds.has(entry.itemId);
    const subjectType: LifeSubjectType | undefined = taskId ? 'task' : localSchedule ? 'schedule' : undefined;
    const subjectId = subjectType ? entry.itemId : undefined;
    const event = settlementHistoryEvent(entry);
    return {
      id: `l|${entry.id}`,
      date: entry.date,
      factSeq: entry.seq,
      projectId: entry.projectId === CHORES ? undefined : entry.projectId,
      taskId,
      subjectType,
      subjectId,
      kind: entry.outcome === 'done' ? 'done' : entry.outcome === 'partial' ? 'partial' : 'skip',
      reason: entry.outcome === 'skipped' ? entry.reason : undefined,
      text: formatHistoryEvent(event, 'zh-CN'),
      event,
    };
  });
}

/** Provisional synchronous order for the tab-local model. IdbPersistence reserves the authoritative shared seq atomically before first persistence. */
export function nextFactSeq(data: Data): number {
  let max = 0;
  for (const event of data.operations) if (event.seq > max) max = event.seq;
  for (const entry of data.entries) if (entry.seq > max) max = entry.seq;
  return max + 1;
}

function snapshotsOf(event: OperationEvent): OperationLifeSnapshot[] {
  const raw = (event.payload as { life?: unknown } | undefined)?.life;
  if (!Array.isArray(raw)) return [];
  const out: OperationLifeSnapshot[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const o = value as Record<string, unknown>;
    if (typeof o.text !== 'string' || typeof o.kind !== 'string' || !LIFE_KINDS.has(o.kind as LifeKind)) continue;
    if (o.projectId !== undefined && typeof o.projectId !== 'string') continue;
    if (o.taskId !== undefined && typeof o.taskId !== 'string') continue;
    if (o.subjectType !== undefined && !['project', 'task', 'diary', 'schedule'].includes(String(o.subjectType))) continue;
    if (o.subjectId !== undefined && typeof o.subjectId !== 'string') continue;
    if ((o.subjectType === undefined) !== (o.subjectId === undefined)) continue;
    if (o.reason !== undefined && (typeof o.reason !== 'string' || !REASONS.has(o.reason as SkipReason))) continue;
    if (o.event !== undefined && !isLifeHistoryEvent(o.event)) continue;
    out.push({
      projectId: o.projectId as string | undefined,
      taskId: o.taskId as string | undefined,
      subjectType: o.subjectType as LifeSubjectType | undefined,
      subjectId: o.subjectId as string | undefined,
      text: o.text,
      event: isLifeHistoryEvent(o.event) ? o.event : undefined,
      kind: o.kind as LifeKind,
      reason: o.reason as SkipReason | undefined,
    });
  }
  return out;
}

/** 把 operation facts 投影成一生之书行。一个 task-moved 可以同时投影到旧村落和新村落。 */
export function operationLifeEntries(event: OperationEvent): LifeEntry[] {
  const order = String(event.seq).padStart(12, '0');
  const syntheticBaseline = event.payload?.source === 'migration'
    && (event.kind === 'diary-created' || event.kind === 'schedule-created');
  return snapshotsOf(event).map((snapshot, index) => {
    const subjectType = snapshot.subjectType ?? (snapshot.taskId ? 'task' : snapshot.projectId ? 'project' : undefined);
    const subjectId = snapshot.subjectId ?? (snapshot.taskId || snapshot.projectId);
    return {
      id: `oplife|${order}|${event.id}|${index}`,
      date: event.date,
      // v6 baseline facts describe a state that existed before migration.
      // They were appended to the immutable stream, so their persisted seq is
      // intentionally not used as historical occurrence order in the read model.
      factSeq: syntheticBaseline ? undefined : event.seq,
      baseline: syntheticBaseline || undefined,
      ...snapshot,
      subjectType,
      subjectId,
    };
  });
}

/**
 * 一生之书 read model：结算事实、主动操作事实和阶段重放结果合并展示。
 * 旧版本 life 行会在迁移阶段转成带快照的 operation，不再保留第二份业务事实。
 */
export function compareLifeEntries(a: LifeEntry, b: LifeEntry): number {
  if (!!a.baseline !== !!b.baseline) return a.baseline ? -1 : 1;
  const byDate = a.date.localeCompare(b.date);
  if (byDate) return byDate;
  if (a.factSeq !== undefined && b.factSeq !== undefined && a.factSeq !== b.factSeq) return a.factSeq - b.factSeq;
  if (a.factSeq !== undefined && b.factSeq === undefined) return 1;
  if (a.factSeq === undefined && b.factSeq !== undefined) return -1;
  return a.id.localeCompare(b.id);
}

export function lifeEntries(data: Data, derivedStageEntries: LifeEntry[] = []): LifeEntry[] {
  const operations = data.operations
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.id.localeCompare(b.id));
  return [
    ...operations.flatMap(operationLifeEntries),
    ...settlementLifeEntries(data),
    ...derivedStageEntries,
  ].sort(compareLifeEntries);
}
