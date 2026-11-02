/**
 * 数据安全：持久存储申请、备份提醒、「添加到主屏幕」说明。
 * 规则在 logic/backup.ts；这里只负责浏览器能力和页面上的提示条。
 */
import type { Store } from '../store';
import type { ISODate } from '../types';
import { $, esc, setText } from './dom';
import { relDay } from '../lib/date';
import { getLocale, t } from '../i18n';
import {
  dismissInstallHint,
  hasKeepsakeData,
  installHintFor,
  parseBackupReminderState,
  recordBackupDone,
  safetyNotice,
  snoozeBackupReminder,
  type BackupReminderState,
  type InstallHint,
} from '../logic/backup';

/** 按浏览器保存：要提醒的正是这个浏览器里的这一份数据。 */
export const SAFETY_STATE_KEY = 'yuzhi:data-safety';

export function readSafetyState(): BackupReminderState {
  try {
    const raw = localStorage.getItem(SAFETY_STATE_KEY);
    return raw ? parseBackupReminderState(JSON.parse(raw)) : {};
  } catch {
    // Private browsing or blocked storage: behave as if nothing was recorded.
    return {};
  }
}

function writeSafetyState(state: BackupReminderState) {
  try {
    localStorage.setItem(SAFETY_STATE_KEY, JSON.stringify(state));
  } catch {
    // Reminders are a convenience; failing to remember a snooze is harmless.
  }
}

export function markBackupExported(today: ISODate) {
  writeSafetyState(recordBackupDone(readSafetyState(), today));
}

export function currentInstallHint(): InstallHint | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { standalone?: boolean };
  let standalone = nav.standalone === true;
  try {
    standalone ||= window.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    // matchMedia is a progressive enhancement.
  }
  return installHintFor({ userAgent: nav.userAgent ?? '', maxTouchPoints: nav.maxTouchPoints ?? 0, standalone });
}

export type PersistenceStatus = 'persisted' | 'best-effort' | 'unsupported';

function storageManager(): StorageManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.storage : undefined;
}

export async function persistenceStatus(): Promise<PersistenceStatus> {
  const storage = storageManager();
  if (!storage?.persisted) return 'unsupported';
  try {
    return (await storage.persisted()) ? 'persisted' : 'best-effort';
  } catch {
    return 'unsupported';
  }
}

let persistRequest: Promise<PersistenceStatus> | undefined;

/**
 * Ask once per page for persistent storage, so the browser does not evict the
 * island under storage pressure. Chromium decides silently; Firefox may show a
 * prompt, which is why this waits until the island holds something worth
 * keeping (normally right after the user's first save).
 */
export function requestPersistentStorage(): Promise<PersistenceStatus> {
  persistRequest ??= (async () => {
    const storage = storageManager();
    if (!storage?.persist) return 'unsupported';
    try {
      if (await storage.persisted?.()) return 'persisted';
      return (await storage.persist()) ? 'persisted' : 'best-effort';
    } catch {
      return 'unsupported';
    }
  })();
  return persistRequest;
}

const installKey = (hint: InstallHint) => (hint === 'ios' ? 'safety.installIos' : 'safety.installMac');

/** Settings section: how safe this browser's copy is right now. */
export function safetySettingsHtml(today: ISODate): string {
  const state = readSafetyState();
  const hint = currentInstallHint();
  const last = state.lastBackup
    ? t('safety.lastBackup', { when: relDay(state.lastBackup, today) })
    : t('safety.neverBacked');
  return `<div class="sect">${esc(t('safety.title'))}</div>
    <p class="hint" data-safety-storage>${esc(t('safety.checking'))}</p>
    <p class="hint">${esc(last)}</p>
    ${hint ? `<p class="hint">${esc(t(installKey(hint)))}</p>` : ''}
    <div class="btnrow"><button type="button" class="btn small" data-safety-export data-readonly-safe>${esc(t('safety.exportButton'))}</button></div>`;
}

export function fillSafetySettings(box: HTMLElement, isCurrent: () => boolean) {
  void persistenceStatus().then((status) => {
    const line = box.querySelector<HTMLElement>('[data-safety-storage]');
    if (!line || !isCurrent()) return;
    const key = status === 'persisted' ? 'safety.persisted' : status === 'best-effort' ? 'safety.bestEffort' : 'safety.unsupported';
    setText(line, t(key));
  });
}

/** The dismissible notice under the header. */
export class SafetyNoticeBar {
  private readonly bar = $('safetyNotice');
  private readonly text = $('safetyTxt');
  private readonly go = $<HTMLButtonElement>('safetyGo');
  private readonly later = $<HTMLButtonElement>('safetyLater');
  private kind: 'backup' | 'install' | null = null;

  constructor(
    private readonly store: Store,
    private readonly exportBackup: () => void,
  ) {
    this.go.addEventListener('click', () => this.exportBackup());
    this.later.addEventListener('click', () => {
      const today = this.store.today();
      const state = readSafetyState();
      writeSafetyState(this.kind === 'install' ? dismissInstallHint(state, today) : snoozeBackupReminder(state, today));
      this.sync();
    });
    // Another tab may export or snooze; keep every open tab consistent.
    window.addEventListener('storage', (event) => {
      if (event.key === SAFETY_STATE_KEY || event.key === null) this.sync();
    });
  }

  sync() {
    const data = this.store.data;
    if (hasKeepsakeData(data)) void requestPersistentStorage();

    const notice = safetyNotice(data, readSafetyState(), this.store.today(), currentInstallHint());
    this.kind = notice?.kind ?? null;
    this.bar.hidden = !notice;
    if (!notice) return;

    const install = notice.installHint ? t(installKey(notice.installHint)) : '';
    if (notice.kind === 'backup') {
      const lead = notice.days === null ? t('safety.backupNever') : t('safety.backupDue', { days: notice.days });
      // Chinese sentences join without a space after 。
      setText(this.text, install ? lead + (getLocale() === 'zh-CN' ? '' : ' ') + install : lead);
      this.go.hidden = false;
      setText(this.go, t('safety.exportNow'));
      setText(this.later, t('safety.later'));
    } else {
      // Installing starts an empty, separate island: keep the export that the
      // move depends on one click away.
      setText(this.text, install);
      this.go.hidden = false;
      setText(this.go, t('safety.exportNow'));
      setText(this.later, t('safety.gotIt'));
    }
  }
}
