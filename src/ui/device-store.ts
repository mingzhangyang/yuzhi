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

/** Start no write after ownership is lost, and abort an in-flight stale write. */
export async function devicePutIfCurrent(key: string, value: unknown, isCurrent: () => boolean): Promise<boolean> {
  return withDevice(async (db) => {
    if (!isCurrent()) return false;
    const tx = db.transaction(KV, 'readwrite');
    try {
      await tx.store.put(value, key);
      if (!isCurrent()) {
        tx.abort();
        await tx.done.catch(() => {});
        return false;
      }
      await tx.done;
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* already finished */ }
      await tx.done.catch(() => {});
      throw error;
    }
  });
}

export async function deviceDelete(key: string): Promise<void> {
  await withDevice((db) => db.delete(KV, key));
}
