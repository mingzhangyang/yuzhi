/** Task-domain mutations. */
import type { ISODate, SettlementEntry, Task } from '../types';
import { entryId } from '../logic/days';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { isPlausibleDate } from '../lib/date';
import { historyEvent } from '../history-types';
import { ActionError, assertPickedDate, operation, putSettlementEntry, q, semanticLife } from './shared';

function createTaskImpl(store: Store, o: { title: string; projectId?: string; scheduledFor?: ISODate }): Task {
  const title = o.title.trim();
  if (!title) throw new ActionError('error.taskRequired');
  assertPickedDate(o.scheduledFor);
  const today = store.today();
  const projectId = o.projectId && store.project(o.projectId)?.status === 'active' ? o.projectId : undefined;
  const t: Task = { id: uid('t'), title, projectId, scheduledFor: projectId ? o.scheduledFor : undefined, status: 'open', createdAt: today };
  // 停在码头的任务也可以先带着日期，安排时沿用
  if (!projectId && o.scheduledFor) t.scheduledFor = o.scheduledFor;
  store.put('tasks', t);
  operation(store, {
    date: today,
    kind: 'task-created',
    projectId,
    taskId: t.id,
    payload: { title, scheduledFor: t.scheduledFor },
    life: projectId ? [semanticLife({ kind: 'task', projectId, taskId: t.id, event: historyEvent('history.life.taskCreated', { title }) })] : undefined,
  });
  return t;
}

/** 码头：决定任务住进哪个村落、排在什么时候 */
function arrangeTaskImpl(store: Store, taskId: string, projectId: string, date?: ISODate) {
  const t = store.task(taskId);
  const p = store.project(projectId);
  if (!t || !p || p.status !== 'active') return;
  assertPickedDate(date);
  const today = store.today();
  operation(store, {
    date: today,
    kind: 'task-arranged',
    projectId,
    taskId,
    payload: { fromProjectId: t.projectId, toProjectId: projectId, scheduledFor: date },
    life: [semanticLife({
      kind: 'task',
      projectId,
      taskId,
      event: date
        ? historyEvent('history.life.taskArrangedDate', { title: t.title, date })
        : historyEvent('history.life.taskArranged', { title: t.title }),
    })],
  });
}

/** 码头：婉拒 */
function declineTaskImpl(store: Store, taskId: string) {
  const t = store.task(taskId);
  if (!t) return;
  const today = store.today();
  operation(store, { date: today, kind: 'task-dropped', projectId: t.projectId, taskId, payload: { source: 'decline' } });
}

function rescheduleTaskImpl(store: Store, taskId: string, date: ISODate | undefined) {
  const t = store.task(taskId);
  if (!t || t.status !== 'open') return;
  assertPickedDate(date);
  const today = store.today();
  operation(store, {
    date: today,
    kind: 'task-rescheduled',
    projectId: t.projectId,
    taskId,
    payload: { fromDate: t.scheduledFor, toDate: date },
    life: t.projectId ? [semanticLife({
      kind: 'event',
      projectId: t.projectId,
      taskId,
      event: date
        ? historyEvent('history.life.taskRescheduledDate', { title: t.title, date })
        : historyEvent('history.life.taskUnscheduled', { title: t.title }),
    })] : undefined,
  });
}

function moveTaskImpl(store: Store, taskId: string, projectId: string | undefined) {
  const t = store.task(taskId);
  if (!t || t.projectId === projectId) return;
  const today = store.today();
  const fromProjectId = t.projectId;
  operation(store, {
    date: today,
    kind: 'task-moved',
    projectId,
    taskId,
    payload: { fromProjectId, toProjectId: projectId },
    life: [
      ...(fromProjectId ? [semanticLife({ kind: 'event' as const, projectId: fromProjectId, taskId, event: historyEvent('history.life.taskMovedOut', { title: t.title }) })] : []),
      ...(projectId ? [semanticLife({ kind: 'task' as const, projectId, taskId, event: historyEvent('history.life.taskMovedIn', { title: t.title }) })] : []),
    ],
  });
}

/**
 * 编辑任务的归属和日期是一个用户动作。内部复用领域事实生成逻辑，
 * 但只由最外层 action 提交一次 persistence transaction。
 */
