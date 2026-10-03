/**
 * 规则里的可调数值集中在这里（交接文档里标了「初始值，之后可调」的部分）。
 */

/** 村落阶段：距上次真实推进的天数达到这些值时进入对应阶段 */
export const STAGE_START = [0, 7, 14, 28] as const;
export const STAGE_NAMES = ['正常', '安静', '蒙灰', '搬离'] as const;
export type Stage = 0 | 1 | 2 | 3;

/** 同一任务连续推迟达到这个次数，所属村落额外加重一档 */
export const POSTPONE_PENALTY_AT = 3;

/** 未结算的日子超过这么多天自动归档为「未记录」 */
export const ARCHIVE_AFTER_DAYS = 3;

/** 「做了一部分」在推进度里算多少件（衰败里算一天真实推进） */
export const PARTIAL_WEIGHT = 0.5;

/** 近 7 天每出现一次「没精力」，粮仓建议容量下调的比例 */
export const NO_ENERGY_CUT = 0.1;
/** 粮仓下调的下限 */
export const NO_ENERGY_FLOOR = 0.5;

/** 每个村落里同时走动的任务小人上限，超出部分只在标签上显示数字 */
export const MAX_WALKERS = 8;

/** 「缩小规模」后村落回到「安静」阶段的起点 */
export const TRIM_TO_NEGLECT = STAGE_START[1];

/** 「搬离」询问被暂缓后，隔多少天再问 */
export const PROMPT_SNOOZE_DAYS = 7;

/** 每这么多块砖（确认做了的条目）多盖一间房 */
export const BRICKS_PER_HOUSE = 3;

/** 日历导入的时间窗口 */
export const ICS_PAST_DAYS = 45;
export const ICS_FUTURE_DAYS = 120;

/** 岛上能同时容纳的活跃村落数 */
export const MAX_VILLAGES = 8;
