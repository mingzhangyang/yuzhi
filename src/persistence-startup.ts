import { isStorageUnavailableError, MemoryPersistence, type Persistence, type StorageUnavailableError } from './db';
import type { Data } from './types';

interface StartupPersistence extends Persistence {
  close(): Promise<void>;
}

/**
 * Own the candidate connection until startup succeeds. Every failed startup
 * closes it before transferring ownership to memory or propagating the error.
 * Callers may supply a lifecycle-stable load without duplicating cleanup rules.
 */
export async function initializePersistence(
  candidate: StartupPersistence,
  load: () => Promise<Data> = () => candidate.load(),
): Promise<{ persistence: Persistence; data: Data; fallback?: StorageUnavailableError }> {
  try {
    return { persistence: candidate, data: await load() };
  } catch (error) {
    await candidate.close();
    if (!isStorageUnavailableError(error)) throw error;
    const persistence = new MemoryPersistence(error.recoveredData);
    return { persistence, data: await persistence.load(), fallback: error };
  }
}
