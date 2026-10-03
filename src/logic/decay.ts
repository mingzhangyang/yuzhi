import type { Data, ISODate, LifeEntry, OperationEvent, Project, SettlementEntry } from '../types';
import { addDays, dateOfStamp } from '../lib/date';
import { POSTPONE_PENALTY_AT, STAGE_NAMES, STAGE_START, TRIM_TO_NEGLECT, type Stage } from './config';
import { dayStatusFn, type DayStatus } from './days';
import { taskStates } from './read-model';

export interface VillageState {
  neglect: number;
  baseStage: Stage;
  postponePenalty: boolean;
  stage: Stage;
  daysSinceProgress: number;
}

export interface StageTransition {
  id: string;
  date: ISODate;
  projectId: string;
  from: Stage;
  to: Stage;
  source: 'time' | 'facts';
}

export function stageOfNeglect(n: number): Stage {
  if (n >= STAGE_START[3]) return 3;
  if (n >= STAGE_START[2]) return 2;
  if (n >= STAGE_START[1]) return 1;
  return 0;
}

export function recoverOne(neglect: number): number {
  const s = stageOfNeglect(neglect);
  return s === 0 ? 0 : STAGE_START[s - 1];
}

export function dayEffect(entries: SettlementEntry[]): 'progress' | 'freeze' | 'idle' {
  if (entries.some((e) => e.outcome === 'done' || e.outcome === 'partial')) return 'progress';
  if (entries.length && entries.every((e) => e.outcome === 'skipped' && (e.reason === 'no_energy' || e.reason === 'not_important'))) return 'freeze';
  return 'idle';
}

function stageWithPenalty(neglect: number, heavy: boolean): Stage {
  return Math.min(3, stageOfNeglect(neglect) + (heavy ? 1 : 0)) as Stage;
}

type ProjectDayFact = { seq: number; operation?: OperationEvent; entry?: SettlementEntry };

function orderedProjectDayFacts(entries: SettlementEntry[], operations: OperationEvent[]): ProjectDayFact[] {
  return [
    ...entries.map((entry) => ({ seq: entry.seq, entry })),
    ...operations.map((operation) => ({ seq: operation.seq, operation })),
  ].sort((a, b) => a.seq - b.seq);
}

/**
 * Replay one project to a date. Pending/unrecorded days are inert unless an
 * explicit progress fact exists. Today is included so markTaskDone() can
 * recover a village immediately; an otherwise empty current day is not charged
 * before it has finished.
 */
export function computeVillage(
  project: Project,
  entriesByDate: Map<ISODate, SettlementEntry[]>,
  statusOf: (d: ISODate) => DayStatus,
  hasHeavyPostpone: boolean,
  today: ISODate,
  operationsByDate: Map<ISODate, OperationEvent[]> = new Map(),
): VillageState {
  const resets = (project.resets ?? []).filter((reset) => reset.date <= today).slice().sort((a, b) => a.date.localeCompare(b.date));
  let neglect = 0;
  let start = project.createdAt;
  const last = resets[resets.length - 1];
  if (last && last.date >= start) {
    start = last.date;
    neglect = last.neglect;
  }

  let active = true;
  let sinceProgress = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const st = statusOf(d);
    const rows = (entriesByDate.get(d) ?? []).slice().sort((a, b) => a.seq - b.seq);
    const operations = operationsByDate.get(d) ?? [];
    const hasResetOperation = operations.some((event) => event.kind === 'project-restarted' || event.kind === 'project-trimmed');
    const legacyResets = hasResetOperation ? [] : resets.filter((reset) => reset.date === d);
    let resetToday = false;
    for (const reset of legacyResets) {
      neglect = reset.neglect;
      sinceProgress = 0;
      resetToday = true;
    }

    const activeRows: SettlementEntry[] = [];
    let progressApplied = false;
    for (const fact of orderedProjectDayFacts(rows, operations)) {
      const event = fact.operation;
      if (event) {
        if (event.kind === 'project-closed' || event.kind === 'project-completed') {
          active = false;
        } else if (event.kind === 'project-restarted') {
          active = true;
          neglect = 0;
          sinceProgress = 0;
          resetToday = true;
        } else if (event.kind === 'project-trimmed') {
          active = true;
          neglect = TRIM_TO_NEGLECT;
          sinceProgress = 0;
          resetToday = true;
        } else if (event.kind === 'project-created') {
          active = true;
        }
        continue;
      }

      const entry = fact.entry!;
      if (!active) continue;
      activeRows.push(entry);
      if (!progressApplied && (entry.outcome === 'done' || entry.outcome === 'partial')) {
        neglect = recoverOne(neglect);
        sinceProgress = 0;
        progressApplied = true;
      }
    }

    if (!operations.length && (project.doneAt === d || project.closedAt === d)) active = false;
    if (!active) continue;

    const eff = activeRows.length ? dayEffect(activeRows) : 'idle';
    if (progressApplied) continue;
    if (d === today && st === 'empty' && activeRows.length === 0) continue;
    if ((st === 'pending' || st === 'unrecorded') && eff !== 'progress') continue;
    if (eff === 'idle' && d !== project.createdAt && !resetToday) {
      neglect += 1;
      sinceProgress += 1;
    }
  }
  const baseStage = stageOfNeglect(neglect);
  const stage = stageWithPenalty(neglect, hasHeavyPostpone);
  return { neglect, baseStage, postponePenalty: hasHeavyPostpone, stage, daysSinceProgress: sinceProgress };
}

