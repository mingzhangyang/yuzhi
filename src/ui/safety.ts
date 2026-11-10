/**
 * 数据安全：持久存储申请、备份提醒、「添加到主屏幕」说明。
 * 规则在 logic/backup.ts；这里只负责浏览器能力和页面上的提示条。
 */
import type { Store } from '../store';
import type { ISODate } from '../types';
import { $, download, esc, setText } from './dom';
import { localDate, relDay } from '../lib/date';
import { getLocale, t } from '../i18n';
import {
  dismissInstallHint,
  hasKeepsakeData,
  installHintFor,
  parseBackupReminderState,
  quietAutoBackupToday,
  recordBackupDone,
  safetyNotice,
  snoozeBackupReminder,
  type BackupReminderState,
  type InstallHint,
  type SafetyNotice,
} from '../logic/backup';
import type { AutoBackup } from './auto-backup';
import { readSettlementSnapshot } from './settlement-backup';

/** 按浏览器保存：要提醒的正是这个浏览器里的这一份数据。 */
export const SAFETY_STATE_KEY = 'yuzhi:data-safety';

/**
 * Set when localStorage refused a write (blocked storage, full quota). The
 * page then keeps using its own copy, so "Later", "Got it", "Not today" and
 * a successful export still take effect for this page.
 */
let pageOnlyState: BackupReminderState | undefined;

export function readSafetyState(): BackupReminderState {
  if (pageOnlyState) return pageOnlyState;
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
    pageOnlyState = undefined;
  } catch {
    pageOnlyState = state;
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

/** Phones and tablets: a share sheet beats a download that lands somewhere hard to find. */
function prefersShareSheet(): boolean {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

export type BackupDelivery = 'saved' | 'shared' | 'downloaded' | 'cancelled';

/** Only a completed writable stream is proof of a saved backup. */
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function savePicker(): SavePicker | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
}

function wasCancelled(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * Hand a backup file to the user. On touch devices that can share files this
 * opens the system share sheet ("Save to Files" puts it in iCloud Drive on
 * iOS); everywhere else, or if sharing fails, it downloads. Must be called
 * while the export click's user activation is still valid.
 */
export async function deliverBackup(name: string, text: string): Promise<BackupDelivery> {
  // Start the native picker before the click's user activation expires.
  // A picker/write error is not silently downgraded to a download.
  const pick = savePicker();
  if (pick && !prefersShareSheet()) {
    let handle: FileSystemFileHandle;
    try {
      handle = await pick({
        suggestedName: name,
        types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }],
      });
    } catch (error) {
      if (wasCancelled(error)) return 'cancelled';
      throw error;
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return 'saved';
  }
  if (prefersShareSheet() && typeof File !== 'undefined' && typeof navigator !== 'undefined' && navigator.canShare && navigator.share) {
    const file = new File([text], name, { type: 'application/json' });
    let shareable = false;
    try {
      shareable = navigator.canShare({ files: [file] });
    } catch {
      // Some engines throw for unsupported file types instead of returning false.
    }
    if (shareable) {
      try {
        await navigator.share({ files: [file] });
        return 'shared';
      } catch (error) {
        // Closing the sheet is a choice, not a failure: nothing was saved.
        if (wasCancelled(error)) return 'cancelled';
        // Anything else (permission, unsupported target): fall back to a download.
      }
    }
  }
  download(name, text);
  return 'downloaded';
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
    <p class="hint" data-safety-last>${esc(last)}</p>
    ${hint ? `<p class="hint">${esc(t(installKey(hint)))}</p>` : ''}
    <div class="btnrow"><button type="button" class="btn small" data-safety-export data-readonly-safe>${esc(t('safety.exportButton'))}</button></div>
    <p class="hint">${esc(t('safety.snapshotHint'))}</p>
    <p class="hint" data-safety-snapshot>${esc(t('safety.snapshotChecking'))}</p>
    <div class="btnrow"><button type="button" class="btn small" data-safety-snapshot-export data-readonly-safe hidden>${esc(t('safety.snapshotExport'))}</button></div>
    <div data-auto-backup></div>`;
}

/** Re-read the last-backup line, e.g. after an automatic backup ran from Settings. */
export function refreshSafetySettings(box: HTMLElement, today: ISODate) {
  const line = box.querySelector<HTMLElement>('[data-safety-last]');
  if (!line) return;
  const state = readSafetyState();
  setText(line, state.lastBackup ? t('safety.lastBackup', { when: relDay(state.lastBackup, today) }) : t('safety.neverBacked'));
}

export function fillSafetySettings(box: HTMLElement, isCurrent: () => boolean, canExportSnapshot = false, today: () => ISODate = localDate) {
  void persistenceStatus().then((status) => {
    const line = box.querySelector<HTMLElement>('[data-safety-storage]');
    if (!line || !isCurrent()) return;
    const key = status === 'persisted' ? 'safety.persisted' : status === 'best-effort' ? 'safety.bestEffort' : 'safety.unsupported';
    setText(line, t(key));
  });
  void readSettlementSnapshot().then((snapshot) => {
    const line = box.querySelector<HTMLElement>('[data-safety-snapshot]');
    const button = box.querySelector<HTMLButtonElement>('[data-safety-snapshot-export]');
    if (!line || !isCurrent()) return;
    setText(line, snapshot ? t('safety.snapshotReady', { when: relDay(snapshot.date, today()) }) : t('safety.snapshotNone'));
    if (button) button.hidden = !snapshot || !canExportSnapshot;
  }).catch(() => {
    const line = box.querySelector<HTMLElement>('[data-safety-snapshot]');
    if (line && isCurrent()) setText(line, t('safety.snapshotUnavailable'));
  });
}

/** The dismissible notice under the header. */
export class SafetyNoticeBar {
  private readonly bar = $('safetyNotice');
  private readonly text = $('safetyTxt');
  private readonly go = $<HTMLButtonElement>('safetyGo');
  private readonly later = $<HTMLButtonElement>('safetyLater');
  private notice: SafetyNotice | null = null;

  constructor(
    private readonly store: Store,
    private readonly exportBackup: () => void,
    private readonly autoBackup?: AutoBackup,
  ) {
    this.go.addEventListener('click', () => {
      const notice = this.notice;
      if (notice?.kind !== 'auto' || !this.autoBackup) {
        this.exportBackup();
        return;
      }
      // Both start a browser prompt, so they must run inside this click.
      void (notice.need === 'permission' ? this.autoBackup.allowAndRun() : this.autoBackup.choose()).finally(() => this.sync());
    });
    this.later.addEventListener('click', () => {
      const today = this.store.today();
      const state = readSafetyState();
      const kind = this.notice?.kind;
      writeSafetyState(kind === 'auto' ? quietAutoBackupToday(state, today)
        : kind === 'install' ? dismissInstallHint(state, today)
          : snoozeBackupReminder(state, today));
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

    const auto = this.store.isReadOnly ? null : this.autoBackup?.attention() ?? null;
    const notice = safetyNotice(data, readSafetyState(), this.store.today(), currentInstallHint(), auto);
    this.notice = notice;
    this.bar.hidden = !notice;
    if (!notice) return;

    if (notice.kind === 'auto') {
      const permission = notice.need === 'permission';
      setText(this.text, t(permission ? 'safety.autoPermission' : 'safety.autoFailed', { folder: notice.folder }));
      this.go.hidden = false;
      setText(this.go, t(permission ? 'safety.autoAllow' : 'safety.autoRechoose'));
      setText(this.later, t('safety.notToday'));
      return;
    }

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
