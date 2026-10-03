import type { Project, SettlementEntry } from '../types';
import { STAGE_NAMES, type Stage } from './config';

export interface StageChange {
  project: Project;
  from: Stage;
  to: Stage;
}

const q = (p: Project) => `「${p.name}」`;

/** 阶段变化的一句话 */
export function stageChangeText(c: StageChange): string {
  if (c.to < c.from) return c.to === 0 ? `${q(c.project)}村落恢复了热闹` : `${q(c.project)}村落回暖了一些`;
  switch (c.to) {
    case 1:
      return `${q(c.project)}村落安静了下来`;
    case 2:
      return `${q(c.project)}村落的屋顶蒙上了灰`;
    case 3:
      return `${q(c.project)}村落有居民开始搬离`;
    default:
      return `${q(c.project)}村落进入「${STAGE_NAMES[c.to]}」`;
  }
}

/** 每天结算后自动写下的一行编年史 */
export function dayLine(entries: SettlementEntry[], projects: Map<string, Project>, changes: StageChange[]): string {
  const done = entries.filter((e) => e.outcome === 'done').length;
  const partial = entries.filter((e) => e.outcome === 'partial').length;
  const skipped = entries.filter((e) => e.outcome === 'skipped');
  const parts: string[] = [];

  if (done + partial === 0) parts.push(entries.length ? '这一天没有推进什么' : '这一天很安静');
  else {
    let s = `推进了 ${done} 件事`;
    if (partial) s += done ? `，另有 ${partial} 件做了一部分` : '';
    if (!done) s = `${partial} 件事做了一部分`;
    // 时间最多花在哪个村落
    const count = new Map<string, number>();
    for (const e of entries) if (e.outcome !== 'skipped' && e.projectId) count.set(e.projectId, (count.get(e.projectId) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    const tp = top && projects.get(top[0]);
    if (tp && count.size > 1) s += `，最忙的是${q(tp)}`;
    parts.push(s);
  }
  const better = changes.filter((c) => c.to < c.from);
  const worse = changes.filter((c) => c.to > c.from);
  for (const c of better) parts.push(stageChangeText(c));
  for (const c of worse) parts.push(stageChangeText(c));

  const noEnergy = skipped.filter((e) => e.reason === 'no_energy').length;
  const dropped = skipped.filter((e) => e.reason === 'not_important').length;
  const interrupted = skipped.filter((e) => e.reason === 'interrupted').length;
  if (dropped) parts.push(`放下了 ${dropped} 件不重要的事，腾出了空间`);
  if (interrupted) parts.push(`被打断了 ${interrupted} 次`);
  if (noEnergy) parts.push('有些累了，粮仓少了一点');
  return parts.join('，') + '。';
}
