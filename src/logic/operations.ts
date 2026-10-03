import type { Data, LifeEntry, LifeKind, OperationEvent, OperationLifeSnapshot, SkipReason } from '../types';

const LIFE_KINDS = new Set<LifeKind>([
  'start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete',
]);
const REASONS = new Set<SkipReason>(['interrupted', 'no_energy', 'not_important', 'postponed']);

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
    if (o.reason !== undefined && (typeof o.reason !== 'string' || !REASONS.has(o.reason as SkipReason))) continue;
    out.push({
      projectId: o.projectId as string | undefined,
      taskId: o.taskId as string | undefined,
      text: o.text,
      kind: o.kind as LifeKind,
      reason: o.reason as SkipReason | undefined,
    });
  }
  return out;
}

/** 把 operation facts 投影成一生之书行。一个 task-moved 可以同时投影到旧村落和新村落。 */
export function operationLifeEntries(event: OperationEvent): LifeEntry[] {
  const order = String(event.seq).padStart(12, '0');
  return snapshotsOf(event).map((snapshot, index) => ({
    id: `oplife|${order}|${event.id}|${index}`,
    date: event.date,
    factSeq: event.seq,
    ...snapshot,
  }));
}

/**
 * 一生之书 read model：结算 / 阶段兼容行仍来自 life；主动操作来自 operations。
 * v1 迁移出的 operation 保留 legacyLifeId，因此旧 life 行不会重复显示。
 */
export function compareLifeEntries(a: LifeEntry, b: LifeEntry): number {
  const byDate = a.date.localeCompare(b.date);
  if (byDate) return byDate;
  if (a.factSeq !== undefined && b.factSeq !== undefined && a.factSeq !== b.factSeq) return a.factSeq - b.factSeq;
  if (a.factSeq !== undefined && b.factSeq === undefined) return 1;
  if (a.factSeq === undefined && b.factSeq !== undefined) return -1;
  return a.id.localeCompare(b.id);
}

export function lifeEntries(data: Data): LifeEntry[] {
  const migrated = new Set<string>();
  for (const event of data.operations) {
    const id = event.payload?.legacyLifeId;
    if (typeof id === 'string') migrated.add(id);
  }
  const settlementSeq = new Map(data.entries.map((entry) => [`l|${entry.id}`, entry.seq] as const));
  const compat = data.life
    .filter((entry) => !migrated.has(entry.id))
    .map((entry) => {
      const factSeq = settlementSeq.get(entry.id);
      return factSeq === undefined ? entry : { ...entry, factSeq };
    });
  const operations = data.operations
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.id.localeCompare(b.id));
  return [...compat, ...operations.flatMap(operationLifeEntries)].sort(compareLifeEntries);
}
