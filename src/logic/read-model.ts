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
      // Project completion emits per-task drop facts for tasks that were open
      // at that moment. If an earlier settlement is later rejudged to done,
      // this stale compatibility fact must not override the corrected state.
      if (event.payload?.source === 'project-completed' && state.status !== 'open') return;
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
  const originals = legacyEntriesOf(baseline).slice().sort((a, b) => a.seq - b.seq);
  if (!originals.length) return;
  const currentEntries = data.entries
    .filter((entry) => entry.itemType === 'task' && entry.itemId === taskId && entry.seq < baseline.seq)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry] as const));
  const firstChanged = originals.find((original) => !sameSettlement(currentById.get(original.id), original));
  if (!firstChanged) return;

  const operations = data.operations
    .filter(
      (event) =>
        event.seq > firstChanged.seq &&
        event.seq < baseline.seq &&
        (event.taskId === taskId || (PROJECT_TASK_KINDS.has(event.kind) && event.projectId)),
    )
    .map((operation) => ({ seq: operation.seq, operation }));

  const replay = (entries: SettlementEntry[], postponeCount: number): MutableTaskState => {
    const replayed: MutableTaskState = {
      projectId: firstChanged.projectId,
      scheduledFor: firstChanged.date,
      status: 'open',
      closedAt: undefined,
      postponeCount,
    };
    const facts: Array<{ seq: number; operation?: OperationEvent; entry?: SettlementEntry }> = [
      ...operations,
      ...entries
        .filter((entry) => entry.seq >= firstChanged.seq && entry.seq < baseline.seq)
        .map((entry) => ({ seq: entry.seq, entry })),
    ].sort((a, b) => a.seq - b.seq);

    for (const fact of facts) {
      if (fact.operation) applyOperation(replayed, taskId, fact.operation);
      else if (fact.entry) applySettlement(replayed, fact.entry);
    }
    return replayed;
  };

  // The baseline is the exact v2 end state. Replaying the original suffix and
  // the corrected suffix from the same pre-settlement state tells us which
  // final fields truly change. This also preserves the conditional semantics
  // of project close/restart facts instead of treating their mere presence as
  // an unconditional override.
  const oldFromZero = replay(originals, 0);
  const oldFromOne = replay(originals, 1);
  const carriesPriorPostpones = oldFromOne.postponeCount === oldFromZero.postponeCount + 1;
  const inferredPostpones = carriesPriorPostpones
    ? Math.max(0, state.postponeCount - oldFromZero.postponeCount)
    : 0;
  const oldFinal = inferredPostpones === 0 ? oldFromZero : replay(originals, inferredPostpones);
  const newFinal = replay(currentEntries, inferredPostpones);

  // Only replace fields whose baseline value is explained by the old replay.
  // If some legacy behavior outside the structured fact stream produced a
  // different value, keep that compatibility value rather than clobbering it.
  if (state.projectId === oldFinal.projectId) state.projectId = newFinal.projectId;
  if (state.scheduledFor === oldFinal.scheduledFor) state.scheduledFor = newFinal.scheduledFor;
  if (state.status === oldFinal.status && state.closedAt === oldFinal.closedAt) {
    state.status = newFinal.status;
    state.closedAt = newFinal.closedAt;
  }
  if (state.postponeCount === oldFinal.postponeCount) state.postponeCount = newFinal.postponeCount;
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

/**
 * Replays one task at multiple historical dates from a task-local fact slice.
 * Each snapshot delegates precedence to taskState(): semantic date decides
 * eligibility, while the shared monotonic seq remains the authoritative order.
 * This avoids rescanning unrelated tasks/projects for every candidate date.
 */
export function taskStatesForDates(data: Data, task: Task, dates: ISODate[]): Map<ISODate, TaskView> {
  const orderedDates = [...new Set(dates)]
    .filter((date) => date >= task.createdAt)
    .sort();
  const out = new Map<ISODate, TaskView>();
  if (!orderedDates.length) return out;

  const lastDate = orderedDates[orderedDates.length - 1];
  const taskData: Data = {
    ...data,
    tasks: [task],
    entries: data.entries.filter(
      (entry) => entry.itemType === 'task' && entry.itemId === task.id && entry.date <= lastDate,
    ),
    operations: data.operations.filter(
      (event) =>
        event.date <= lastDate &&
        (event.taskId === task.id || (PROJECT_TASK_KINDS.has(event.kind) && event.projectId)),
    ),
  };

  for (const date of orderedDates) out.set(date, taskState(taskData, task, date));
  return out;
}

export function taskStates(data: Data, throughDate?: ISODate): TaskView[] {
  return data.tasks
    .filter((task) => !throughDate || task.createdAt <= throughDate)
    .map((task) => taskState(data, task, throughDate));
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
