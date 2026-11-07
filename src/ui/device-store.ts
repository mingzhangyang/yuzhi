/**
 * Per-browser settings and the latest settlement recovery snapshot, separate
 * from the island data that travels in backups and imports. A folder handle
 * cannot be serialised to JSON.
 *
 * Kept in its own IndexedDB database, separate from the island database
 * and its schema/version lifecycle. Every call opens a short-lived connection
 * and closes it, so it never holds the page out of BFCache or blocks another
 * tab's upgrade.
 */
import { openDB, type IDBPDatabase } from 'idb';

const DEVICE_DB = 'yuzhi-device';
const KV = 'kv';

async function withDevice<T>(work: (db: IDBPDatabase) => Promise<T>): Promise<T> {
  const db = await openDB(DEVICE_DB, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(KV)) database.createObjectStore(KV);
    },
  });
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

export function deviceGet<T>(key: string): Promise<T | undefined> {
  return withDevice((db) => db.get(KV, key) as Promise<T | undefined>);
}

export async function devicePut(key: string, value: unknown): Promise<void> {
  await withDevice((db) => db.put(KV, value, key));
}

/**
 * A lifecycle revocation must synchronously abort the transaction, including
 * the gap between the last put() check and tx.done. Polling isCurrent() alone
 * cannot stop a transaction already waiting to commit.
 */
export async function devicePutIfCurrent(
  key: string, value: unknown, isCurrent: () => boolean, signal?: AbortSignal,
): Promise<boolean> {
  return withDevice(async (db) => {
    if (signal?.aborted || !isCurrent()) return false;
    const tx = db.transaction(KV, 'readwrite');
    const abort = () => {
      try { tx.abort(); } catch { /* the transaction may already have committed */ }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted || !isCurrent()) {
        abort();
        await tx.done.catch(() => {});
        return false;
      }
      await tx.store.put(value, key);
      if (signal?.aborted || !isCurrent()) {
        abort();
        await tx.done.catch(() => {});
        return false;
      }
      await tx.done;
      // A revocation after the native commit cannot undo it; it did, however,
      // commit while the context was valid and must not claim a new success.
      return !signal?.aborted && isCurrent();
    } catch (error) {
      abort();
      await tx.done.catch(() => {});
      if (signal?.aborted || !isCurrent()) return false;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  });
}

export async function deviceDelete(key: string): Promise<void> {
  await withDevice((db) => db.delete(KV, key));
}
