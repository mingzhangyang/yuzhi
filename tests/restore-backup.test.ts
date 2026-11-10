import { describe, expect, it } from 'vitest';
import { createProject, refreshStages } from '../src/actions';
import { exportBackup, parseBackup } from '../src/db';
import { restoreBackupSnapshot } from '../src/restore-backup';
import { makeStore } from './helpers';

describe('YZ-F11 backup restoration', () => {
  it('preserves imported chronicle and remains idempotent', async () => {
    const original = makeStore('2026-09-01', '2026-09-01');
    createProject(original.store, 'Old village');
    await original.store.flush();
    const backup = exportBackup(original.store.data);
    const target = makeStore('2026-10-10', '2026-09-01');
    const parsed = parseBackup(backup);
    const expected = parsed.chronicle;
    await restoreBackupSnapshot(target.store, parsed);
    expect(target.store.data.chronicle).toEqual(expected);
    expect(target.store.data.days).toEqual(parsed.days);
    expect(refreshStages(target.store).length).toBeGreaterThan(0);
    await restoreBackupSnapshot(target.store, parseBackup(backup));
    expect(target.store.data.chronicle).toEqual(expected);
    await restoreBackupSnapshot(target.store, parseBackup(backup));
    expect(target.store.data.chronicle).toEqual(expected);
  });
});