export function computeAllVillages(data: Data, today: ISODate): Map<string, VillageState> {
  const statusOf = dayStatusFn(data, today);
  const byProject = new Map<string, Map<ISODate, SettlementEntry[]>>();
  for (const entry of data.entries) {
    if (!entry.projectId) continue;
    let days = byProject.get(entry.projectId);
    if (!days) byProject.set(entry.projectId, (days = new Map()));
    const rows = days.get(entry.date);
    if (rows) rows.push(entry);
    else days.set(entry.date, [entry]);
  }
  const tasks = taskStates(data, today);
  const operations = projectOperations(data);
  const out = new Map<string, VillageState>();
  for (const project of data.projects) {
    if (project.status !== 'active') continue;
    const heavy = tasks.some(
      (task) => task.projectId === project.id && task.status === 'open' && task.postponeCount >= POSTPONE_PENALTY_AT,
    );
    out.set(project.id, computeVillage(project, byProject.get(project.id) ?? new Map(), statusOf, heavy, today, operations.get(project.id) ?? new Map()));
  }
  return out;
}

const timelineCache = new WeakMap<Data, { revision: number; today: ISODate; transitions: StageTransition[] }>();
const decayRevision = new WeakMap<Data, number>();

export function markDecayDataChanged(data: Data): void {
  decayRevision.set(data, (decayRevision.get(data) ?? 0) + 1);
}

function projectEntries(data: Data): Map<string, Map<ISODate, SettlementEntry[]>> {
  const out = new Map<string, Map<ISODate, SettlementEntry[]>>();
  for (const entry of data.entries) {
    if (!entry.projectId) continue;
    let days = out.get(entry.projectId);
    if (!days) out.set(entry.projectId, (days = new Map()));
    const rows = days.get(entry.date);
    if (rows) rows.push(entry);
    else days.set(entry.date, [entry]);
  }
  return out;
}

function projectOperations(data: Data): Map<string, Map<ISODate, typeof data.operations>> {
  const out = new Map<string, Map<ISODate, typeof data.operations>>();
  for (const event of data.operations) {
    if (!event.projectId) continue;
    if (!['project-created', 'project-restarted', 'project-trimmed', 'project-closed', 'project-completed'].includes(event.kind)) continue;
    let days = out.get(event.projectId);
    if (!days) out.set(event.projectId, (days = new Map()));
    const rows = days.get(event.date);
    if (rows) rows.push(event);
    else days.set(event.date, [event]);
  }
  for (const days of out.values()) for (const rows of days.values()) rows.sort((a, b) => a.seq - b.seq);
  return out;
}

function textDate(value: unknown): ISODate | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function taskChangeDates(data: Data): Set<ISODate> {
  const dates = new Set<ISODate>();
  for (const task of data.tasks) dates.add(task.createdAt);
  for (const entry of data.entries) if (entry.itemType === 'task') dates.add(entry.date);
  for (const event of data.operations) {
    if (
      event.taskId ||
      event.kind === 'project-restarted' ||
      event.kind === 'project-trimmed' ||
      event.kind === 'project-closed' ||
      event.kind === 'project-completed'
    ) dates.add(event.date);
  }
  return dates;
}