function editTaskPlanImpl(store: Store, taskId: string, projectId: string | undefined, date: ISODate | undefined) {
  const before = store.task(taskId);
  if (!before || before.status !== 'open') return;
  assertPickedDate(date);

  if (projectId !== before.projectId) {
    if (!before.projectId && projectId) arrangeTaskImpl(store, taskId, projectId, date);
    else moveTaskImpl(store, taskId, projectId);
  }

  const current = store.task(taskId);
  if (current && current.scheduledFor !== date) rescheduleTaskImpl(store, taskId, date);
}

function renameTaskImpl(store: Store, taskId: string, title: string) {
  const raw = store.taskRecord(taskId);
  const t = store.task(taskId);
  const n = title.trim();
  if (!raw || !t || !n || n === raw.title) return;
  operation(store, {
    date: store.today(),
    kind: 'task-renamed',
    projectId: t.projectId,
    taskId,
    payload: { fromTitle: raw.title, toTitle: n },
    life: [semanticLife({
      projectId: t.projectId,
      taskId,
      kind: 'event',
      event: historyEvent('history.life.taskRenamed', { from: raw.title, to: n }),
    })],
  });
  store.put('tasks', { ...raw, title: n });
}

type DropTaskOrigin =
  | { kind: 'manual'; note: string }
  | { kind: 'project-trim' };

function recordDroppedTask(store: Store, taskId: string, origin: DropTaskOrigin) {
  const t = store.task(taskId);
  if (!t || t.status !== 'open') return;
  const today = store.today();
  const manualNote = origin.kind === 'manual' ? origin.note : undefined;
  const life = !t.projectId
    ? undefined
    : origin.kind === 'project-trim'
      ? [semanticLife({
          kind: 'drop',
          projectId: t.projectId,
          taskId,
          reason: 'not_important',
          event: historyEvent('history.life.taskDroppedTrim', { title: t.title }),
        })]
      : origin.note === '不重要了，移出村落'
        ? [semanticLife({
            kind: 'drop',
            projectId: t.projectId,
            taskId,
            reason: 'not_important',
            event: historyEvent('history.life.taskDroppedNotImportant', { title: t.title }),
          })]
        : [{
            kind: 'drop' as const,
            projectId: t.projectId,
            taskId,
            reason: 'not_important' as const,
            text: `${q(t.title)}${origin.note}`,
          }];
  operation(store, {
    date: today,
    kind: 'task-dropped',
    projectId: t.projectId,
    taskId,
    payload: origin.kind === 'project-trim'
      ? { source: 'project-trim' }
      : { source: 'manual', note: manualNote },
    life,
  });
}

/** 不重要了：任务移出，不算惩罚。自定义 note 始终按用户文本保留。 */
function dropTaskImpl(store: Store, taskId: string, note = '不重要了，移出村落') {
  return recordDroppedTask(store, taskId, { kind: 'manual', note });
}

/** 仅供 project trim 领域流程使用；不通过用户 note 推断系统来源。 */
export function dropTaskForTrim(store: Store, taskId: string) {
  return recordDroppedTask(store, taskId, { kind: 'project-trim' });
}

/** 撤销「做完了」需要的信息：哪一天，以及这一天原来有没有别的判定 */
export interface TaskDoneUndo {
  taskId: string;
  date: ISODate;
  previous?: SettlementEntry;
  /** Exact applied fact instance; a later verdict replaces this object. */
  applied: SettlementEntry;
}

/** 在结算之外直接记下「今天做完了」（例如没有日期的任务）。返回撤销所需的信息。 */
function markTaskDoneImpl(store: Store, taskId: string): TaskDoneUndo | undefined {
  const t = store.task(taskId);
  if (!t || t.status !== 'open' || !t.projectId) return undefined;
  const today = store.today();
  const previous = store.data.entries.find((entry) => entry.id === entryId(today, 'task', t.id));
  putSettlementEntry(store, today, { key: `task|${t.id}`, type: 'task', id: t.id, title: t.title, projectId: t.projectId }, 'done');
  const applied = store.data.entries.find((entry) => entry.id === entryId(today, 'task', t.id));
  if (!applied) throw new Error('Quick completion did not create a settlement fact');
  return { taskId: t.id, date: today, previous: previous ? { ...previous } : undefined, applied };
}

/**
 * 撤销刚才记下的「做完了」：删掉这条结算事实，或换回原来的判定。
 * 和晚间结算里取消一个决定是同一件事（只动事实，后果由 read model 回退）。
 * 期间这条事实被别处改过（例如结算里改判了）就不动它。
 */
