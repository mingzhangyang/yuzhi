/**
 * Automatic backup into a folder the user picked once (File System Access API,
 * desktop Chrome / Edge). Picking a folder that a cloud client syncs (iCloud
 * Drive, Dropbox, OneDrive) turns this into an off-browser copy.
 *
 * One file per day (yuzhi-auto-YYYY-MM-DD.json), written on the first chance
 * each day and again after every evening settlement; only our own files are
 * pruned, keeping the latest AUTO_BACKUP_KEEP. Rules live in logic/backup.ts.
 */
import type { Store } from '../store';
import type { ISODate } from '../types';
import { exportBackup } from '../db';
import { relDay } from '../lib/date';
import { t } from '../i18n';
import { esc } from './dom';
import { deviceDelete, deviceGet, devicePut } from './device-store';
import { markBackupExported } from './safety';
import {
  autoBackupDue,
  autoBackupFileName,
  autoBackupsToPrune,
  type AutoBackupAttention,
  type AutoBackupReason,
} from '../logic/backup';

type ReadWrite = { mode: 'readwrite' };
/** Permission methods are not in TypeScript's DOM lib yet. */
type FolderHandle = FileSystemDirectoryHandle & {
  queryPermission?(descriptor: ReadWrite): Promise<PermissionState>;
  requestPermission?(descriptor: ReadWrite): Promise<PermissionState>;
  keys?(): AsyncIterable<string>;
};
type DirectoryPicker = (options?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;

interface AutoBackupRecord {
  handle: FolderHandle;
  folder: string;
  lastDate?: ISODate;
  lastError?: string;
}

const RECORD_KEY = 'autoBackup';
const READ_WRITE: ReadWrite = { mode: 'readwrite' };

export type AutoBackupStatus =
  | { kind: 'unsupported' }
  | { kind: 'off' }
  | { kind: 'ready'; folder: string; lastDate?: ISODate }
  | { kind: 'needs-permission'; folder: string; lastDate?: ISODate }
  | { kind: 'error'; folder: string; lastDate?: ISODate; message: string };

function picker(): DirectoryPicker | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError';

export class AutoBackup {
  status: AutoBackupStatus;
  /** Called whenever status changes (the notice bar and settings re-render). */
  onChange: () => void = () => {};
  private record: AutoBackupRecord | undefined;
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store) {
    const supported = Boolean(picker())
      && typeof FileSystemFileHandle !== 'undefined'
      && 'createWritable' in FileSystemFileHandle.prototype;
    this.status = supported ? { kind: 'off' } : { kind: 'unsupported' };
    this.ready = supported ? this.load() : Promise.resolve();
  }

  /** For the notice bar: what, if anything, needs the user right now. */
  attention(): AutoBackupAttention | null {
    const s = this.status;
    if (s.kind === 'needs-permission') return { need: 'permission', folder: s.folder, lastDate: s.lastDate };
    if (s.kind === 'error') return { need: 'error', folder: s.folder, lastDate: s.lastDate };
    return null;
  }

  private setStatus(status: AutoBackupStatus) {
    this.status = status;
    try { this.onChange(); } catch { /* observers must not break backups */ }
  }

  /** Serialize every operation: a settlement backup and a daily backup must not interleave. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }

  private async load() {
    try {
      this.record = await deviceGet<AutoBackupRecord>(RECORD_KEY);
    } catch {
      this.record = undefined;
    }
    await this.refreshStatus();
  }

  private async refreshStatus() {
    const record = this.record;
    if (!record) {
      this.setStatus({ kind: 'off' });
      return;
    }
    let permission: PermissionState = 'granted';
    try {
      permission = (await record.handle.queryPermission?.(READ_WRITE)) ?? 'granted';
    } catch {
      permission = 'prompt';
    }
    const base = { folder: record.folder, lastDate: record.lastDate };
    if (permission !== 'granted') this.setStatus({ kind: 'needs-permission', ...base });
    else if (record.lastError) this.setStatus({ kind: 'error', ...base, message: record.lastError });
    else this.setStatus({ kind: 'ready', ...base });
  }

  private async saveRecord(record: AutoBackupRecord | undefined) {
    this.record = record;
    try {
      if (record) await devicePut(RECORD_KEY, record);
      else await deviceDelete(RECORD_KEY);
    } catch {
      // Device storage unavailable: the choice lasts for this page only.
    }
  }

  /**
   * Write today's backup if due. Never prompts: a background run without
   * permission only reports that the user needs to allow it again.
   */
  run(reason: AutoBackupReason): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready;
      const record = this.record;
      if (!record || this.store.isReadOnly) return false;
      const today = this.store.today();
      if (!autoBackupDue(record.lastDate, today, reason)) return false;

      let permission: PermissionState = 'granted';
      try {
        permission = (await record.handle.queryPermission?.(READ_WRITE)) ?? 'granted';
      } catch {
        permission = 'prompt';
      }
      if (permission !== 'granted') {
        this.setStatus({ kind: 'needs-permission', folder: record.folder, lastDate: record.lastDate });
        return false;
      }
      return this.write(record, today);
    });
  }

  private async write(record: AutoBackupRecord, today: ISODate): Promise<boolean> {
    try {
      const text = exportBackup(this.store.data);
      const file = await record.handle.getFileHandle(autoBackupFileName(today), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      await this.prune(record.handle);
      await this.saveRecord({ ...record, lastDate: today, lastError: undefined });
      markBackupExported(today);
      await this.refreshStatus();
      return true;
    } catch (error) {
      await this.saveRecord({ ...record, lastError: errorText(error) });
      await this.refreshStatus();
      return false;
    }
  }

  private async prune(handle: FolderHandle) {
    try {
      const names: string[] = [];
      if (!handle.keys) return;
      for await (const name of handle.keys()) names.push(name);
      for (const name of autoBackupsToPrune(names)) await handle.removeEntry(name).catch(() => {});
    } catch {
      // Pruning is housekeeping; a fresh backup already exists.
    }
  }

  /** Pick (or re-pick) the folder from a click, then back up right away. */
  choose(): Promise<boolean> {
    const pick = picker();
    if (!pick) return Promise.resolve(false);
    // Open the picker inside the click's user activation, before any await.
    const picked = pick({ id: 'yuzhi-auto-backup', mode: 'readwrite', startIn: 'documents' });
    return this.enqueue(async () => {
      let handle: FolderHandle;
      try {
        handle = await picked;
      } catch (error) {
        if (!isAbort(error)) this.setStatus(this.record ? { kind: 'error', folder: this.record.folder, lastDate: this.record.lastDate, message: errorText(error) } : { kind: 'off' });
        return false;
      }
      const record: AutoBackupRecord = { handle, folder: handle.name };
      await this.saveRecord(record);
      return this.write(record, this.store.today());
    });
  }

  /** Re-grant write access from a click, then back up right away. */
  allowAndRun(): Promise<boolean> {
    const record = this.record;
    if (!record) return Promise.resolve(false);
    // requestPermission must start inside the click's user activation.
    const asked = record.handle.requestPermission?.(READ_WRITE) ?? Promise.resolve<PermissionState>('granted');
    return this.enqueue(async () => {
      let permission: PermissionState;
      try {
        permission = await asked;
      } catch {
        permission = 'denied';
      }
      if (permission !== 'granted') {
        await this.refreshStatus();
        return false;
      }
      return this.write(this.record ?? record, this.store.today());
    });
  }

  /** Back up now from a click (asks for permission first if needed). */
  runNow(): Promise<boolean> {
    if (this.status.kind === 'needs-permission') return this.allowAndRun();
    return this.run('manual');
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.saveRecord(undefined);
      this.setStatus({ kind: 'off' });
    });
  }

  /** Settings → Data safety → automatic backup controls. */
  mountSettings(container: HTMLElement, today: () => ISODate, afterRender: () => void = () => {}) {
    const render = () => {
      if (!container.isConnected) return;
      container.innerHTML = this.settingsHtml(today());
      afterRender();
    };
    container.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-auto]')?.dataset.auto;
      if (!action) return;
      const done = action === 'choose' ? this.choose()
        : action === 'run' ? this.runNow()
          : action === 'stop' ? this.stop()
            : Promise.resolve();
      void done.finally(render);
    });
    render();
    void this.ready.then(render);
  }

  private settingsHtml(today: ISODate): string {
    const s = this.status;
    const button = (action: string, label: string, primary = false) =>
      `<button type="button" class="btn small${primary ? ' primary' : ''}" data-auto="${action}">${esc(label)}</button>`;
    if (s.kind === 'unsupported') return `<p class="hint">${esc(t('auto.unsupported'))}</p>`;
    if (s.kind === 'off') {
      return `<p class="hint">${esc(t('auto.offHint'))}</p><div class="btnrow">${button('choose', t('auto.choose'), true)}</div>`;
    }
    const last = s.lastDate ? relDay(s.lastDate, today) : t('auto.never');
    if (s.kind === 'ready') {
      return `<p class="hint">${esc(t('auto.ready', { folder: s.folder, when: last }))}</p><div class="btnrow">${button('run', t('auto.runNow'))}${button('choose', t('auto.change'))}${button('stop', t('auto.stop'))}</div>`;
    }
    if (s.kind === 'needs-permission') {
      return `<p class="hint">${esc(t('auto.needsPermission', { folder: s.folder, when: last }))}</p><div class="btnrow">${button('run', t('auto.allow'), true)}${button('stop', t('auto.stop'))}</div>`;
    }
    return `<p class="hint">${esc(t('auto.failed', { folder: s.folder, error: s.message }))}</p><div class="btnrow">${button('choose', t('auto.rechoose'), true)}${button('stop', t('auto.stop'))}</div>`;
  }
}
