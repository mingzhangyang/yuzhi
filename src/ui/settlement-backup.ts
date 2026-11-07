/**
 * A last-known-good settlement snapshot, kept in this browser even where a
 * user-chosen folder is not available. This is not an off-device backup:
 * clearing site data can remove it together with the island database.
 */
import { exportBackup, parseBackup } from '../db';
import { isPlausibleDate } from '../lib/date';
import type { Store } from '../store';
import type { ISODate } from '../types';
import { deviceGet, devicePutIfCurrent } from './device-store';

const SNAPSHOT_KEY = 'lastSettlementSnapshot';

export interface SettlementSnapshot {
  date: ISODate;
  json: string;
  diaryCount: number;
}

/** Check stored data before offering it for export, including older versions. */
export async function readSettlementSnapshot(): Promise<SettlementSnapshot | undefined> {
  const value = await deviceGet<unknown>(SNAPSHOT_KEY);
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid settlement snapshot');
  const row = value as { date?: unknown; json?: unknown };
  if (!isPlausibleDate(row.date) || typeof row.json !== 'string') throw new Error('Invalid settlement snapshot');
  const data = parseBackup(row.json);
  return { date: row.date, json: row.json, diaryCount: data.diaries.length };
}

export class SettlementBackup {
  private queue: Promise<unknown> = Promise.resolve();
  private failedDate?: ISODate;
  onChange: () => void = () => {};

  constructor(private readonly store: Store) {
    // A failed date belongs to one island/session generation. Imports, reloads,
    // and lease changes must not carry an unretryable warning into new data.
    store.subscribeBackupContextReset(() => {
      if (this.failedDate === undefined) return;
      this.failedDate = undefined;
      this.reportChanged();
    });
  }

  private reportChanged() {
    try { this.onChange(); } catch { /* reporting must not affect backup */ }
  }

  get failed(): boolean { return this.failedDate !== undefined; }

  /** Capture the settlement's write generation before any later action. */
  run(date: ISODate): Promise<boolean> {
    return this.enqueueSnapshot(date, false);
  }

  /** On startup or takeover, fill a missing snapshot without replacing an older recovery point. */
  ensure(date: ISODate): Promise<boolean> {
    return this.enqueueSnapshot(date, true);
  }

  private enqueueSnapshot(date: ISODate, onlyIfMissing: boolean): Promise<boolean> {
    let context: ReturnType<Store['captureBackupContext']>;
    try { context = this.store.captureBackupContext(); } catch { return Promise.resolve(false); }
    const settlement = this.store.committedSnapshot();
    // This run may be queued behind an earlier snapshot.
    settlement.catch(() => {});
    const task = this.queue.catch(() => {}).then(async () => {
      try {
        const snapshot = await settlement;
        if (!context.isCurrent()) return false;
        if (!snapshot.days.some((day) => day.date === date && day.status === 'settled')) {
          throw new Error('The settlement is not present in the saved data');
        }
        if (onlyIfMissing && await readSettlementSnapshot()) return false;
        if (!context.isCurrent()) return false;
        const saved = await devicePutIfCurrent(SNAPSHOT_KEY, { date, json: exportBackup(snapshot) }, context.isCurrent, context.signal);
        if (saved && context.isCurrent()) {
          this.failedDate = undefined;
          this.reportChanged();
        }
        return saved;
      } catch {
        if (context.isCurrent()) {
          this.failedDate = date;
          this.reportChanged();
        }
        return false;
      }
    });
    this.queue = task;
    return task;
  }

  retry(): Promise<boolean> {
    const failedDate = this.failedDate;
    if (!failedDate) return Promise.resolve(false);
    let context: ReturnType<Store['captureBackupContext']>;
    try { context = this.store.captureBackupContext(); } catch { return Promise.resolve(false); }
    // A failed settlement is not in durable data. Retry the newest actually
    // committed settlement instead of repeatedly trying to export that date.
    return this.store.lastSavedSnapshot().then((data) => {
      if (!context.isCurrent() || this.failedDate !== failedDate) return false;
      const dates = data.days.filter((day) => day.status === 'settled').map((day) => day.date);
      const date = dates.includes(failedDate) ? failedDate : dates.sort().at(-1);
      return date ? this.run(date) : false;
    }).catch(() => false);
  }
}
