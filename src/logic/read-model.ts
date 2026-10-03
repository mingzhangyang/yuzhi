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

type TaskReplayFact = {
  date: ISODate;
  seq: number;
  operation?: OperationEvent;
  entry?: SettlementEntry;
};

interface TaskReplayFrame {
  state: MutableTaskState;
  /** Once a baseline is active, later create facts are compatibility noise. */
  baselineSeq: number;
  createdSeq: number;
}

export interface TaskReplayCut {
  date: ISODate;
  /** Include same-day facts through this seq. Omit to include the whole day. */
  seq?: number;
}

function taskReplayFacts(data: Data, task: Task): TaskReplayFact[] {
  const facts: TaskReplayFact[] = [];
  for (const event of data.operations) {
    if (event.taskId === task.id || (PROJECT_TASK_KINDS.has(event.kind) && event.projectId)) {
      facts.push({ date: event.date, seq: event.seq, operation: event });
    }
  }
  for (const entry of data.entries) {
    if (entry.itemType === 'task' && entry.itemId === task.id) facts.push({ date: entry.date, seq: entry.seq, entry });
  }
  return facts.sort((a, b) => a.seq - b.seq);
}

function initialReplayFrame(task: Task): TaskReplayFrame {
  return { state: defaultState(task), baselineSeq: 0, createdSeq: 0 };
}

function cloneReplayFrame(frame: TaskReplayFrame): TaskReplayFrame {
  return { state: { ...frame.state }, baselineSeq: frame.baselineSeq, createdSeq: frame.createdSeq };
}

function applyReplayFact(frame: TaskReplayFrame, data: Data, task: Task, fact: TaskReplayFact): TaskReplayFrame {
  const next = cloneReplayFrame(frame);
  const event = fact.operation;
  if (event?.kind === 'task-state-baseline' && event.taskId === task.id) {
    // A baseline is a checkpoint: it replaces every earlier task effect.
    next.state = baselineFrom(event, task);
    reconcileLegacyEntries(next.state, data, task.id, event);
    next.baselineSeq = event.seq;
    return next;
  }
  if (event?.kind === 'task-created' && event.taskId === task.id) {
    if (!next.baselineSeq && !next.createdSeq) {
      next.state = createdFrom(event);
      next.createdSeq = event.seq;
    }
    return next;
  }
  if (event) applyOperation(next.state, task.id, event);
  else if (fact.entry) applySettlement(next.state, fact.entry);
  return next;
}

function viewFrom(task: Task, state: MutableTaskState): TaskView {
  return {
    ...task,
    projectId: state.projectId,
    scheduledFor: state.scheduledFor,
    status: state.status,
    closedAt: state.closedAt,
    postponeCount: state.postponeCount,
  };
}

function factEligible(fact: TaskReplayFact, cut: TaskReplayCut): boolean {
  if (fact.date < cut.date) return true;
  if (fact.date > cut.date) return false;
  return cut.seq === undefined || fact.seq <= cut.seq;
}

/**
 * Canonical incremental replay index for one task.
 *
 * Facts are stored once in authoritative global-seq order. Historical cuts are
 * visited in semantic-date order; newly eligible facts activate in-place. If a
 * backfilled fact has an older seq, only the suffix from that seq is replayed.
 * Baselines reset the frame as checkpoints, preserving migration semantics.
 */
export function taskStatesAtCuts(data: Data, task: Task, cuts: TaskReplayCut[]): TaskView[] {
  if (!cuts.length) return [];
  const facts = taskReplayFacts(data, task);
  const indexedCuts = cuts.map((cut, index) => ({ cut, index })).sort((a, b) =>
    a.cut.date.localeCompare(b.cut.date) ||
    (a.cut.seq ?? Number.MAX_SAFE_INTEGER) - (b.cut.seq ?? Number.MAX_SAFE_INTEGER) ||
    a.index - b.index,
  );
  const activationOrder = facts.map((fact, index) => ({ fact, index })).sort((a, b) =>
    a.fact.date.localeCompare(b.fact.date) || a.fact.seq - b.fact.seq,
  );
  const active = new Array<boolean>(facts.length).fill(false);
  const after = new Array<TaskReplayFrame>(facts.length);
  const result = new Array<TaskView>(cuts.length);
  let activationIndex = 0;
  let initialized = false;

  for (const { cut, index: outputIndex } of indexedCuts) {
    let earliestChanged = facts.length;
    while (activationIndex < activationOrder.length && factEligible(activationOrder[activationIndex].fact, cut)) {
      const factIndex = activationOrder[activationIndex++].index;
      if (!active[factIndex]) {
        active[factIndex] = true;
        earliestChanged = Math.min(earliestChanged, factIndex);
      }
    }
    if (!initialized) {
      earliestChanged = 0;
      initialized = true;
    }
    if (earliestChanged < facts.length) {
      let frame = earliestChanged === 0 ? initialReplayFrame(task) : cloneReplayFrame(after[earliestChanged - 1]);
      for (let i = earliestChanged; i < facts.length; i++) {
        if (active[i]) frame = applyReplayFact(frame, data, task, facts[i]);
        after[i] = cloneReplayFrame(frame);
      }
    }
    const frame = facts.length ? after[facts.length - 1] ?? initialReplayFrame(task) : initialReplayFrame(task);
    result[outputIndex] = viewFrom(task, frame.state);
  }
  return result;
}

export function taskState(data: Data, task: Task, throughDate?: ISODate): TaskView {
  if (throughDate) return taskStatesAtCuts(data, task, [{ date: throughDate }])[0];
  const facts = taskReplayFacts(data, task);
  let frame = initialReplayFrame(task);
  for (const fact of facts) frame = applyReplayFact(frame, data, task, fact);
  return viewFrom(task, frame.state);
}

export function taskStatesForDates(data: Data, task: Task, dates: ISODate[]): Map<ISODate, TaskView> {
  const orderedDates = [...new Set(dates)].filter((date) => date >= task.createdAt).sort();
  const states = taskStatesAtCuts(data, task, orderedDates.map((date) => ({ date })));
  return new Map(orderedDates.map((date, index) => [date, states[index]] as const));
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
