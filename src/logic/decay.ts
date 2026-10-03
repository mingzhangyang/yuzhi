import type { Data, ISODate, Project, SettlementEntry } from '../types';
import { addDays } from '../lib/date';
import { POSTPONE_PENALTY_AT, STAGE_START, type Stage } from './config';
import { dayStatusFn, type DayStatus } from './days';

export interface VillageState {
  /** 折算后的「荒置天数」 */
  neglect: number;
  /** 只看天数得到的阶段 */
  baseStage: Stage;
  /** 连续推迟带来的额外一档 */
  postponePenalty: boolean;
  /** 最终阶段 */
  stage: Stage;
  /** 距上次真实推进的天数（展示用） */
  daysSinceProgress: number;
}

export function stageOfNeglect(n: number): Stage {
  if (n >= STAGE_START[3]) return 3;
  if (n >= STAGE_START[2]) return 2;
  if (n >= STAGE_START[1]) return 1;
  return 0;
}

/** 一天真实推进：回退一个阶段（回到上一阶段的起点） */
export function recoverOne(neglect: number): number {
  const s = stageOfNeglect(neglect);
  return s === 0 ? 0 : STAGE_START[s - 1];
}

/** 当天某项目的条目对衰败意味着什么 */
export function dayEffect(entries: SettlementEntry[]): 'progress' | 'freeze' | 'idle' {
  if (entries.some((e) => e.outcome === 'done' || e.outcome === 'partial')) return 'progress';
  // 没精力不伤害村落；不重要了不算惩罚
  if (entries.length && entries.every((e) => e.outcome === 'skipped' && (e.reason === 'no_energy' || e.reason === 'not_important'))) return 'freeze';
  return 'idle';
}

/**
 * 从立项（或最近一次重新启动 / 缩小规模）起逐日重放，得到村落现在的样子。
 * - 已结算的日子：有推进则回退一阶段，否则荒置天数 +1（没精力 / 不重要了 不计）
 * - 没有任何条目的日子：时间照样流逝，荒置天数 +1
 * - 还没结算的日子、归档为「未记录」的日子：不产生任何后果（单独记下的「做了」仍然算推进）
 * 今天还没过完：只有今天已经结算过才计入。
 */
export function computeVillage(
  project: Project,
  entriesByDate: Map<ISODate, SettlementEntry[]>,
  statusOf: (d: ISODate) => DayStatus,
  hasHeavyPostpone: boolean,
  today: ISODate,
): VillageState {
  const resets = (project.resets ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  let neglect = 0;
  let start = project.createdAt;
  const last = resets[resets.length - 1];
  if (last && last.date >= start) {
    start = last.date;
    neglect = last.neglect;
  }
  let sinceProgress = 0;
  const end = statusOf(today) === 'settled' ? today : addDays(today, -1);
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const st = statusOf(d);
    const eff = st === 'empty' ? 'idle' : dayEffect(entriesByDate.get(d) ?? []);
    // 未结算、未记录的日子不产生后果；但已经明确记下的推进照样算数
    if ((st === 'pending' || st === 'unrecorded') && eff !== 'progress') continue;
    if (eff === 'progress') {
      neglect = recoverOne(neglect);
      sinceProgress = 0;
    } else if (eff === 'idle' && d !== start) {
      // 立项（或重启）当天本身不算荒置
      neglect += 1;
      sinceProgress += 1;
    }
  }
  const baseStage = stageOfNeglect(neglect);
  const stage = Math.min(3, baseStage + (hasHeavyPostpone ? 1 : 0)) as Stage;
  return { neglect, baseStage, postponePenalty: hasHeavyPostpone, stage, daysSinceProgress: sinceProgress };
}

/** 计算所有活跃项目的村落状态 */
export function computeAllVillages(data: Data, today: ISODate): Map<string, VillageState> {
  const statusOf = dayStatusFn(data, today);
  const byProject = new Map<string, Map<ISODate, SettlementEntry[]>>();
  for (const e of data.entries) {
    if (!e.projectId) continue;
    let m = byProject.get(e.projectId);
    if (!m) byProject.set(e.projectId, (m = new Map()));
    const arr = m.get(e.date);
    if (arr) arr.push(e);
    else m.set(e.date, [e]);
  }
  const out = new Map<string, VillageState>();
  for (const p of data.projects) {
    if (p.status !== 'active') continue;
    const heavy = data.tasks.some((t) => t.projectId === p.id && t.status === 'open' && t.postponeCount >= POSTPONE_PENALTY_AT);
    out.set(p.id, computeVillage(p, byProject.get(p.id) ?? new Map(), statusOf, heavy, today));
  }
  return out;
}
