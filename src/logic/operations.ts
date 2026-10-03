import type { Data, LifeEntry, LifeKind, OperationEvent, OperationLifeSnapshot, SkipReason } from '../types';

const LIFE_KINDS = new Set<LifeKind>([
  'start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete',
]);
const REASONS = new Set<SkipReason>(['interrupted', 'no_energy', 'not_important', 'postponed']);

const REASON_TEXT: Record<SkipReason, string> = {
  interrupted: '被打断',
  no_energy: '没精力',
  not_important: '不重要了',
  postponed: '推到明天',
};

export function settlementLifeEntries(data: Data): LifeEntry[] {
  return data.entries.map((entry) => {
    const title = `「${entry.title}」`;
    const taskId = entry.itemType === 'task' ? entry.itemId : undefined;
    if (entry.outcome === 'done') {
      return {
        id: `l|${entry.id}`,
        date: entry.date,
        projectId: entry.projectId,
        taskId,
        kind: 'done',
        text: entry.itemType === 'task' ? `完成了${title}` : `${title}做了`,
      };
    }
    if (entry.outcome === 'partial') {
      return {
        id: `l|${entry.id}`,
        date: entry.date,
        projectId: entry.projectId,
        taskId,
        kind: 'partial',
        text: `${title}做了一部分`,
      };
    }
    return {
      id: `l|${entry.id}`,
      date: entry.date,
      projectId: entry.projectId,
      taskId,
      kind: 'skip',
      reason: entry.reason,
      text: `${title}没做${entry.reason ? `：${REASON_TEXT[entry.reason]}` : ''}`,
    };
  });
}

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
    ...snapshot,
  }));
}

/**
 * 一生之书 read model：结算 / 阶段兼容行仍来自 life；主动操作来自 operations。
 * v1 迁移出的 operation 保留 legacyLifeId，因此旧 life 行不会重复显示。
 */
export function lifeEntries(data: Data, derivedStageEntries: LifeEntry[] = []): LifeEntry[] {
  const migrated = new Set<string>();
  for (const event of data.operations) {
    const id = event.payload?.legacyLifeId;
    if (typeof id === 'string') migrated.add(id);
  }
  const settlementIds = new Set(data.entries.map((entry) => `l|${entry.id}`));
  const compat = data.life.filter(
    (entry) => !migrated.has(entry.id) && !settlementIds.has(entry.id) && entry.kind !== 'stage',
  );
  return [
    ...compat,
    ...data.operations.flatMap(operationLifeEntries),
    ...settlementLifeEntries(data),
    ...derivedStageEntries,
  ];
}
