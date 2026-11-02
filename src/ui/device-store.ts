/**
 * Per-browser settings that are not part of the island: they must not travel
 * in backups or imports (a folder handle cannot even be serialised to JSON).
 *
 * Kept in its own tiny IndexedDB database, separate from the island database
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

export async function deviceDelete(key: string): Promise<void> {
  await withDevice((db) => db.delete(KV, key));
}
