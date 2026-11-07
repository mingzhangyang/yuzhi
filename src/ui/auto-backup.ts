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
import type { Data, ISODate } from '../types';
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
  private readonly supported: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store) {
    const supported = Boolean(picker())
      && typeof FileSystemFileHandle !== 'undefined'
      && 'createWritable' in FileSystemFileHandle.prototype;
    this.supported = supported;
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
    await this.reconcile();
    await this.refreshStatus();
  }

  /**
   * Re-read the folder choice before any backup work: another tab may have
   * chosen, replaced or stopped it while this tab was a reader. When device
   * storage cannot be read, keep the page-only choice this tab already has.
   */
  private async reconcile() {
    try {
      this.record = await deviceGet<AutoBackupRecord>(RECORD_KEY);
    } catch {
      // Device storage unavailable: fall back to what this page knows.
    }
  }

  /** Still the same folder choice as on disk? (Not stopped or replaced elsewhere.) */
  private async stillChosen(record: AutoBackupRecord): Promise<boolean> {
    let stored: AutoBackupRecord | undefined;
    try {
      stored = await deviceGet<AutoBackupRecord>(RECORD_KEY);
    } catch {
      return this.record?.handle === record.handle;
    }
    if (!stored) return false;
    try {
      return await stored.handle.isSameEntry(record.handle);
    } catch {
      return false;
    }
  }

  /**
   * Bind a backup to the writer lease and data snapshot it started under.
   * Returns null in a read-only tab.
   */
  private writeContext(): ReturnType<Store['captureBackupContext']> | null {
    if (this.store.isReadOnly) return null;
    try {
      return this.store.captureBackupContext();
    } catch {
      return null;
    }
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

  /** Returns false when device storage refused the write. */
  private async saveRecord(record: AutoBackupRecord | undefined): Promise<boolean> {
    this.record = record;
    try {
      if (record) await devicePut(RECORD_KEY, record);
      else await deviceDelete(RECORD_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /** Device storage that can be read at all (as opposed to refusing writes, e.g. a full quota). */
  private async deviceReadable(): Promise<boolean> {
    try {
      await deviceGet(RECORD_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write today's backup if due. Never prompts: a background run without
   * permission only reports that the user needs to allow it again.
   */
  run(reason: AutoBackupReason): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    const context = this.writeContext();
    if (!context) return Promise.resolve(false);
    const snapshot = this.store.committedSnapshot();
    snapshot.catch(() => {});
    return this.enqueue(async () => {
      // Without folder access there is nothing to run, and the "unsupported"
      // status (with its guidance) must not be replaced by "off".
      await this.ready;
      if (!context.isCurrent()) return false;
      await this.reconcile();
      const record = this.record;
      if (!record || !context.isCurrent()) {
        await this.refreshStatus();
        return false;
      }
      const today = this.store.today();
      if (!autoBackupDue(record.lastDate, today, reason)) {
        // Reconciling may have loaded a choice made in another tab.
        await this.refreshStatus();
        return false;
      }

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
      return this.write(record, today, context, snapshot);
    });
  }

  /**
   * Write one backup from the snapshot taken under `context`. If the writer
   * lease or data snapshot changes before the file is committed, the stream is
   * aborted, so a stale tab can never replace the new writer's file; the
   * browser only swaps a writable stream into place on close().
   */
  private async write(record: AutoBackupRecord, today: ISODate, context: ReturnType<Store['captureBackupContext']>, snapshot?: Promise<Data>): Promise<boolean> {
    if (!context.isCurrent()) return false;
    try {
      // Store.data can be ahead of the durable transaction, and later writes
      // may already be queued while we wait. Copy the last committed snapshot
      // instead of serializing the mutable in-memory view.
      const data = await (snapshot ?? this.store.committedSnapshot());
      if (!context.isCurrent()) return false;
      const text = exportBackup(data);
      const file = await record.handle.getFileHandle(autoBackupFileName(today), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(text);
        if (!context.isCurrent()) {
          await writable.abort().catch(() => {});
          return false;
        }
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      await this.prune(record.handle);
      // Never resurrect a choice another tab stopped or replaced meanwhile.
      if (await this.stillChosen(record)) await this.saveRecord({ ...record, lastDate: today, lastError: undefined });
      else await this.reconcile();
      markBackupExported(today);
      await this.refreshStatus();
      return true;
    } catch (error) {
      if (context.hasCurrentAccess() && await this.stillChosen(record)) await this.saveRecord({ ...record, lastError: errorText(error) });
      else await this.reconcile();
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
    const context = this.writeContext();
    if (!context) return Promise.resolve(false);
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
      if (!context.isCurrent()) return false;
      const record: AutoBackupRecord = { handle, folder: handle.name };
      const previous = this.record;
      if (!(await this.saveRecord(record)) && await this.deviceReadable()) {
        // Storage can be read but refused this write (for example a full
        // quota): the next reconcile would silently drop the choice, so say
        // the setup failed instead of pretending it was remembered. When
        // device storage is unavailable altogether, the choice simply lasts
        // for this page.
        this.record = previous;
        this.setStatus({ kind: 'error', folder: record.folder, lastDate: previous?.lastDate, message: t('auto.notRemembered') });
        return false;
      }
      return this.write(record, this.store.today(), context);
    });
  }

  /** Re-grant write access from a click, then back up right away. */
  allowAndRun(): Promise<boolean> {
    const record = this.record;
    const context = this.writeContext();
    if (!record || !context) return Promise.resolve(false);
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
      // The folder may have been stopped or replaced in another tab meanwhile.
      await this.reconcile();
      const current = this.record;
      if (!current || !(await current.handle.isSameEntry(record.handle).catch(() => false))) {
        await this.refreshStatus();
        return false;
      }
      return this.write(current, this.store.today(), context);
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
