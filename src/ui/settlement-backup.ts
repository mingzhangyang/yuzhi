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

  constructor(private readonly store: Store) {}

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
    let context: ReturnType<Store['captureWriteContext']>;
    try { context = this.store.captureWriteContext(); } catch { return Promise.resolve(false); }
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
        const saved = await devicePutIfCurrent(SNAPSHOT_KEY, { date, json: exportBackup(snapshot) }, context.isCurrent);
        if (saved && context.hasCurrentAccess()) {
          this.failedDate = undefined;
          try { this.onChange(); } catch { /* reporting must not affect backup */ }
        }
        return saved;
      } catch {
        if (context.hasCurrentAccess()) {
          this.failedDate = date;
          try { this.onChange(); } catch { /* reporting must not affect backup */ }
        }
        return false;
      }
    });
    this.queue = task;
    return task;
  }

  retry(): Promise<boolean> {
    return this.failedDate ? this.run(this.failedDate) : Promise.resolve(false);
  }
}
