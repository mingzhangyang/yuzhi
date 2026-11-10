/** Restore an exact parsed snapshot. Time passage is reconciled by daily(),
 * never by this operation: importing historical facts must not fabricate new
 * chronicle lines or silently archive days. */
import type { Store } from './store';
import type { Data } from './types';

export async function restoreBackupSnapshot(store: Store, snapshot: Data): Promise<void> {
  await store.replaceAll(snapshot);
}
