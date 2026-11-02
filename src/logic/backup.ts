/**
 * 数据安全提醒的纯规则。屿志的数据只存在当前浏览器里：这里决定什么时候提醒用户
 * 导出备份、什么时候说明「添加到主屏幕」能让浏览器不再清理数据。不碰 DOM 和存储。
 */
import type { Data, ISODate } from '../types';
import { addDays, diffDays, isPlausibleDate } from '../lib/date';
import { AUTO_BACKUP_KEEP, BACKUP_REMIND_AFTER_DAYS, BACKUP_SNOOZE_DAYS, INSTALL_HINT_SNOOZE_DAYS } from './config';

/** 这台浏览器上的提醒状态（按浏览器保存，因为风险就在这一份本地数据上）。 */
export interface BackupReminderState {
  /** 最近一次在这个浏览器里导出备份的日子 */
  lastBackup?: ISODate;
  /** 备份提醒在这一天之前保持安静 */
  snoozedUntil?: ISODate;
  /** 安装说明在这一天之前保持安静 */
  installHintUntil?: ISODate;
  /** 自动备份需要处理（重新授权 / 出错）的提示在这一天之前保持安静 */
  autoQuietUntil?: ISODate;
}

/**
 * 苹果的 WebKit 会清理长期没访问的网站数据（Safari 约 7 天），装到主屏幕 / 程序坞后打开则不会。
 * ios 覆盖 iPhone / iPad 上的所有浏览器（都是 WebKit）；mac 只指 Mac 上的 Safari。
 */
export type InstallHint = 'ios' | 'mac';

/** 自动备份当前是否需要用户动手：浏览器要求重新允许写入，或上次写入失败。 */
export interface AutoBackupAttention {
  need: 'permission' | 'error';
  folder: string;
  /** 最近一次成功自动备份的日子 */
  lastDate?: ISODate;
}

export type SafetyNotice =
  | { kind: 'auto'; need: AutoBackupAttention['need']; folder: string }
  | { kind: 'backup'; /** 距上次导出的天数；从没导出过时为 null */ days: number | null; installHint: InstallHint | null }
  | { kind: 'install'; installHint: InstallHint };

/**
 * 丢了会心疼的数据：用户亲手记下的东西。只有带订阅链接的日历能重新拉取，不算；
 * 本地日程和上传的 .ics 文件（原文件不在屿志手里）都算。
 */
export function hasKeepsakeData(data: Data): boolean {
  if (data.projects.length || data.tasks.length || data.diaries.length || data.entries.length) return true;
  const refetchable = new Set(data.sources.filter((source) => source.icsUrl).map((source) => source.id));
  return data.events.some((event) => !refetchable.has(event.sourceId));
}

export function parseBackupReminderState(raw: unknown): BackupReminderState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const state: BackupReminderState = {};
  if (isPlausibleDate(row.lastBackup)) state.lastBackup = row.lastBackup;
  if (isPlausibleDate(row.snoozedUntil)) state.snoozedUntil = row.snoozedUntil;
  if (isPlausibleDate(row.installHintUntil)) state.installHintUntil = row.installHintUntil;
  if (isPlausibleDate(row.autoQuietUntil)) state.autoQuietUntil = row.autoQuietUntil;
  return state;
}

export const recordBackupDone = (state: BackupReminderState, today: ISODate): BackupReminderState =>
  ({ ...state, lastBackup: today, snoozedUntil: undefined });

export const snoozeBackupReminder = (state: BackupReminderState, today: ISODate): BackupReminderState =>
  ({ ...state, snoozedUntil: addDays(today, BACKUP_SNOOZE_DAYS) });

export const dismissInstallHint = (state: BackupReminderState, today: ISODate): BackupReminderState =>
  ({ ...state, installHintUntil: addDays(today, INSTALL_HINT_SNOOZE_DAYS) });

/** 自动备份的提示一天最多出现一次：点「今天先不」安静到明天。 */
export const quietAutoBackupToday = (state: BackupReminderState, today: ISODate): BackupReminderState =>
  ({ ...state, autoQuietUntil: addDays(today, 1) });

/** 当前该不该提醒、提醒什么。备份提醒优先，并顺带给出安装说明。 */
export function safetyNotice(
  data: Data,
  state: BackupReminderState,
  today: ISODate,
  installHint: InstallHint | null,
  auto: AutoBackupAttention | null = null,
): SafetyNotice | null {
  if (!hasKeepsakeData(data)) return null;

  // An automatic backup that silently stopped is the most urgent thing to
  // say, but only once today's copy is actually missing.
  const autoQuiet = state.autoQuietUntil !== undefined && today < state.autoQuietUntil;
  if (auto && auto.lastDate !== today && !autoQuiet) return { kind: 'auto', need: auto.need, folder: auto.folder };

  const since = state.lastBackup ?? data.settings.firstDay;
  const age = diffDays(since, today);
  const snoozed = state.snoozedUntil !== undefined && today < state.snoozedUntil;
  const installQuiet = state.installHintUntil !== undefined && today < state.installHintUntil;
  if (age >= BACKUP_REMIND_AFTER_DAYS && !snoozed) {
    return { kind: 'backup', days: state.lastBackup ? age : null, installHint: installQuiet ? null : installHint };
  }

  // "Later" on a backup notice that carried the install hint quiets the whole
  // bar; the hint must not take over the moment the reminder is snoozed.
  if (installHint && !installQuiet && !snoozed) return { kind: 'install', installHint };
  return null;
}

export interface BrowserTraits {
  userAgent: string;
  maxTouchPoints: number;
  /** 已经从主屏幕 / 程序坞以独立窗口打开 */
  standalone: boolean;
}

export function installHintFor(traits: BrowserTraits): InstallHint | null {
  if (traits.standalone) return null;
  const ua = traits.userAgent;
  // iPadOS 默认以桌面版 Safari 的身份访问，只能靠触点数区分。
  if (/iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && traits.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua)) return 'mac';
  return null;
}

/* ---------------- 自动备份到文件夹 ---------------- */

/**
 * 自动备份用自己的文件名前缀，和手动导出的 yuzhi-backup-*.json 分开：
 * 清理旧备份时只动自己写的文件，即使用户选的是「下载」文件夹。
 */
const AUTO_FILE = /^yuzhi-auto-(\d{4}-\d{2}-\d{2})\.json$/;

export const autoBackupFileName = (date: ISODate) => `yuzhi-auto-${date}.json`;

/** 文件夹里该删掉的旧自动备份：只看本程序写的文件，保留日期最新的 keep 份。 */
export function autoBackupsToPrune(names: Iterable<string>, keep = AUTO_BACKUP_KEEP): string[] {
  const ours = [...names].filter((name) => {
    const m = AUTO_FILE.exec(name);
    return Boolean(m && isPlausibleDate(m[1]));
  }).sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/** daily：每天第一次机会存一份；settled / manual：每次都存（覆盖当天那份）。 */
export type AutoBackupReason = 'daily' | 'settled' | 'manual';

export function autoBackupDue(lastDate: ISODate | undefined, today: ISODate, reason: AutoBackupReason): boolean {
  return reason !== 'daily' || lastDate !== today;
}
