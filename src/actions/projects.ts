/** Project-domain mutations. */
import type { Project, SkipReason } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { addDays } from '../lib/date';
import { MAX_VILLAGES, PROMPT_SNOOZE_DAYS, TRIM_TO_NEGLECT } from '../logic/config';
import { ActionError, REASON_TEXT, chronicle, operation, q } from './shared';
import { dropTask } from './tasks';

function createProjectImpl(store: Store, name: string): Project {
  const n = name.trim();
  if (!n) throw new ActionError('error.projectNameRequired');
  const used = new Set(store.activeProjects().map((p) => p.islandSlot));
  let slot = -1;
  for (let k = 0; k < MAX_VILLAGES; k++) if (!used.has(k)) { slot = k; break; }
  if (slot < 0) throw new ActionError('error.villageLimit', { count: MAX_VILLAGES });
  const today = store.today();
  const p: Project = { id: uid('p'), name: n, createdAt: today, status: 'active', islandSlot: slot };
  store.put('projects', p);
  operation(store, {
    date: today,
    kind: 'project-created',
    projectId: p.id,
    payload: { name: n, islandSlot: slot },
    life: [{ kind: 'start', projectId: p.id, text: `立项，村落${q(n)}在岛上落成` }],
  });
  chronicle(store, today, `岛上立起了新村落${q(n)}。`, 'event');
  return p;
}

function renameProjectImpl(store: Store, id: string, name: string) {
  const p = store.project(id);
  const n = name.trim();
  if (!p || !n || n === p.name) return;
  operation(store, {
    kind: 'project-renamed',
    projectId: id,
    payload: { fromName: p.name, toName: n },
    life: [{ kind: 'event', projectId: id, text: `改名：${q(p.name)} → ${q(n)}` }],
  });
  store.put('projects', { ...p, name: n });
}

/** 搬离阶段的三个选择之一：重新启动 */
function restartProjectImpl(store: Store, id: string) {
  const p = store.project(id);
  if (!p) return;
  const today = store.today();
  store.put('projects', { ...p, resets: [...(p.resets ?? []), { date: today, neglect: 0, kind: 'restart' }], promptSnoozeUntil: undefined });
  operation(store, {
    date: today,
    kind: 'project-restarted',
    projectId: id,
    payload: { source: 'manual' },
    life: [{ kind: 'restart', projectId: id, text: '重新启动，村落重新热闹起来' }],
  });
  chronicle(store, today, `${q(p.name)}重新启动了。`, 'recover');
}

/** 搬离阶段的三个选择之一：缩小规模，放下一部分任务 */
function trimProjectImpl(store: Store, id: string, dropTaskIds: string[]) {
  const p = store.project(id);
  if (!p) return;
  const today = store.today();
  for (const tid of dropTaskIds) dropTask(store, tid, '缩小规模时放下');
  store.put('projects', { ...p, resets: [...(p.resets ?? []), { date: today, neglect: TRIM_TO_NEGLECT, kind: 'trim' }], promptSnoozeUntil: undefined });
  operation(store, {
    date: today,
    kind: 'project-trimmed',
    projectId: id,
    payload: { droppedTaskIds: [...dropTaskIds] },
    life: [{ kind: 'trim', projectId: id, text: dropTaskIds.length ? `缩小规模，放下了 ${dropTaskIds.length} 件事` : '缩小规模，轻装继续' }],
  });
  chronicle(store, today, `${q(p.name)}缩小了规模，轻装继续。`, 'recover');
}

/** 搬离阶段的三个选择之一：正式关闭（需要用户确认后调用） */
function closeProjectImpl(store: Store, id: string, reason: string) {
  const p = store.project(id);
  if (!p || p.status !== 'active') return;
  const today = store.today();
  const droppedTaskIds = store.tasks().filter((t) => t.projectId === id && t.status === 'open').map((t) => t.id);
  const r = reason.trim();
  store.put('projects', { ...p, status: 'closed', closedAt: today, closeReason: r || undefined });
  operation(store, {
    date: today,
    kind: 'project-closed',
    projectId: id,
    payload: { reason: r || undefined, droppedTaskIds },
    life: [{ kind: 'close', projectId: id, text: r ? `正式关闭：${r}` : '正式关闭' }],
  });
  chronicle(store, today, `${q(p.name)}正式关闭，放进了「未竟之书」。`, 'quiet');
}