function undoTaskDoneImpl(store: Store, undo: TaskDoneUndo): boolean {
  const id = entryId(undo.date, 'task', undo.taskId);
  const current = store.data.entries.find((entry) => entry.id === id);
  // Each Store.put replaces the fact instance. Skip -> done, reload and
  // other intervening verdicts must never revive a stale undo token.
  if (!current || current !== undo.applied || current.outcome !== 'done') return false;
  if (undo.previous) store.put('entries', undo.previous);
  else store.del('entries', id);
  return true;
}

/** 结算时把一件别的任务拉进这一天（「今天还做了…」），不算改期 */
function pullIntoDayImpl(store: Store, taskId: string, date: ISODate) {
  const t = store.task(taskId);
  if (t && t.status === 'open' && t.projectId && t.scheduledFor !== date) {
    operation(store, {
      date: store.today(),
      kind: 'task-rescheduled',
      projectId: t.projectId,
      taskId,
      payload: { fromDate: t.scheduledFor, toDate: date, source: 'pull-into-day' },
    });
  }
}

/**
 * 旧版日期框在逐位输入年份时会提交 0002-11-03 这类日期（YZ-F1），任务因此被算作过期。
 * 1900 年以前的日期不可能是用户本意：月日是用户选的，年份按任务创建那年补回。
 * 只修正这一种可以确定的错误，不碰其它日期。返回修正过的任务 id。
 */
function repairTruncatedYearDatesImpl(store: Store): string[] {
  const repaired: string[] = [];
  for (const task of store.tasks()) {
    const bad = task.scheduledFor;
    if (task.status !== 'open' || !bad || isPlausibleDate(bad)) continue;
    const m = /^(\d{4})-(\d{2}-\d{2})$/.exec(bad);
    if (!m || Number(m[1]) >= 1900) continue;
    const fixed = `${task.createdAt.slice(0, 4)}-${m[2]}`;
    if (!isPlausibleDate(fixed)) continue;
    operation(store, {
      date: store.today(),
      kind: 'task-rescheduled',
      projectId: task.projectId,
      taskId: task.id,
      payload: { fromDate: bad, toDate: fixed, source: 'repair-truncated-year' },
    });
    repaired.push(task.id);
  }
  return repaired;
}

export const createTask = (...args: Parameters<typeof createTaskImpl>): ReturnType<typeof createTaskImpl> =>
  args[0].batch(() => createTaskImpl(...args));

export const arrangeTask = (...args: Parameters<typeof arrangeTaskImpl>): ReturnType<typeof arrangeTaskImpl> =>
  args[0].batch(() => arrangeTaskImpl(...args));

export const declineTask = (...args: Parameters<typeof declineTaskImpl>): ReturnType<typeof declineTaskImpl> =>
  args[0].batch(() => declineTaskImpl(...args));

export const rescheduleTask = (...args: Parameters<typeof rescheduleTaskImpl>): ReturnType<typeof rescheduleTaskImpl> =>
  args[0].batch(() => rescheduleTaskImpl(...args));

export const moveTask = (...args: Parameters<typeof moveTaskImpl>): ReturnType<typeof moveTaskImpl> =>
  args[0].batch(() => moveTaskImpl(...args));

export const editTaskPlan = (...args: Parameters<typeof editTaskPlanImpl>): ReturnType<typeof editTaskPlanImpl> =>
  args[0].batch(() => editTaskPlanImpl(...args));

export const renameTask = (...args: Parameters<typeof renameTaskImpl>): ReturnType<typeof renameTaskImpl> =>
  args[0].batch(() => renameTaskImpl(...args));

export const dropTask = (...args: Parameters<typeof dropTaskImpl>): ReturnType<typeof dropTaskImpl> =>
  args[0].batch(() => dropTaskImpl(...args));

export const markTaskDone = (...args: Parameters<typeof markTaskDoneImpl>): ReturnType<typeof markTaskDoneImpl> =>
  args[0].batch(() => markTaskDoneImpl(...args));

export const undoTaskDone = (...args: Parameters<typeof undoTaskDoneImpl>): ReturnType<typeof undoTaskDoneImpl> =>
  args[0].batch(() => undoTaskDoneImpl(...args));

export const repairTruncatedYearDates = (...args: Parameters<typeof repairTruncatedYearDatesImpl>): ReturnType<typeof repairTruncatedYearDatesImpl> =>
  args[0].batch(() => repairTruncatedYearDatesImpl(...args));

export const pullIntoDay = (...args: Parameters<typeof pullIntoDayImpl>): ReturnType<typeof pullIntoDayImpl> =>
  args[0].batch(() => pullIntoDayImpl(...args));
