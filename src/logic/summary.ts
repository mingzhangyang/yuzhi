import type { Data, ISODate, Project, SkipReason } from '../types';
import { diffDays } from '../lib/date';
import { progressWeight } from './metrics';
import { lifeEntries } from './operations';
import { stageLifeEntries } from './decay';
import { taskStates } from './read-model';

export interface Blocker {
  text: string;
  count: number;
}

export interface Turn {
  date: ISODate;
  text: string;
}

/** 一个项目一生之书的小结（落成仪式和档案馆里用） */
export interface ProjectSummary {
  start: ISODate;
  end: ISODate;
  /** 用时（天），立项当天算第 1 天 */
  days: number;
  tasksDone: number;
  tasksDropped: number;
  /** 确认做了的条目（做了一部分按权重） */
  bricks: number;
  /** 有真实推进的天数 */
  activeDays: number;
  /** 「推到明天」的总次数 */
  postpones: number;
  /** 主要卡点：没做的原因与被推迟最多的事 */
  blockers: Blocker[];
  /** 关键转折 */
  turns: Turn[];
}

const REASON: Record<SkipReason, string> = {
  interrupted: '被打断',
  no_energy: '没精力',
  not_important: '不重要了',
  postponed: '推到明天',
};

export function summarize(data: Data, p: Project, end: ISODate): ProjectSummary {
  const entries = data.entries.filter((e) => e.projectId === p.id);
  const tasks = taskStates(data, end).filter((t) => t.projectId === p.id);
  const life = lifeEntries(data, stageLifeEntries(data, end)).filter((l) => l.projectId === p.id).sort((a, b) => a.date.localeCompare(b.date));

  let bricks = 0;
  const perDay = new Map<ISODate, number>();
  const reasons = new Map<SkipReason, number>();
  const postponedTask = new Map<string, { title: string; n: number }>();
  for (const e of entries) {
    const w = progressWeight(e);
    bricks += w;
    if (w) perDay.set(e.date, (perDay.get(e.date) ?? 0) + w);
    if (e.outcome === 'skipped' && e.reason) {
      reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
      if (e.reason === 'postponed' && e.itemType === 'task') {
        const cur = postponedTask.get(e.itemId) ?? { title: e.title, n: 0 };
        cur.n++;
        postponedTask.set(e.itemId, cur);
      }
    }
  }

  const blockers: Blocker[] = [...reasons.entries()]
    .filter(([r]) => r !== 'not_important')
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => ({ text: REASON[r], count: n }));
  const worst = [...postponedTask.values()].sort((a, b) => b.n - a.n)[0];
  if (worst && worst.n >= 2) blockers.push({ text: `「${worst.title}」一再推迟`, count: worst.n });

  // 关键转折：第一块砖、阶段起伏、重新启动 / 缩小规模、最忙的一天
  const turns: Turn[] = [];
  const days = [...perDay.keys()].sort();
  if (days.length) turns.push({ date: days[0], text: '第一块砖落进村落' });
  for (const l of life) {
    if (l.kind === 'restart' || l.kind === 'trim') turns.push({ date: l.date, text: l.text });
    else if (l.kind === 'stage') turns.push({ date: l.date, text: l.text });
  }
  const busiest = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (busiest && busiest[1] >= 2) turns.push({ date: busiest[0], text: `最忙的一天，推进了 ${busiest[1]} 件事` });
  turns.sort((a, b) => a.date.localeCompare(b.date));
  // 太长时只留开头、结尾和中间最重要的几条
  const trimmed = turns.length > 7 ? [...turns.slice(0, 3), ...turns.slice(-4)] : turns;

  return {
    start: p.createdAt,
    end,
    days: diffDays(p.createdAt, end) + 1,
    tasksDone: tasks.filter((t) => t.status === 'done').length,
    tasksDropped: tasks.filter((t) => t.status === 'dropped').length,
    bricks,
    activeDays: perDay.size,
    postpones: reasons.get('postponed') ?? 0,
    blockers,
    turns: trimmed,
  };
}