function stalledCloseReason(reasons: readonly SkipReason[]): string {
  const counts = new Map<SkipReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const detail = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${REASON_TEXT[reason]} ${count} 次`)
    .join('、');
  return detail ? `长期停滞（${detail}）` : '长期停滞';
}

function closeStalledProjectImpl(store: Store, id: string, reasons: readonly SkipReason[]) {
  return closeProjectImpl(store, id, stalledCloseReason(reasons));
}

/** 把关闭的项目重新立起来 */
function reopenProjectImpl(store: Store, id: string) {
  const p = store.project(id);
  if (!p || p.status !== 'closed') return;
  const used = new Set(store.activeProjects().map((x) => x.islandSlot));
  let slot = -1;
  for (let k = 0; k < MAX_VILLAGES; k++) if (!used.has(k)) { slot = k; break; }
  if (slot < 0) throw new ActionError('error.noVillageLand');
  const today = store.today();
  store.put('projects', { ...p, status: 'active', islandSlot: slot, closedAt: undefined, resets: [...(p.resets ?? []), { date: today, neglect: 0, kind: 'restart' }] });
  operation(store, {
    date: today,
    kind: 'project-restarted',
    projectId: id,
    payload: { source: 'reopen', islandSlot: slot },
    life: [{ kind: 'restart', projectId: id, text: '从「未竟之书」里重新立起' }],
  });
  chronicle(store, today, `${q(p.name)}被重新立起。`, 'recover');
}

function snoozePromptImpl(store: Store, id: string) {
  const p = store.project(id);
  if (p) store.put('projects', { ...p, promptSnoozeUntil: addDays(store.today(), PROMPT_SNOOZE_DAYS) });
}

/** 需要询问「重新启动 / 缩小规模 / 正式关闭」的项目 */
export function projectsNeedingPrompt(store: Store): Project[] {
  const v = store.villages();
  const today = store.today();
  return store.activeProjects().filter((p) => v.get(p.id)?.stage === 3 && !(p.promptSnoozeUntil && p.promptSnoozeUntil > today));
}

export const createProject = (...args: Parameters<typeof createProjectImpl>): ReturnType<typeof createProjectImpl> =>
  args[0].batch(() => createProjectImpl(...args));

export const renameProject = (...args: Parameters<typeof renameProjectImpl>): ReturnType<typeof renameProjectImpl> =>
  args[0].batch(() => renameProjectImpl(...args));

export const restartProject = (...args: Parameters<typeof restartProjectImpl>): ReturnType<typeof restartProjectImpl> =>
  args[0].batch(() => restartProjectImpl(...args));

export const trimProject = (...args: Parameters<typeof trimProjectImpl>): ReturnType<typeof trimProjectImpl> =>
  args[0].batch(() => trimProjectImpl(...args));

export const closeProject = (...args: Parameters<typeof closeProjectImpl>): ReturnType<typeof closeProjectImpl> =>
  args[0].batch(() => closeProjectImpl(...args));

export const closeStalledProject = (...args: Parameters<typeof closeStalledProjectImpl>): ReturnType<typeof closeStalledProjectImpl> =>
  args[0].batch(() => closeStalledProjectImpl(...args));

export const reopenProject = (...args: Parameters<typeof reopenProjectImpl>): ReturnType<typeof reopenProjectImpl> =>
  args[0].batch(() => reopenProjectImpl(...args));

export const snoozePrompt = (...args: Parameters<typeof snoozePromptImpl>): ReturnType<typeof snoozePromptImpl> =>
  args[0].batch(() => snoozePromptImpl(...args));
