import type { Data, Interruption, ISODate, OperationEvent, Project, SettlementEntry, Task } from '../types';
import { addDays } from '../lib/date';

export type TaskView = Task & { postponeCount: number };

interface MutableTaskState {
  projectId?: string;
  scheduledFor?: ISODate;
  status: Task['status'];
  closedAt?: ISODate;
  postponeCount: number;
}

const PROJECT_TASK_KINDS = new Set([
  'project-restarted',
  'project-trimmed',
  'project-closed',
  'project-completed',
]);

const beforeOrOn = (date: ISODate, through?: ISODate) => !through || date <= through;

function text(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function nonNegativeInt(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;
}

function baselineFrom(event: OperationEvent, fallback: Task): MutableTaskState {
  const p = event.payload ?? {};
  const status = p.status === 'done' || p.status === 'dropped' || p.status === 'open' ? p.status : fallback.status;
  return {
    projectId: text(p.projectId) ?? event.projectId,
    scheduledFor: text(p.scheduledFor),
    status,
    closedAt: text(p.closedAt),
    postponeCount: nonNegativeInt(p.postponeCount),
  };
}

function createdFrom(event: OperationEvent): MutableTaskState {
  return {
    projectId: event.projectId,
    scheduledFor: text(event.payload?.scheduledFor),
    status: 'open',
    closedAt: undefined,
    postponeCount: 0,
  };
}

function defaultState(task: Task): MutableTaskState {
  return {
    projectId: task.projectId,
    scheduledFor: task.scheduledFor,
    status: 'open',
    closedAt: undefined,
    postponeCount: 0,
  };
}

function applyOperation(state: MutableTaskState, taskId: string, event: OperationEvent) {
  switch (event.kind) {
    case 'task-arranged':
      if (event.taskId !== taskId) return;
      state.projectId = event.projectId;
      state.scheduledFor = text(event.payload?.scheduledFor);
      return;
    case 'task-rescheduled':
      if (event.taskId !== taskId) return;
      state.scheduledFor = text(event.payload?.toDate);
      return;
    case 'task-moved':
      if (event.taskId !== taskId) return;
      state.projectId = text(event.payload?.toProjectId);
      if (!state.projectId) state.scheduledFor = undefined;
      return;
    case 'task-dropped':
      if (event.taskId !== taskId) return;
      state.status = 'dropped';
      state.closedAt = event.date;
      return;
    case 'project-restarted':
    case 'project-trimmed':
      if (state.projectId === event.projectId && state.status === 'open') state.postponeCount = 0;
      return;
    case 'project-closed':
    case 'project-completed':
      // Close whatever is effectively open at this replay position. A snapshot
      // of IDs from the original close cannot anticipate an earlier rejudgment.
      if (state.status === 'open' && state.projectId === event.projectId) {
        state.status = 'dropped';
        state.closedAt = event.date;
      }
      return;
    default:
      return;
  }
}

function applySettlement(state: MutableTaskState, entry: SettlementEntry) {
  if (entry.outcome === 'done') {
    state.status = 'done';
    state.closedAt = entry.date;
    return;
  }
  if (entry.outcome === 'partial') {
    state.status = 'open';
    state.closedAt = undefined;
    state.scheduledFor = addDays(entry.date, 1);
    return;
  }
  if (entry.reason === 'postponed') {
    state.status = 'open';
    state.closedAt = undefined;
    state.scheduledFor = addDays(entry.date, 1);
    state.postponeCount += 1;
    return;
  }
  if (entry.reason === 'not_important') {
    state.status = 'dropped';
    state.closedAt = entry.date;
    return;
  }
  state.status = 'open';
  state.closedAt = undefined;
  state.scheduledFor = entry.date;
}

function legacyEntriesOf(event: OperationEvent): SettlementEntry[] {
  const raw = event.payload?.legacyEntries;
  if (!Array.isArray(raw)) return [];
  const out: SettlementEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      typeof row.seq !== 'number' ||
      !Number.isInteger(row.seq) ||
      typeof row.date !== 'string' ||
      row.itemType !== 'task' ||
      typeof row.itemId !== 'string' ||
      (row.outcome !== 'done' && row.outcome !== 'partial' && row.outcome !== 'skipped') ||
      typeof row.title !== 'string'
    ) continue;
    out.push(row as unknown as SettlementEntry);
  }
  return out;
}

function sameSettlement(a: SettlementEntry | undefined, b: SettlementEntry): boolean {
  return !!a &&
    a.date === b.date &&
    a.outcome === b.outcome &&
    a.reason === b.reason &&
    a.projectId === b.projectId;
}

