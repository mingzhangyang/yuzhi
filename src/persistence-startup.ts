import type { Persistence } from './db';
import type { Data } from './types';

interface StartupPersistence extends Persistence {
  close(): Promise<void>;
}

/**
 * Own the candidate connection until startup succeeds. Every failed startup
 * closes it before propagating the error. A failed read cannot establish that
 * an island is empty, so startup must never switch to an empty memory store.
 * Callers may supply a lifecycle-stable load without duplicating cleanup rules.
 */
export async function initializePersistence(
  candidate: StartupPersistence,
  load: () => Promise<Data> = () => candidate.load(),
): Promise<{ persistence: StartupPersistence; data: Data }> {
  try {
    return { persistence: candidate, data: await load() };
  } catch (error) {
    try { await candidate.close(); } catch { /* preserve the original startup error */ }
    throw error;
  }
}
