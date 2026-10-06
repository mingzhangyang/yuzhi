/** Completion ceremony and landmark mutations. */
import type { Store } from '../store';
import { ringOfLandmark, totalLandmarkCapacity } from '../island/map';
import { historyEvent } from '../history-types';
import { ActionError, operation, semanticChronicle, semanticLife } from './shared';

/** 最小的空闲地标位 */
export function freeLandmarkIndex(store: Store, except?: string): number {
  const used = new Set(store.data.projects.filter((p) => p.id !== except && p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null).map((p) => p.landmarkIndex!));
  const cap = totalLandmarkCapacity();
  for (let k = 0; k < cap; k++) if (!used.has(k)) return k;
  return -1;
}

/** 地标越多，岛向外长出新陆地：需要几圈年轮 */
export function islandRings(store: Store): number {
  let max = -1;
  for (const p of store.data.projects) if (p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null) max = Math.max(max, p.landmarkIndex);
  return max < 0 ? 0 : ringOfLandmark(max);
}

/**
 * 完成一个项目（落成仪式里用户做出选择后调用）：
 * 没做完的任务随项目一起放下（不算没做），村落腾空，
 * 项目立为海岸上的地标，或收进山顶灯塔里的档案馆。
 */
function completeProjectImpl(store: Store, id: string, resting: 'landmark' | 'archive'): 'landmark' | 'archive' {
  const p = store.project(id);
  if (!p || p.status !== 'active') throw new ActionError('error.projectGone');
  const today = store.today();
  for (const t of store.tasks()) {
    if (t.projectId !== id || t.status !== 'open') continue;
    operation(store, {
      date: today,
      kind: 'task-dropped',
      projectId: id,
      taskId: t.id,
      payload: { source: 'project-completed' },
      life: [semanticLife({ kind: 'drop', projectId: id, taskId: t.id, event: historyEvent('history.life.taskDroppedWithProject', { title: t.title }) })],
    });
  }
  let where = resting;
  let idx: number | undefined;
  if (where === 'landmark') {
    const k = freeLandmarkIndex(store, id);
    if (k < 0) where = 'archive';
    else idx = k;
  }
  store.put('projects', { ...p, status: 'done', doneAt: today, resting: where, landmarkIndex: idx, promptSnoozeUntil: undefined });
  operation(store, {
    date: today,
    kind: 'project-completed',
    projectId: id,
    payload: { resting: where, landmarkIndex: idx },
    life: [semanticLife({
      kind: 'complete',
      projectId: id,
      event: historyEvent(where === 'landmark' ? 'history.life.projectCompletedLandmark' : 'history.life.projectCompletedArchive'),
    })],
  });
  semanticChronicle(
    store,
    today,
    [historyEvent(where === 'landmark' ? 'history.chron.projectCompletedLandmark' : 'history.chron.projectCompletedArchive', { name: p.name })],
    'landmark',
  );
  return where;
}

/** 反悔：地标收进档案馆，或把档案里的项目重新立为地标 */
function setRestingImpl(store: Store, id: string, resting: 'landmark' | 'archive') {
  const p = store.project(id);
  if (!p || p.status !== 'done' || p.resting === resting) return;
  const today = store.today();
  if (resting === 'landmark') {
    const k = freeLandmarkIndex(store, id);
    if (k < 0) throw new ActionError('error.coastFull');
    store.put('projects', { ...p, resting, landmarkIndex: k });
    operation(store, {
      date: today,
      kind: 'project-resting-changed',
      projectId: id,
      payload: { from: p.resting, to: resting, landmarkIndex: k },
      life: [semanticLife({ kind: 'event', projectId: id, event: historyEvent('history.life.projectRestoredLandmark') })],
    });
    semanticChronicle(store, today, [historyEvent('history.chron.projectRestoredLandmark', { name: p.name })], 'landmark');
  } else {
    store.put('projects', { ...p, resting, landmarkIndex: undefined });
    operation(store, {
      date: today,
      kind: 'project-resting-changed',
      projectId: id,
      payload: { from: p.resting, to: resting },
      life: [semanticLife({ kind: 'event', projectId: id, event: historyEvent('history.life.projectArchivedLandmark') })],
    });
    semanticChronicle(store, today, [historyEvent('history.chron.projectArchivedLandmark', { name: p.name })], 'quiet');
  }
}

export const completeProject = (...args: Parameters<typeof completeProjectImpl>): ReturnType<typeof completeProjectImpl> =>
  args[0].batch(() => completeProjectImpl(...args));

export const setResting = (...args: Parameters<typeof setRestingImpl>): ReturnType<typeof setRestingImpl> =>
  args[0].batch(() => setRestingImpl(...args));
