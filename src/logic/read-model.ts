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

function createdFrom(event: OperationEvent, fallback: Task): MutableTaskState {
  return {
    projectId: event.projectId,
    scheduledFor: text(event.payload?.scheduledFor),
    status: 'open',
    closedAt: undefined,
    postponeCount: 0,
  };
}

function defaultState(task: Task): MutableTaskState {
  // For current v3 data this is the task's creation snapshot. For legacy
  // history before the v3 baseline, "open + zero postpones" is the safest
  // replay origin and avoids leaking a later derived state backwards.
  return {
    projectId: task.projectId,
    scheduledFor: task.scheduledFor,
    status: 'open',
    closedAt: undefined,
    postponeCount: 0,
  };
}

function droppedIds(event: OperationEvent): string[] {
  const v = event.payload?.droppedTaskIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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
      if (
        state.status === 'open' &&
        (droppedIds(event).includes(taskId) || (event.payload?.droppedTaskIds === undefined && state.projectId === event.projectId))
      ) {
        state.status = 'dropped';
        state.closedAt = event.date;
      }
      return;
    case 'project-completed':
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

/**
 * Replays the effective task state from one migration/creation baseline plus
 * ordered operation + settlement facts. Rejudging a settlement preserves its
 * original seq, so later manual operations remain later in the replay.
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
    baseSeq = baselines[0].seq;
  } else if (created) {
    state = createdFrom(created, task);
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
