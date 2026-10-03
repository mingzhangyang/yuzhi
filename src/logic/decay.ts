import type { Data, ISODate, LifeEntry, OperationEvent, Project, SettlementEntry } from '../types';
import { addDays } from '../lib/date';
import { POSTPONE_PENALTY_AT, STAGE_NAMES, STAGE_START, TRIM_TO_NEGLECT, type Stage } from './config';
import { dayStatusFn, type DayStatus } from './days';
import { taskStates, taskStatesAtCuts } from './read-model';

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
  /** Sequence of the fact that caused a fact-derived transition. */
  factSeq?: number;
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

    let activeRows: SettlementEntry[] = [];
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
          progressApplied = false;
          activeRows = [];
        } else if (event.kind === 'project-trimmed') {
          active = true;
          neglect = TRIM_TO_NEGLECT;
          sinceProgress = 0;
          resetToday = true;
          progressApplied = false;
          activeRows = [];
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

function projectActiveAt(project: Project, operationDays: Map<ISODate, OperationEvent[]>, throughDate: ISODate): boolean {
  if (project.createdAt > throughDate) return false;

  const facts = [...operationDays.entries()]
    .filter(([date]) => date <= throughDate)
    .flatMap(([, events]) => events)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  let active = true;
  let sawTerminalFact = false;
  for (const event of facts) {
    if (event.kind === 'project-created' || event.kind === 'project-restarted' || event.kind === 'project-trimmed') {
      active = true;
    } else if (event.kind === 'project-closed' || event.kind === 'project-completed') {
      active = false;
      sawTerminalFact = true;
    }
  }

  // Compatibility fallback for legacy records whose lifecycle fact was never
  // recorded. Explicit replay facts win whenever they exist.
  if (!sawTerminalFact) {
    if (project.doneAt && project.doneAt <= throughDate) active = false;
    else if (project.closedAt && project.closedAt <= throughDate) active = false;
  }
  return active;
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
    const operationDays = operations.get(project.id) ?? new Map();
    if (!projectActiveAt(project, operationDays, today)) continue;
    const heavy = tasks.some(
      (task) => task.projectId === project.id && task.status === 'open' && task.postponeCount >= POSTPONE_PENALTY_AT,
    );
    out.set(project.id, computeVillage(project, byProject.get(project.id) ?? new Map(), statusOf, heavy, today, operationDays));
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

const HEAVY_PROJECT_KINDS = new Set([
  'project-restarted',
  'project-trimmed',
  'project-closed',
  'project-completed',
]);

const HEAVY_TASK_KINDS = new Set([
  'task-arranged',
  'task-moved',
  'task-dropped',
  'task-state-baseline',
]);

interface HeavyProjectChange {
  heavy: boolean;
  factSeq?: number;
}

/**
 * Build heavy-membership transitions at fact-sequence granularity. Semantic
 * date controls eligibility; seq controls precedence within the eligible set.
 * Sampling only at day end loses transient heavy states before a same-day
 * restart/close, so each relevant fact cut is replayed independently.
 */
function buildHeavyTimeline(data: Data, today: ISODate): Map<string, Map<ISODate, HeavyProjectChange[]>> {
  const cutsByTask = new Map<string, Array<{ date: ISODate; seq: number }>>();
  const addCut = (taskId: string, date: ISODate, seq: number) => {
    const task = data.tasks.find((row) => row.id === taskId);
    if (!task || date < task.createdAt || date > today) return;
    let cuts = cutsByTask.get(taskId);
    if (!cuts) cutsByTask.set(taskId, (cuts = []));
    cuts.push({ date, seq });
  };

  for (const entry of data.entries) {
    if (entry.itemType === 'task') addCut(entry.itemId, entry.date, entry.seq);
  }
  const lifecycle = data.operations.filter((event) => HEAVY_PROJECT_KINDS.has(event.kind) && event.projectId);
  for (const event of data.operations) {
    if (event.taskId && HEAVY_TASK_KINDS.has(event.kind)) addCut(event.taskId, event.date, event.seq);
  }
  for (const event of lifecycle) {
    for (const task of data.tasks) if (task.createdAt <= event.date) addCut(task.id, event.date, event.seq);
  }

  const membershipChanges: Array<{ date: ISODate; seq: number; taskId: string; fromProjectId?: string; toProjectId?: string }> = [];
  for (const task of data.tasks) {
    if (task.createdAt > today) continue;
    const cuts = cutsByTask.get(task.id) ?? [];
    if (!cuts.length) continue;
    const orderedCuts = [...new Map(cuts.map((cut) => [`${cut.date}|${cut.seq}`, cut] as const)).values()]
      .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    const states = taskStatesAtCuts(data, task, orderedCuts);
    let previousProject: string | undefined;
    for (let i = 0; i < orderedCuts.length; i++) {
      const current = states[i];
      const currentProject = current.status === 'open' && current.projectId && current.postponeCount >= POSTPONE_PENALTY_AT
        ? current.projectId
        : undefined;
      if (currentProject === previousProject) continue;
      membershipChanges.push({
        ...orderedCuts[i],
        taskId: task.id,
        fromProjectId: previousProject,
        toProjectId: currentProject,
      });
      previousProject = currentProject;
    }
  }

  membershipChanges.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.taskId.localeCompare(b.taskId));
  const members = new Map<string, Set<string>>();
  const timeline = new Map<string, Map<ISODate, HeavyProjectChange[]>>();
  const push = (projectId: string, date: ISODate, change: HeavyProjectChange) => {
    let byDate = timeline.get(projectId);
    if (!byDate) timeline.set(projectId, (byDate = new Map()));
    let rows = byDate.get(date);
    if (!rows) byDate.set(date, (rows = []));
    rows.push(change);
  };

  for (const change of membershipChanges) {
    const touched = new Set<string>();
    if (change.fromProjectId) {
      let set = members.get(change.fromProjectId);
      if (!set) members.set(change.fromProjectId, (set = new Set()));
      const before = set.size > 0;
      set.delete(change.taskId);
      if (before !== (set.size > 0)) touched.add(change.fromProjectId);
    }
    if (change.toProjectId) {
      let set = members.get(change.toProjectId);
      if (!set) members.set(change.toProjectId, (set = new Set()));
      const before = set.size > 0;
      set.add(change.taskId);
      if (before !== (set.size > 0)) touched.add(change.toProjectId);
    }
    for (const projectId of touched) {
      push(projectId, change.date, {
        heavy: (members.get(projectId)?.size ?? 0) > 0,
        factSeq: change.seq,
      });
    }
  }
  return timeline;
}

function buildStageTransitions(data: Data, today: ISODate): StageTransition[] {
  const entriesByProject = projectEntries(data);
  const opsByProject = projectOperations(data);
  const statusOf = dayStatusFn(data, today);
  const heavyTimeline = buildHeavyTimeline(data, today);

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
      const dayFacts = orderedProjectDayFacts(rows, operations);
      const hasResetOperation = operations.some((event) => event.kind === 'project-restarted' || event.kind === 'project-trimmed');
      const legacyResets = hasResetOperation ? [] : (resets.get(date) ?? []);
      let resetToday = false;
      for (const reset of legacyResets) {
        if (!active) continue;
        neglect = reset.neglect;
        resetToday = true;
        visibleStage = stageWithPenalty(neglect, heavy);
      }

      const heavyAtDayStart = heavy;
      let factBaseline = active ? stageWithPenalty(neglect, heavy) : undefined;
      let factTransition: StageTransition | undefined;
      let factTransitionSeq: number | undefined;
      let activeRows: SettlementEntry[] = [];
      let progressApplied = false;
      const heavyChanges = heavyTimeline.get(project.id)?.get(date) ?? [];
      let heavyIndex = 0;

      const applyHeavyUntil = (seq: number, inclusive: boolean) => {
        while (heavyIndex < heavyChanges.length) {
          const changeSeq = heavyChanges[heavyIndex].factSeq ?? Number.MAX_SAFE_INTEGER;
          if (inclusive ? changeSeq > seq : changeSeq >= seq) break;
          const change = heavyChanges[heavyIndex++];
          const beforeHeavy = heavy;
          heavy = change.heavy;
          if (heavy !== beforeHeavy && change.factSeq !== undefined) {
            factTransitionSeq = factTransitionSeq === undefined
              ? change.factSeq
              : Math.max(factTransitionSeq, change.factSeq);
          }
        }
      };
      const applyHeavyThrough = (seq: number) => applyHeavyUntil(seq, true);

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
            factSeq: factTransitionSeq,
          };
        }
      };

      for (const fact of dayFacts) {
        const event = fact.operation;
        if (event?.kind === 'project-closed' || event?.kind === 'project-completed') {
          applyHeavyUntil(fact.seq, false);
          captureBeforeDeactivate();
          applyHeavyThrough(fact.seq);
          active = false;
          visibleStage = undefined;
          factBaseline = undefined;
          continue;
        }

        applyHeavyThrough(fact.seq);
        if (event) {
          if (event.kind === 'project-restarted') {
            active = true;
            neglect = 0;
            heavy = false;
            resetToday = true;
            progressApplied = false;
            activeRows = [];
            factBaseline = stageWithPenalty(neglect, heavy);
            visibleStage = factBaseline;
          } else if (event.kind === 'project-trimmed') {
            active = true;
            neglect = TRIM_TO_NEGLECT;
            heavy = false;
            resetToday = true;
            progressApplied = false;
            activeRows = [];
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
          const beforeProgressStage = stageWithPenalty(neglect, heavy);
          neglect = recoverOne(neglect);
          if (stageWithPenalty(neglect, heavy) !== beforeProgressStage) factTransitionSeq = entry.seq;
          progressApplied = true;
        }
      }

      if (!operations.length && (project.doneAt === date || project.closedAt === date)) {
        captureBeforeDeactivate();
        active = false;
        visibleStage = undefined;
        factBaseline = undefined;
      }

      applyHeavyThrough(Number.MAX_SAFE_INTEGER);

      if (active) {
        const effect = activeRows.length ? dayEffect(activeRows) : 'idle';
        let appliedIdle = false;
        if (!progressApplied && !(date === today && statusOf(date) === 'empty' && activeRows.length === 0)) {
          const status = statusOf(date);
          if (!((status === 'pending' || status === 'unrecorded') && effect !== 'progress')) {
            if (effect === 'idle' && date !== project.createdAt && !resetToday) {
              neglect += 1;
              appliedIdle = true;
              // When a settled row makes this day count as idle, the resulting
              // stage decline is causally after that settlement. Preserve that
              // seq so derived life rows cannot sort before their cause.
              if (activeRows.length) {
                const settlementSeq = Math.max(...activeRows.map((entry) => entry.seq));
                factTransitionSeq = factTransitionSeq === undefined
                  ? settlementSeq
                  : Math.max(factTransitionSeq, settlementSeq);
              }
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
            heavyAtDayStart === heavy;
          if (!pureTime) {
            factTransition = {
              id: `stage|${date}|${project.id}`,
              date,
              projectId: project.id,
              from: factBaseline,
              to: endStage,
              source: 'facts',
              factSeq: factTransitionSeq,
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
    factSeq: transition.source === 'facts' ? transition.factSeq : undefined,
    kind: 'stage',
    text: `村落进入「${STAGE_NAMES[transition.to]}」阶段`,
  }));
}
