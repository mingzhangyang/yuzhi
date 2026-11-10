/**
 * A backup restores historical facts as-is. Daily time reconciliation is a
 * separate event (writer activation, date rollover, calendar import), never a
 * post-import side effect.
 */
import { parseBackup } from './db';
import type { Store } from './store';
import type { Data } from './types';

export async function restoreBackupSnapshot(store: Store, snapshot: Data): Promise<void> {
  await store.replaceAll(snapshot);
}

/** The production import-success path, with browser I/O supplied at the edge. */
export interface BackupImportOptions {
  store: Store;
  session: { readonly revision: number };
  pickFile: () => Promise<{ text(): Promise<string> } | null>;
  confirm: (snapshot: Data) => Promise<boolean>;
  onRestored: () => void;
  scheduleBackup: () => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}

export async function importBackupFlow({
  store, session, pickFile, confirm, onRestored, scheduleBackup, onSuccess, onError,
}: BackupImportOptions): Promise<void> {
  const context = store.captureWriteContext();
  const revision = session.revision;
  const file = await pickFile();
  if (!file || !context.isCurrent()) return;
  try {
    const snapshot = parseBackup(await file.text());
    if (!context.isCurrent()) return;
    if (!(await confirm(snapshot)) || !context.isCurrent()) return;

    await restoreBackupSnapshot(store, snapshot);
    if (session.revision !== revision || store.isReadOnly) return;

    // Updating the view and scheduling an exact backup must not reconcile
    // elapsed time or append synthetic chronicle/day records.
    onRestored();
    scheduleBackup();
    onSuccess();
  } catch (error) {
    if (session.revision !== revision || store.isReadOnly) return;
    onError(error);
  }
}
