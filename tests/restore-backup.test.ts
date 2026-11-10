import { describe, expect, it, vi } from 'vitest';
import { archiveOldDays, createProject, createTask, refreshStages, repairTruncatedYearDates, settleDay } from '../src/actions';
import { exportBackup, parseBackup } from '../src/db';
import { importBackupFlow, type BackupImportOptions } from '../src/restore-backup';
import type { Store } from '../src/store';
import { makeStore } from './helpers';

async function agedBackup(): Promise<string> {
  const origin = makeStore('2026-09-01', '2026-09-01');
  const village = createProject(origin.store, 'Old village');
  createTask(origin.store, { title: 'Overdue task', projectId: village.id, scheduledFor: '2026-09-03' });
  settleDay(origin.store, '2026-09-01', new Map());
  await origin.store.flush();
  return exportBackup(origin.store.data);
}

function importOptions(store: Store, json: string) {
  const onRestored = vi.fn();
  const scheduleBackup = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const confirm = vi.fn(async () => true);
  const options: BackupImportOptions = {
    store,
    session: { revision: 0 },
    pickFile: async () => ({ text: async () => json }),
    confirm,
    onRestored,
    scheduleBackup,
    onSuccess,
    onError,
  };
  return { options, confirm, onRestored, scheduleBackup, onSuccess, onError };
}

describe('YZ-F11 backup import', () => {
  it('preserves historical chronicle and day records through the import success path and subscriber notifications', async () => {
    const json = await agedBackup();
    const expected = parseBackup(json);
    expect(expected.days).toContainEqual({ date: '2026-09-01', status: 'settled' });
    expect(expected.tasks.some((task) => task.scheduledFor === '2026-09-03')).toBe(true);

    const target = makeStore('2026-10-10', '2026-09-01');
    const observed: Array<{ chronicle: typeof expected.chronicle; days: typeof expected.days }> = [];
    target.store.subscribe(() => observed.push({
      chronicle: structuredClone(target.store.data.chronicle),
      days: structuredClone(target.store.data.days),
    }));
    const effects = importOptions(target.store, json);

    await importBackupFlow(effects.options);
    await target.store.flush();
    await Promise.resolve(); // Deliver Store's queued subscriber notification.

    expect(effects.confirm).toHaveBeenCalledOnce();
    expect(effects.onRestored).toHaveBeenCalledOnce();
    expect(effects.scheduleBackup).toHaveBeenCalledOnce();
    expect(effects.onSuccess).toHaveBeenCalledOnce();
    expect(effects.onError).not.toHaveBeenCalled();
    expect(observed.length).toBeGreaterThan(0);
    for (const state of observed) {
      expect(state.chronicle).toEqual(expected.chronicle);
      expect(state.days).toEqual(expected.days);
    }
    expect(target.store.data.chronicle).toEqual(expected.chronicle);
    expect(target.store.data.days).toEqual(expected.days);

    // Re-importing without any time passage also preserves exact facts.
    await importBackupFlow(effects.options);
    await target.store.flush();
    expect(target.store.data.chronicle).toEqual(expected.chronicle);
    expect(target.store.data.days).toEqual(expected.days);
  });

  it('reconciles elapsed time once and stays idempotent across repeated daily passes without re-importing', async () => {
    const json = await agedBackup();
    const target = makeStore('2026-10-10', '2026-09-01');
    await importBackupFlow(importOptions(target.store, json).options);
    const restored = {
      chronicle: structuredClone(target.store.data.chronicle),
      days: structuredClone(target.store.data.days),
    };

    // Same business actions as main.ts daily(); no second import resets state.
    const reconcile = () => target.store.batch(() => {
      repairTruncatedYearDates(target.store);
      refreshStages(target.store);
      return archiveOldDays(target.store);
    });
    expect(reconcile()).toContain('2026-09-03');
    await target.store.flush();
    const once = {
      chronicle: structuredClone(target.store.data.chronicle),
      days: structuredClone(target.store.data.days),
    };
    expect(once.days).toContainEqual({ date: '2026-09-03', status: 'unrecorded' });
    expect(once.days).toContainEqual({ date: '2026-09-01', status: 'settled' });
    expect(once.chronicle.length).toBeGreaterThan(restored.chronicle.length);

    for (let i = 0; i < 3; i++) {
      expect(reconcile()).toEqual([]);
      await target.store.flush();
      expect(target.store.data.chronicle).toEqual(once.chronicle);
      expect(target.store.data.days).toEqual(once.days);
    }
    expect(new Set(once.chronicle.map((line) => line.id)).size).toBe(once.chronicle.length);
  });

  it('cancelling import does not replace data, announce success, or schedule a backup', async () => {
    const json = await agedBackup();
    const target = makeStore('2026-10-10');
    const effects = importOptions(target.store, json);
    effects.confirm.mockResolvedValue(false);
    const before = structuredClone(target.store.data);
    await importBackupFlow(effects.options);
    expect(target.store.data).toEqual(before);
    expect(effects.onRestored).not.toHaveBeenCalled();
    expect(effects.scheduleBackup).not.toHaveBeenCalled();
    expect(effects.onSuccess).not.toHaveBeenCalled();
  });
});