function buildStageTransitions(data: Data, today: ISODate): StageTransition[] {
  const entriesByProject = projectEntries(data);
  const opsByProject = projectOperations(data);
  const changedDates = taskChangeDates(data);
  const taskStatesAt = new Map<ISODate, ReturnType<typeof taskStates>>();
  const statesAt = (date: ISODate) => {
    let states = taskStatesAt.get(date);
    if (!states) {
      states = taskStates(data, date);
      taskStatesAt.set(date, states);
    }
    return states;
  };

  // Historical "pending" must be reconstructed from state at that date, not
  // from today's task state. This keeps the pre-settlement timeline identical
  // to settleDay's filtered-data view.
  const candidatePending = new Set<ISODate>();
  for (const task of data.tasks) if (task.scheduledFor) candidatePending.add(task.scheduledFor);
  for (const event of data.operations) {
    const p = event.payload;
    if (event.kind === 'task-created' || event.kind === 'task-arranged') {
      const date = textDate(p?.scheduledFor);
      if (date) candidatePending.add(date);
    } else if (event.kind === 'task-rescheduled') {
      const date = textDate(p?.toDate);
      if (date) candidatePending.add(date);
    } else if (event.kind === 'task-state-baseline') {
      const date = textDate(p?.scheduledFor);
      if (date) candidatePending.add(date);
    }
  }
  for (const entry of data.entries) {
    if (entry.itemType !== 'task') continue;
    if (entry.outcome === 'partial' || entry.reason === 'postponed') candidatePending.add(addDays(entry.date, 1));
    else if (entry.outcome === 'skipped' && entry.reason !== 'not_important') candidatePending.add(entry.date);
  }
  for (const event of data.events) if (!event.allDay) candidatePending.add(dateOfStamp(event.start));

  const pending = new Set<ISODate>();
  for (const date of candidatePending) {
    if (date >= today) continue;
    const hasTask = statesAt(date).some(
      (task) => task.status === 'open' && !!task.projectId && task.scheduledFor === date,
    );
    const hasEvent = data.events.some((event) => !event.allDay && dateOfStamp(event.start) === date);
    if (hasTask || hasEvent) pending.add(date);
  }
  const recorded = new Map(data.days.map((day) => [day.date, day.status] as const));
  const statusOf = (date: ISODate): DayStatus => recorded.get(date) ?? (pending.has(date) ? 'pending' : 'empty');

  const heavyAt = (projectId: string, date: ISODate) =>
    statesAt(date).some(
      (task) => task.projectId === projectId && task.status === 'open' && task.postponeCount >= POSTPONE_PENALTY_AT,
    );

  const out: StageTransition[] = [];
  for (const project of data.projects) {
    if (project.createdAt > today) continue;
    const projectDays = entriesByProject.get(project.id) ?? new Map();
    const opDays = opsByProject.get(project.id) ?? new Map();
    const resets = new Map<ISODate, NonNullable<Project['resets']>>();
    for (const reset of project.resets ?? []) {
      const rows = resets.get(reset.date);
      if (rows) rows.push(reset);
      else resets.set(reset.date, [reset]);
    }

    let active = true;
    let neglect = 0;
    let heavy = false;
    let visibleStage: Stage | undefined = 0;

    for (let date = project.createdAt; date <= today; date = addDays(date, 1)) {
      const dayStartStage = stageWithPenalty(neglect, heavy);
      if (active) {
        if (visibleStage === undefined) visibleStage = dayStartStage;
        else if (dayStartStage !== visibleStage) {
          out.push({
            id: `stage-time|${date}|${project.id}`,
            date,
            projectId: project.id,
            from: visibleStage,
            to: dayStartStage,
            source: 'time',
          });
          visibleStage = dayStartStage;
        }
      }

      const rows = (projectDays.get(date) ?? []).slice().sort((a, b) => a.seq - b.seq);
      const operations = opDays.get(date) ?? [];
      const hasResetOperation = operations.some((event) => event.kind === 'project-restarted' || event.kind === 'project-trimmed');
      const legacyResets = hasResetOperation ? [] : (resets.get(date) ?? []);
      let resetToday = false;
      for (const reset of legacyResets) {
        if (!active) continue;
        neglect = reset.neglect;
        resetToday = true;
        visibleStage = stageWithPenalty(neglect, heavy);
      }

      let factBaseline = active ? stageWithPenalty(neglect, heavy) : undefined;
      let factTransition: StageTransition | undefined;
      const activeRows: SettlementEntry[] = [];
      let progressApplied = false;

      const captureBeforeDeactivate = () => {
        if (!active || factBaseline === undefined) return;
        const current = stageWithPenalty(neglect, heavy);
        if (current !== factBaseline) {
          factTransition = {
            id: `stage|${date}|${project.id}`,
            date,
            projectId: project.id,
            from: factBaseline,
            to: current,
            source: 'facts',
          };
        }
      };

      for (const fact of orderedProjectDayFacts(rows, operations)) {
        const event = fact.operation;
        if (event) {
          if (event.kind === 'project-closed' || event.kind === 'project-completed') {
            captureBeforeDeactivate();
            active = false;
            visibleStage = undefined;
            factBaseline = undefined;
          } else if (event.kind === 'project-restarted') {
            active = true;
            neglect = 0;
            resetToday = true;
            factBaseline = stageWithPenalty(neglect, heavy);
            visibleStage = factBaseline;
          } else if (event.kind === 'project-trimmed') {
            active = true;
            neglect = TRIM_TO_NEGLECT;
            resetToday = true;
            factBaseline = stageWithPenalty(neglect, heavy);
            visibleStage = factBaseline;
          } else if (event.kind === 'project-created') {
            active = true;
            factBaseline = stageWithPenalty(neglect, heavy);
            visibleStage = factBaseline;
          }
          continue;
        }

        const entry = fact.entry!;
        if (!active) continue;
        activeRows.push(entry);
        if (!progressApplied && (entry.outcome === 'done' || entry.outcome === 'partial')) {
          neglect = recoverOne(neglect);
          progressApplied = true;
        }
      }

      if (!operations.length && (project.doneAt === date || project.closedAt === date)) {
        captureBeforeDeactivate();
        active = false;
        visibleStage = undefined;
        factBaseline = undefined;
      }

      const previousHeavy = heavy;
      if (changedDates.has(date)) heavy = heavyAt(project.id, date);

      if (active) {
        const effect = activeRows.length ? dayEffect(activeRows) : 'idle';
        let appliedIdle = false;
        if (!progressApplied && !(date === today && statusOf(date) === 'empty' && activeRows.length === 0)) {
          const status = statusOf(date);
          if (!((status === 'pending' || status === 'unrecorded') && effect !== 'progress')) {
            if (effect === 'idle' && date !== project.createdAt && !resetToday) {
              neglect += 1;
              appliedIdle = true;
            }
          }
        }

        const endStage = stageWithPenalty(neglect, heavy);
        if (factBaseline === undefined) {
          visibleStage = endStage;
        } else if (endStage !== factBaseline) {
          const pureTime =
            appliedIdle &&
            effect === 'idle' &&
            statusOf(date) === 'empty' &&
            activeRows.length === 0 &&
            !resetToday &&
            previousHeavy === heavy;
          if (!pureTime) {
            factTransition = {
              id: `stage|${date}|${project.id}`,
              date,
              projectId: project.id,
              from: factBaseline,
              to: endStage,
              source: 'facts',
            };
            visibleStage = endStage;
          }
          // Pure passage changes remain unobserved until the next day start.
        } else {
          visibleStage = endStage;
        }
      }

      if (factTransition) out.push(factTransition);
    }
  }
  return out;
}

export function stageTransitions(data: Data, today: ISODate): StageTransition[] {
  const revision = decayRevision.get(data) ?? 0;
  const cached = timelineCache.get(data);
  if (cached?.revision === revision && cached.today === today) return cached.transitions;
  const transitions = buildStageTransitions(data, today);
  timelineCache.set(data, { revision, today, transitions });
  return transitions;
}

export function stageLifeEntries(data: Data, today: ISODate): LifeEntry[] {
  return stageTransitions(data, today).map((transition) => ({
    id: transition.id,
    date: transition.date,
    projectId: transition.projectId,
    kind: 'stage',
    text: `村落进入「${STAGE_NAMES[transition.to]}」阶段`,
  }));
}
