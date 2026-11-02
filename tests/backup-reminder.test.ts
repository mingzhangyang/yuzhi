import { describe, expect, it } from 'vitest';
import { emptyData } from '../src/db';
import {
  dismissInstallHint,
  hasKeepsakeData,
  installHintFor,
  parseBackupReminderState,
  recordBackupDone,
  safetyNotice,
  snoozeBackupReminder,
} from '../src/logic/backup';
import { LOCAL_CALENDAR_SOURCE_ID, type Data } from '../src/types';

function island(firstDay: string, fill: (data: Data) => void = (data) => {
  data.projects.push({ id: 'p1', name: '屿志推广', createdAt: firstDay, status: 'active', islandSlot: 0 });
}): Data {
  const data = emptyData();
  data.settings.firstDay = firstDay;
  fill(data);
  return data;
}

describe('备份提醒', () => {
  it('空岛不提醒，也不需要申请持久存储', () => {
    const data = island('2026-10-01', () => {});
    expect(hasKeepsakeData(data)).toBe(false);
    expect(safetyNotice(data, {}, '2026-11-01', 'ios')).toBeNull();
  });

  it('订阅来的日历可以重新拉取，不算要保护的数据；本地日程和日记算', () => {
    const subscribed = island('2026-10-01', (data) => {
      data.events.push({ id: 'e1', sourceId: 'work', uid: 'u', title: '会', start: '2026-10-01T01:00:00Z', end: '2026-10-01T02:00:00Z', allDay: false, classified: false });
    });
    expect(hasKeepsakeData(subscribed)).toBe(false);
    subscribed.events[0].sourceId = LOCAL_CALENDAR_SOURCE_ID;
    expect(hasKeepsakeData(subscribed)).toBe(true);
    expect(hasKeepsakeData(island('2026-10-01', (data) => {
      data.diaries.push({ id: 'd1', date: '2026-10-01', text: '搬进小岛', createdAt: '2026-10-01T12:00:00Z' });
    }))).toBe(true);
  });

  it('从没导出过：从第一天算起满 14 天才提醒', () => {
    const data = island('2026-11-01');
    expect(safetyNotice(data, {}, '2026-11-14', null)).toBeNull();
    expect(safetyNotice(data, {}, '2026-11-15', null)).toEqual({ kind: 'backup', days: null, installHint: null });
  });

  it('导出过：距上次导出满 14 天再提醒，并给出天数', () => {
    const data = island('2026-09-01');
    const state = recordBackupDone({}, '2026-10-20');
    expect(safetyNotice(data, state, '2026-11-02', null)).toBeNull();
    expect(safetyNotice(data, state, '2026-11-03', 'mac')).toEqual({ kind: 'backup', days: 14, installHint: 'mac' });
  });

  it('「稍后」安静 7 天；导出会清掉稍后', () => {
    const data = island('2026-09-01');
    const snoozed = snoozeBackupReminder({}, '2026-11-01');
    expect(snoozed.snoozedUntil).toBe('2026-11-08');
    expect(safetyNotice(data, snoozed, '2026-11-07', null)).toBeNull();
    expect(safetyNotice(data, snoozed, '2026-11-08', null)?.kind).toBe('backup');
    expect(recordBackupDone(snoozed, '2026-11-02')).toEqual({ lastBackup: '2026-11-02' });
  });

  it('苹果浏览器没装到主屏幕时，即使刚备份过也说明一次；「知道了」安静 30 天', () => {
    const data = island('2026-11-01');
    const backedUp = recordBackupDone({}, '2026-11-01');
    expect(safetyNotice(data, backedUp, '2026-11-02', 'ios')).toEqual({ kind: 'install', installHint: 'ios' });
    // Keep backups recent so only the install hint's own quiet period matters.
    const dismissed = { ...dismissInstallHint(backedUp, '2026-11-02'), lastBackup: '2026-11-25' };
    expect(safetyNotice(data, dismissed, '2026-12-01', 'ios')).toBeNull();
    expect(safetyNotice(data, dismissed, '2026-12-02', 'ios')).toEqual({ kind: 'install', installHint: 'ios' });
    // A due backup reminder takes priority and carries the install hint along.
    expect(safetyNotice(data, backedUp, '2026-12-01', 'ios')).toEqual({ kind: 'backup', days: 30, installHint: 'ios' });
    expect(safetyNotice(data, backedUp, '2026-11-02', null)).toBeNull();
  });

  it('本地记录损坏时当作什么都没记过', () => {
    expect(parseBackupReminderState(null)).toEqual({});
    expect(parseBackupReminderState('oops')).toEqual({});
    expect(parseBackupReminderState({ lastBackup: '0002-11-03', snoozedUntil: 7, installHintUntil: '2026-12-01' }))
      .toEqual({ installHintUntil: '2026-12-01' });
  });
});

describe('添加到主屏幕说明', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const windowsChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  it('iPhone / iPad 上的任何浏览器，以及 Mac 上的 Safari', () => {
    expect(installHintFor({ userAgent: iphone, maxTouchPoints: 5, standalone: false })).toBe('ios');
    expect(installHintFor({ userAgent: ipadDesktop, maxTouchPoints: 5, standalone: false })).toBe('ios');
    expect(installHintFor({ userAgent: ipadDesktop, maxTouchPoints: 0, standalone: false })).toBe('mac');
  });

  it('已经从主屏幕打开、或不是苹果的 WebKit 时不说明', () => {
    expect(installHintFor({ userAgent: iphone, maxTouchPoints: 5, standalone: true })).toBeNull();
    expect(installHintFor({ userAgent: macChrome, maxTouchPoints: 0, standalone: false })).toBeNull();
    expect(installHintFor({ userAgent: windowsChrome, maxTouchPoints: 0, standalone: false })).toBeNull();
  });
});
