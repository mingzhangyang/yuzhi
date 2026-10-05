/** Task-domain mutations. */
import type { ISODate, Task } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { fmtDay } from '../lib/date';
import { ActionError, operation, putSettlementEntry, q } from './shared';

function createTaskImpl(store: Store, o: { title: string; projectId?: string; scheduledFor?: ISODate }): Task {
  const title = o.title.trim();
  if (!title) throw new ActionError('写一句要做的事吧');
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
    life: projectId ? [{ kind: 'task', projectId, taskId: t.id, text: `新任务${q(title)}住进村落` }] : undefined,
  });
  return t;
}

/** 码头：决定任务住进哪个村落、排在什么时候 */
function arrangeTaskImpl(store: Store, taskId: string, projectId: string, date?: ISODate) {
  const t = store.task(taskId);
  const p = store.project(projectId);
  if (!t || !p || p.status !== 'active') return;
  const today = store.today();
  operation(store, {
    date: today,
    kind: 'task-arranged',
    projectId,
    taskId,
    payload: { fromProjectId: t.projectId, toProjectId: projectId, scheduledFor: date },
    life: [{ kind: 'task', projectId, taskId, text: `${q(t.title)}从码头上岸，住进村落${date ? `，排在${fmtDay(date)}` : ''}` }],
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
  const today = store.today();
  operation(store, {
    date: today,
    kind: 'task-rescheduled',
    projectId: t.projectId,
    taskId,
    payload: { fromDate: t.scheduledFor, toDate: date },
    life: t.projectId ? [{ kind: 'event', projectId: t.projectId, taskId, text: date ? `${q(t.title)}改到${fmtDay(date)}` : `${q(t.title)}暂不定日期` }] : undefined,
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
      ...(fromProjectId ? [{ kind: 'event' as const, projectId: fromProjectId, taskId, text: `${q(t.title)}搬去了别的村落` }] : []),
      ...(projectId ? [{ kind: 'task' as const, projectId, taskId, text: `${q(t.title)}搬进村落` }] : []),
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

  if (projectId !== before.projectId) {
    if (!before.projectId && projectId) arrangeTaskImpl(store, taskId, projectId, date);
    else moveTaskImpl(store, taskId, projectId);
  }

  const current = store.task(taskId);
  if (current && current.scheduledFor !== date) rescheduleTaskImpl(store, taskId, date);
}

function renameTaskImpl(store: Store, taskId: string, title: string) {
  const t = store.taskRecord(taskId);
  const n = title.trim();
  if (!t || !n || n === t.title) return;
  operation(store, {
    date: store.today(),
    kind: 'task-renamed',
    projectId: t.projectId,
    taskId,
    payload: { fromTitle: t.title, toTitle: n },
    life: [{
      projectId: t.projectId,
      taskId,
      kind: 'event',
      text: `改名：${q(t.title)} → ${q(n)}`,
    }],
  });
  store.put('tasks', { ...t, title: n });
}

/** 不重要了：任务移出，不算惩罚 */
function dropTaskImpl(store: Store, taskId: string, note = '不重要了，移出村落') {
  const t = store.task(taskId);
  if (!t || t.status !== 'open') return;
  const today = store.today();
  operation(store, {
    date: today,
    kind: 'task-dropped',
    projectId: t.projectId,
    taskId,
    payload: { source: 'manual', note },
    life: t.projectId ? [{ kind: 'drop', projectId: t.projectId, taskId, text: `${q(t.title)}${note}`, reason: 'not_important' }] : undefined,
  });
}

/** 在结算之外直接记下「今天做完了」（例如没有日期的任务） */
function markTaskDoneImpl(store: Store, taskId: string) {
  const t = store.task(taskId);
  if (!t || t.status !== 'open' || !t.projectId) return;
  const today = store.today();
  putSettlementEntry(store, today, { key: `task|${t.id}`, type: 'task', id: t.id, title: t.title, projectId: t.projectId }, 'done');
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

export const pullIntoDay = (...args: Parameters<typeof pullIntoDayImpl>): ReturnType<typeof pullIntoDayImpl> =>
  args[0].batch(() => pullIntoDayImpl(...args));