function reconcileLegacyEntries(
  state: MutableTaskState,
  data: Data,
  taskId: string,
  baseline: OperationEvent,
) {
  const originals = legacyEntriesOf(baseline).slice().sort((a, b) => b.seq - a.seq);
  if (!originals.length) return;
  const currentById = new Map(
    data.entries
      .filter((entry) => entry.itemType === 'task' && entry.itemId === taskId && entry.seq < baseline.seq)
      .map((entry) => [entry.id, entry] as const),
  );

  for (const original of originals) {
    const current = currentById.get(original.id);
    if (sameSettlement(current, original)) continue;

    const laterEntries = data.entries.filter(
      (entry) =>
        entry.itemType === 'task' &&
        entry.itemId === taskId &&
        entry.seq > original.seq &&
        entry.seq < baseline.seq,
    );
    const laterOps = data.operations.filter(
      (event) =>
        event.seq > original.seq &&
        event.seq < baseline.seq &&
        (event.taskId === taskId || (PROJECT_TASK_KINDS.has(event.kind) && event.projectId)),
    );

    const statusOverridden =
      laterEntries.length > 0 ||
      laterOps.some((event) =>
        event.kind === 'task-dropped' ||
        event.kind === 'project-closed' ||
        event.kind === 'project-completed'
      );
    const scheduleOverridden =
      laterEntries.some((entry) => entry.outcome === 'partial' || (entry.outcome === 'skipped' && entry.reason !== 'not_important')) ||
      laterOps.some((event) =>
        event.kind === 'task-rescheduled' ||
        event.kind === 'task-arranged' ||
        (event.kind === 'task-moved' && !text(event.payload?.toProjectId))
      );
    const postponeReset =
      laterOps.some((event) =>
        (event.kind === 'project-restarted' || event.kind === 'project-trimmed') &&
        event.projectId === original.projectId
      );

    // Undo the original v2 side effect, but never overwrite a later fact that
    // already superseded the same field.
    if (!statusOverridden) {
      state.status = 'open';
      state.closedAt = undefined;
    }
    if (!scheduleOverridden) state.scheduledFor = original.date;
    if (original.reason === 'postponed' && !postponeReset) {
      state.postponeCount = Math.max(0, state.postponeCount - 1);
    }

    if (!current) continue;

    if (!statusOverridden) {
      if (current.outcome === 'done') {
        state.status = 'done';
        state.closedAt = current.date;
      } else if (current.reason === 'not_important') {
        state.status = 'dropped';
        state.closedAt = current.date;
      } else {
        state.status = 'open';
        state.closedAt = undefined;
      }
    }
    if (!scheduleOverridden) {
      if (current.outcome === 'partial' || current.reason === 'postponed') state.scheduledFor = addDays(current.date, 1);
      else if (current.outcome === 'skipped' && current.reason !== 'not_important') state.scheduledFor = current.date;
    }
    if (current.reason === 'postponed' && !postponeReset) state.postponeCount += 1;
  }
}

/**
 * Replays effective task state from operation + settlement facts. The v3
 * compatibility baseline contains the exact v2 state plus original settlement
 * snapshots; if an old settlement is corrected/deleted, only its baked-in
 * effect is reconciled, while later manual facts keep precedence.
 */
export function taskState(data: Data, task: Task, throughDate?: ISODate): TaskView {
  const eligible = (event: OperationEvent) => event.taskId === task.id && beforeOrOn(event.date, throughDate);
  const baselines = data.operations
    .filter((event) => event.kind === 'task-state-baseline' && eligible(event))
    .sort((a, b) => b.seq - a.seq);
  const created = data.operations
    .filter((event) => event.kind === 'task-created' && eligible(event))
    .sort((a, b) => a.seq - b.seq)[0];

  let state = defaultState(task);
  let baseSeq = 0;
  if (baselines[0]) {
    state = baselineFrom(baselines[0], task);
    reconcileLegacyEntries(state, data, task.id, baselines[0]);
    baseSeq = baselines[0].seq;
  } else if (created) {
    state = createdFrom(created);
    baseSeq = created.seq;
  }

  const facts: Array<{ seq: number; operation?: OperationEvent; entry?: SettlementEntry }> = [];
  for (const event of data.operations) {
    if (event.seq <= baseSeq || !beforeOrOn(event.date, throughDate)) continue;
    if (event.taskId === task.id || (PROJECT_TASK_KINDS.has(event.kind) && event.projectId)) {
      facts.push({ seq: event.seq, operation: event });
    }
  }
  for (const entry of data.entries) {
    if (entry.seq <= baseSeq || entry.itemType !== 'task' || entry.itemId !== task.id || !beforeOrOn(entry.date, throughDate)) continue;
    facts.push({ seq: entry.seq, entry });
  }
  facts.sort((a, b) => a.seq - b.seq);

  for (const fact of facts) {
    if (fact.operation) applyOperation(state, task.id, fact.operation);
    else if (fact.entry) applySettlement(state, fact.entry);
  }

  return {
    ...task,
    projectId: state.projectId,
    scheduledFor: state.scheduledFor,
    status: state.status,
    closedAt: state.closedAt,
    postponeCount: state.postponeCount,
  };
}

export function taskStates(data: Data, throughDate?: ISODate): TaskView[] {
  return data.tasks.map((task) => taskState(data, task, throughDate));
}

export function lastProgressAt(data: Data, projectId: string): ISODate | undefined {
  let last: ISODate | undefined;
  for (const entry of data.entries) {
    if (entry.projectId !== projectId || entry.outcome === 'skipped') continue;
    if (!last || entry.date > last) last = entry.date;
  }
  return last;
}

export function interruptions(data: Data): Interruption[] {
  return data.entries
    .filter((entry) => entry.reason === 'interrupted')
    .map((entry) => ({
      id: `i|${entry.id}`,
      date: entry.date,
      itemType: entry.itemType,
      itemId: entry.itemId,
      title: entry.title,
      projectId: entry.projectId,
    }));
}

export function projectTasks(data: Data, project: Project | string, throughDate?: ISODate): TaskView[] {
  const id = typeof project === 'string' ? project : project.id;
  return taskStates(data, throughDate).filter((task) => task.projectId === id);
}
