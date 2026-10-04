import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import {
  COLLECTIONS,
  DATA_VERSION,
  IDB_SCHEMA_VERSION,
  IdbPersistence,
  StorageUnavailableError,
  emptyData,
  exportBackup,
  isStorageUnavailableError,
  parseBackup,
} from '../src/db';
import { runMigrationSteps } from '../src/migrations';
import { initializePersistence } from '../src/persistence-startup';
import type { LifeKind } from '../src/types';
import { lifeEntries } from '../src/logic/operations';
import { interruptions, taskState } from '../src/logic/read-model';
import { v1BackupFixture, v1OperationHistoryFixture } from './fixtures/v1-backup';

const dbName = (label: string) => `yuzhi-${label}-${Date.now()}-${Math.random()}`;

const preservedLifeKinds: Exclude<LifeKind, 'stage'>[] = [
  'start', 'task', 'done', 'partial', 'skip', 'close', 'restart', 'trim', 'drop', 'event', 'complete',
];
function legacyHistory(version: number) {
  const date = '2026-10-01';
  const data = {
    ...emptyData(),
    life: [
      ...preservedLifeKinds.map((kind) => ({
        id: `orphan-${kind}`, date, kind, text: `唯一历史快照 ${kind}`,
        ...(kind === 'skip' ? { reason: 'interrupted' as const } : {}),
      })),
      { id: 'l|settlement', date, kind: 'done' as const, text: '可从结算重建的副本' },
      { id: 'stage-row', date, kind: 'stage' as const, text: '阶段副本' },
    ],
  };
  data.entries.push({ id: 'settlement', seq: 7, date, itemType: 'event', itemId: 'e', outcome: 'done', title: '保留的结算' });
  if (version === 3) {
    // A row already represented by an operation must not gain a second fact.
    data.operations.push({ id: 'already-migrated', seq: 8, date, kind: 'legacy-life', payload: {
      legacyLifeId: 'orphan-event', life: [{ kind: 'event', text: '唯一历史快照 event' }],
    } });
    data.life = data.life.filter((row) => row.kind !== 'stage' && row.id !== 'l|settlement');
  }
  return { format: 'yuzhi-backup', version, ...data };
}

async function seedLegacyHistory(name: string, version: number) {
  const data = legacyHistory(version);
  const db = await openDB(name, 3, {
    upgrade(db) {
      for (const [store, keyPath] of Object.entries(COLLECTIONS)) db.createObjectStore(store, { keyPath });
      db.createObjectStore('life', { keyPath: 'id' });
      db.createObjectStore('interruptions', { keyPath: 'id' });
      db.createObjectStore('meta');
    },
  });
  for (const coll of Object.keys(COLLECTIONS) as Array<keyof typeof COLLECTIONS>) {
    for (const row of data[coll]) await db.put(coll, row);
  }
  for (const row of data.life) await db.put('life', row);
  await db.put('meta', data.settings, 'settings');
  await db.put('meta', version, 'dataVersion');
  db.close();
}

describe('数据迁移基础设施', () => {
  it.each([1, 2, 3])('v%s 备份保全所有非 stage 孤立历史，且不重复已有事实', (version) => {
    const data = parseBackup(JSON.stringify(legacyHistory(version)));
    const rows = lifeEntries(data);
    for (const kind of preservedLifeKinds) {
      expect(rows.filter((row) => row.text === `唯一历史快照 ${kind}`)).toHaveLength(1);
    }
    expect(rows.find((row) => row.text === '唯一历史快照 skip')?.reason).toBe('interrupted');
    expect(rows.filter((row) => row.id === 'l|settlement')).toHaveLength(1);
    expect(rows.some((row) => row.text === '阶段副本' || row.text === '可从结算重建的副本')).toBe(false);
    expect(data.entries).toHaveLength(1); // Orphan history does not affect settlement-derived state.
    expect(new Set([...data.entries, ...data.operations].map((row) => row.seq)).size).toBe(data.entries.length + data.operations.length);
    expect(parseBackup(exportBackup(data))).toEqual(data);
  });

  it.each([1, 2, 3])('v%s IndexedDB 删除旧集合后仍保全孤立历史并可重复加载', async (version) => {
    const name = dbName(`orphan-history-${version}`);
    await seedLegacyHistory(name, version);
    const persistence = new IdbPersistence(name);
    const data = await persistence.load();
    expect(lifeEntries(data).filter((row) => row.text.startsWith('唯一历史快照'))).toHaveLength(preservedLifeKinds.length);
    const reloaded = await persistence.load();
    // IndexedDB returns primary-key order; factSeq owns semantic ordering.
    expect({ ...reloaded, operations: [...reloaded.operations].sort((a, b) => a.seq - b.seq) })
      .toEqual({ ...data, operations: [...data.operations].sort((a, b) => a.seq - b.seq) });
    expect(lifeEntries(reloaded)).toEqual(lifeEntries(data));
    await persistence.close();
    const db = await openDB(name);
    expect(db.version).toBe(IDB_SCHEMA_VERSION);
    expect(db.objectStoreNames.contains('life')).toBe(false);
    db.close();
  });

  it('迁移写回配额失败先回滚并关闭连接，再降级到已恢复快照', async () => {
    const name = dbName('startup-quota');
    await seedLegacyHistory(name, 3);
    // A discarded application's callback cannot close the old connection.
    const onVersionChange = vi.fn();
    const persistence = new IdbPersistence(name, true, { onVersionChange });
    const originalPut = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'meta' && key === 'dataVersion' && value === DATA_VERSION) {
        throw new DOMException('disk full', 'QuotaExceededError');
      }
      return originalPut.call(this, value, key);
    });
    let initialized;
    try {
      initialized = await initializePersistence(persistence);
    } finally {
      fault.mockRestore();
    }
    expect(initialized.fallback).toBeInstanceOf(StorageUnavailableError);
    expect(await initialized.persistence.load()).toEqual(initialized.data);
    expect(lifeEntries(initialized.data).filter((row) => row.text.startsWith('唯一历史快照'))).toHaveLength(preservedLifeKinds.length);

    const staged = await openDB(name);
    expect(staged.version).toBe(IDB_SCHEMA_VERSION - 1);
    expect(await staged.get('meta', 'dataVersion')).toBe(3);
    expect(await staged.getAll('operations')).toEqual(legacyHistory(3).operations);
    expect(await staged.count('life')).toBe(legacyHistory(3).life.length);
    staged.close();
    const blocked = vi.fn();
    const upgraded = await openDB(name, IDB_SCHEMA_VERSION, { blocked });
    expect(blocked).not.toHaveBeenCalled();
    expect(onVersionChange).not.toHaveBeenCalled();
    upgraded.close();
  });

  it('启动验证失败也关闭候选连接，保留原错误且不切换空白数据', async () => {
    const name = dbName('startup-invalid');
    await seedLegacyHistory(name, 3);
    const raw = await openDB(name);
    await raw.put('meta', { workStart: 1 }, 'settings');
    raw.close();
    const onVersionChange = vi.fn();
    const persistence = new IdbPersistence(name, true, { onVersionChange });
    await expect(initializePersistence(persistence)).rejects.toThrow('本地数据里的工作开始时间');
    const blocked = vi.fn();
    const upgraded = await openDB(name, IDB_SCHEMA_VERSION, { blocked });
    expect(blocked).not.toHaveBeenCalled();
    expect(onVersionChange).not.toHaveBeenCalled();
    upgraded.close();
  });

  it('按连续版本顺序迁移，并且不修改调用方输入', () => {
    const source = { value: 1, notes: ['old'] };
    const result = runMigrationSteps(source, 1, 3, [
      { to: 2, run(data) { data.value += 1; data.notes.push('v2'); } },
      { to: 3, run(data) { return { ...data, value: data.value * 10, notes: [...data.notes, 'v3'] }; } },
    ]);
    expect(result).toEqual({ data: { value: 20, notes: ['old', 'v2', 'v3'] }, version: 3 });
    expect(source).toEqual({ value: 1, notes: ['old'] });
  });

  it('缺少中间迁移或数据来自未来版本时明确失败', () => {
    expect(() => runMigrationSteps({ n: 1 }, 1, 3, [{ to: 3, run() {} }])).toThrow('v1 → v2');
    expect(() => runMigrationSteps({ n: 1 }, 2, 1, [])).toThrow('更新的屿志版本');
  });

  it('只有明确的存储不可用错误才允许降级到临时内存，并可携带已恢复的数据', () => {
    expect(isStorageUnavailableError(new StorageUnavailableError(new DOMException('blocked', 'SecurityError')))).toBe(true);
    expect(isStorageUnavailableError(new Error('本地数据版本号损坏'))).toBe(false);
    expect(isStorageUnavailableError(new DOMException('newer schema', 'VersionError'))).toBe(false);

    const recovered = {
      ...parseBackup(JSON.stringify(v1BackupFixture)),
      projects: [{ ...parseBackup(JSON.stringify(v1BackupFixture)).projects[0], name: '已恢复村落' }],
    };
    const error = new StorageUnavailableError(new DOMException('full', 'QuotaExceededError'), recovered);
    expect(error.recoveredData?.projects[0]?.name).toBe('已恢复村落');
  });

  it('共享校验器保留备份语境，不把本地数据错误误报成备份问题', async () => {
    expect(() => parseBackup(JSON.stringify({ format: 'yuzhi-backup', version: 1, settings: { workStart: 1 } }))).toThrow('备份里的工作开始时间');
    expect(() =>
      parseBackup(JSON.stringify({
        format: 'yuzhi-backup',
        version: 1,
        projects: [{ id: 'p1' }],
      })),
    ).toThrow('备份里的 projects 第 1 条记录损坏');

    const name = dbName('bad-local');
    const per = new IdbPersistence(name);
    await per.load();
    const raw = await openDB(name, IDB_SCHEMA_VERSION);
    await raw.put('meta', { workStart: 1 }, 'settings');
    raw.close();

    await expect(new IdbPersistence(name).load()).rejects.toThrow('本地数据里的工作开始时间');

    const badRecordName = dbName('bad-local-record');
    const seeded = new IdbPersistence(badRecordName);
    await seeded.load();
    const badRaw = await openDB(badRecordName, IDB_SCHEMA_VERSION);
    await badRaw.put('projects', { id: 'p1' });
    badRaw.close();

    await expect(new IdbPersistence(badRecordName).load()).rejects.toThrow('本地数据里的 projects 第 1 条记录损坏');
  });

  it('迁移全部主动 life kind，并保留同日事实顺序', () => {
    const parsed = parseBackup(JSON.stringify(v1OperationHistoryFixture));
    expect(parsed.operations.filter((event) => event.kind !== 'task-state-baseline' && event.kind !== 'migration-boundary').map((event) => [event.seq, event.kind])).toEqual([
      [1, 'project-created'],
      [2, 'legacy-life'],
      [3, 'legacy-life'],
      [4, 'project-restarted'],
      [5, 'project-trimmed'],
      [6, 'project-closed'],
      [7, 'task-dropped'],
      [8, 'project-completed'],
    ]);
    expect(parsed.entries.map((entry) => entry.seq)).toEqual([9, 10]);

    const activeKinds = new Set(['start', 'task', 'event', 'restart', 'trim', 'close', 'drop', 'complete']);
    expect(lifeEntries(parsed).filter((entry) => activeKinds.has(entry.kind)).map((entry) => entry.text)).toEqual([
      '立项，村落「团队」在岛上落成',
      '新任务「写周报」住进村落',
      '「写周报」改到10月2日',
      '重新启动，村落重新热闹起来',
      '缩小规模，轻装继续',
      '正式关闭：方向变化',
      '「回邮件」不重要了，移出村落',
      '落成，立为海岸上的地标',
    ]);
  });

  it('两个 persistence 实例并发写事实时原子分配唯一 seq', async () => {
    const name = dbName('fact-seq');
    await new IdbPersistence(name).load();
    const left = new IdbPersistence(name);
    const right = new IdbPersistence(name);
    await Promise.all([left.load(), right.load()]);

    const operation = { id: 'o-left', seq: 1, date: '2026-10-01', kind: 'legacy-life' };
    const entry = {
      id: '2026-10-01|event|e-right',
      seq: 1,
      date: '2026-10-01',
      itemType: 'event',
      itemId: 'e-right',
      outcome: 'done',
      title: '并发事件',
    };
    const [operationSeq, entrySeq] = await Promise.all([
      left.put('operations', operation),
      right.put('entries', entry),
    ]);

    expect(new Set([operationSeq, entrySeq]).size).toBe(2);
    const loaded = await new IdbPersistence(name).load();
    expect([...loaded.operations, ...loaded.entries].map((fact) => fact.seq).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('事实改 key 时保留原持久化 seq，不重新排到队尾', async () => {
    const name = dbName('fact-rename');
    const per = new IdbPersistence(name);
    await per.load();

    const entry = {
      id: '2026-10-01|event|legacy',
      seq: 1,
      date: '2026-10-01',
      itemType: 'event',
      itemId: 'legacy',
      outcome: 'done',
      title: '旧事件',
    };
    const operation = { id: 'o-after', seq: 2, date: '2026-10-01', kind: 'legacy-life' };
    await per.put('entries', entry);
    await per.put('operations', operation);
    const originalSeq = entry.seq;

    const renamed = { ...entry, id: '2026-10-01|event|stable', itemId: 'stable' };
    await per.renameFact('entries', entry.id, renamed);

    const loaded = await new IdbPersistence(name).load();
    expect(loaded.entries.find((fact) => fact.id === entry.id)).toBeUndefined();
    expect(loaded.entries.find((fact) => fact.id === renamed.id)).toMatchObject({ seq: originalSeq, itemId: 'stable' });
    expect(loaded.operations.find((fact) => fact.id === operation.id)?.seq).toBeGreaterThan(originalSeq);
  });

  it('legacyLifeId 没有非空 life 快照时拒绝当前备份，避免吞掉兼容历史', () => {
    const parsed = parseBackup(JSON.stringify(v1BackupFixture));
    const bad = JSON.parse(exportBackup(parsed)) as {
      operations: Array<Record<string, unknown>>;
    };
    bad.operations.push({
      id: 'o-bad-legacy',
      seq: 99,
      date: '2026-10-01',
      kind: 'legacy-life',
      payload: { legacyLifeId: 'l-start' },
    });
    expect(() => parseBackup(JSON.stringify(bad))).toThrow('operations');
  });

  it('当前备份里 entries 与 operations 的 seq 重复时拒绝', () => {
    const parsed = parseBackup(JSON.stringify(v1BackupFixture));
    const bad = JSON.parse(exportBackup(parsed)) as {
      entries: Array<{ seq: number }>;
      operations: Array<Record<string, unknown>>;
    };
    bad.operations.push({
      id: 'o-duplicate-seq',
      seq: bad.entries[0].seq,
      date: '2026-10-01',
      kind: 'legacy-life',
    });
    expect(() => parseBackup(JSON.stringify(bad))).toThrow('事实序号');
  });

  it('v4 新事实序号从 entries + operations 的全局最大值继续', () => {
    const v3 = {
      format: 'yuzhi-backup',
      version: 3,
      ...emptyData(),
      entries: [{
        id: '2026-10-01|event|legacy-settlement',
        seq: 5,
        date: '2026-10-01',
        itemType: 'event',
        itemId: 'legacy-settlement',
        outcome: 'done',
        title: '旧结算',
      }],
      operations: [],
      life: [{
        id: 'legacy-active-life',
        date: '2026-10-01',
        text: '旧的一生之书记录',
        kind: 'event',
      }],
    };
    const migrated = parseBackup(JSON.stringify(v3));
    expect(migrated.entries[0].seq).toBe(5);
    expect(migrated.operations.find((row) => row.payload?.legacyLifeId === 'legacy-active-life')?.seq).toBe(6);
  });

  it('业务迁移失败时停在 staging schema，legacy stores 保持完整', async () => {
    const name = dbName('staging-preserves-legacy');
    const raw = await openDB(name, 3, {
      upgrade(db) {
        for (const [store, keyPath] of Object.entries(COLLECTIONS)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
        }
        if (!db.objectStoreNames.contains('life')) db.createObjectStore('life', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('interruptions')) db.createObjectStore('interruptions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      },
    });
    await raw.put('meta', { workStart: 1 }, 'settings');
    await raw.put('life', { id: 'legacy-life', date: '2026-10-01', kind: 'event', text: '旧记录' });
    await raw.put('interruptions', { id: 'legacy-interruption' });
    raw.close();

    await expect(new IdbPersistence(name).load()).rejects.toThrow('本地数据里的工作开始时间');

    const staged = await openDB(name);
    expect(staged.version).toBe(IDB_SCHEMA_VERSION - 1);
    expect(Array.from(staged.objectStoreNames)).toEqual(expect.arrayContaining(['life', 'interruptions']));
    staged.close();
  });

  it('修复曾到达 schema 7 但遗留 legacy stores 的数据库', async () => {
    const name = dbName('repair-schema-7');
    const raw = await openDB(name, IDB_SCHEMA_VERSION - 1, {
      upgrade(db) {
        for (const [store, keyPath] of Object.entries(COLLECTIONS)) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
        }
        if (!db.objectStoreNames.contains('life')) db.createObjectStore('life', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('interruptions')) db.createObjectStore('interruptions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      },
    });
    await raw.put('meta', {
      workStart: '09:00',
      workEnd: '18:00',
      firstDay: '2026-10-01',
      theme: 'auto',
    }, 'settings');
    await raw.put('meta', DATA_VERSION, 'dataVersion');
    raw.close();

    await new IdbPersistence(name).load();
    const repaired = await openDB(name);
    expect(repaired.version).toBe(IDB_SCHEMA_VERSION);
    expect(Array.from(repaired.objectStoreNames)).not.toContain('life');
    expect(Array.from(repaired.objectStoreNames)).not.toContain('interruptions');
    repaired.close();
  });

  it('v1 IndexedDB 原地升级对同日 life 使用稳定 id fallback，不依赖写入顺序', async () => {
    const rows = [...v1OperationHistoryFixture.life];
    const seed = async (name: string, lifeRows: typeof rows) => {
      const raw = await openDB(name, 3, {
        upgrade(db) {
          for (const [store, keyPath] of Object.entries(COLLECTIONS)) {
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
          }
          if (!db.objectStoreNames.contains('life')) db.createObjectStore('life', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('interruptions')) db.createObjectStore('interruptions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        },
      });
      await raw.put('meta', { ...v1OperationHistoryFixture.settings }, 'settings');
      for (const project of v1OperationHistoryFixture.projects) await raw.put('projects', structuredClone(project));
      for (const task of v1OperationHistoryFixture.tasks) await raw.put('tasks', structuredClone(task));
      for (const entry of v1OperationHistoryFixture.entries) await raw.put('entries', structuredClone(entry));
      for (const day of v1OperationHistoryFixture.days) await raw.put('days', structuredClone(day));
      for (const line of v1OperationHistoryFixture.chronicle) await raw.put('chronicle', structuredClone(line));
      for (const row of lifeRows) await raw.put('life', structuredClone(row));
      for (const interruption of v1OperationHistoryFixture.interruptions) await raw.put('interruptions', structuredClone(interruption));
      for (const snapshot of v1OperationHistoryFixture.snapshots) await raw.put('snapshots', structuredClone(snapshot));
      raw.close();
      const migrated = await new IdbPersistence(name).load();
      const upgraded = await openDB(name);
      expect(upgraded.version).toBe(IDB_SCHEMA_VERSION);
      expect(Array.from(upgraded.objectStoreNames)).not.toContain('life');
      expect(Array.from(upgraded.objectStoreNames)).not.toContain('interruptions');
      upgraded.close();
      return migrated;
    };

    const forward = await seed(dbName('legacy-life-forward'), rows);
    const reverse = await seed(dbName('legacy-life-reverse'), [...rows].reverse());
    const order = (data: typeof forward) =>
      data.operations
        .filter((event) => event.kind !== 'task-state-baseline' && event.kind !== 'migration-boundary')
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((event) => [event.seq, event.kind, event.payload?.legacyLifeId]);

    expect(order(forward)).toEqual(order(reverse));
    expect(order(forward).map((row) => row[2])).toEqual([
      'l-close',
      'l-complete',
      'l-drop',
      'l-event',
      'l-restart',
      'l-start',
      'l-task',
      'l-trim',
    ]);
  });

  it('旧 v1 备份迁到 v3：删掉派生字段并保留有效状态，可 round-trip', () => {
    const parsed = parseBackup(JSON.stringify(v1BackupFixture));
    expect(parsed.projects[0]).toMatchObject({ id: 'p1' });
    expect('lastStage' in parsed.projects[0]).toBe(false);
    expect('lastProgressAt' in parsed.projects[0]).toBe(false);
    const rawTask = parsed.tasks.find((task) => task.id === 't1')!;
    expect('postponeCount' in rawTask).toBe(false);
    expect(taskState(parsed, rawTask)).toMatchObject({ scheduledFor: '2026-10-02', postponeCount: 1, status: 'open' });
    expect(interruptions(parsed)).toHaveLength(1);
    expect(parsed.operations.filter((event) => event.kind === 'task-state-baseline')).toHaveLength(2);
    expect(parsed.operations.find((event) => event.kind === 'migration-boundary')).toMatchObject({ date: '2026-10-01' });
    expect(parsed.operations.find((event) => event.kind === 'project-created')).toMatchObject({ seq: 1, projectId: 'p1' });
    expect(parsed.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect('life' in parsed).toBe(false);
    const migratedLife = lifeEntries(parsed);
    expect(migratedLife).toHaveLength(3);
    expect(migratedLife.filter((entry) => entry.text === '立项，村落「团队」在岛上落成')).toHaveLength(1);

    const exported = JSON.parse(exportBackup(parsed)) as { version: number };
    expect(exported.version).toBe(DATA_VERSION);
    expect(parseBackup(JSON.stringify(exported))).toEqual(parsed);
  });

  it('迁移后的旧 postponed 结算可改判或删除，不保留 baked-in 副作用', () => {
    const corrected = parseBackup(JSON.stringify(v1BackupFixture));
    const raw = corrected.tasks.find((task) => task.id === 't1')!;
    const entry = corrected.entries.find((row) => row.itemType === 'task' && row.itemId === 't1')!;
    const index = corrected.entries.indexOf(entry);
    corrected.entries[index] = { ...entry, outcome: 'done', reason: undefined };
    expect(taskState(corrected, raw)).toMatchObject({
      status: 'done',
      closedAt: '2026-10-01',
      postponeCount: 0,
    });

    const deleted = parseBackup(JSON.stringify(v1BackupFixture));
    const rawDeleted = deleted.tasks.find((task) => task.id === 't1')!;
    deleted.entries = deleted.entries.filter((row) => !(row.itemType === 'task' && row.itemId === 't1'));
    expect(taskState(deleted, rawDeleted)).toMatchObject({
      status: 'open',
      scheduledFor: '2026-10-01',
      postponeCount: 0,
    });
  });

  it('迁移 reconciliation 不把无关项目关闭当成任务状态 override', () => {
    const legacy = JSON.parse(JSON.stringify(v1BackupFixture)) as any;
    legacy.projects.push({
      id: 'p2',
      name: '无关项目',
      createdAt: '2026-10-01',
      status: 'closed',
      islandSlot: 1,
      closedAt: '2026-10-01',
    });
    legacy.tasks[0] = {
      ...legacy.tasks[0],
      status: 'done',
      closedAt: '2026-10-01',
      scheduledFor: '2026-10-01',
      postponeCount: 0,
    };
    legacy.entries[0] = { ...legacy.entries[0], outcome: 'done' };
    delete legacy.entries[0].reason;
    const taskLifeIndex = legacy.life.findIndex((row: any) => row.id === 'l|2026-10-01|task|t1');
    legacy.life[taskLifeIndex] = {
      ...legacy.life[taskLifeIndex],
      kind: 'done',
      text: '完成了「写周报」',
    };
    delete legacy.life[taskLifeIndex].reason;
    legacy.life.splice(taskLifeIndex + 1, 0, {
      id: 'l-close-p2',
      date: '2026-10-01',
      projectId: 'p2',
      text: '正式关闭：无关项目',
      kind: 'close',
    });

    const migrated = parseBackup(JSON.stringify(legacy));
    const raw = migrated.tasks.find((task) => task.id === 't1')!;
    migrated.entries = migrated.entries.filter((entry) => !(entry.itemType === 'task' && entry.itemId === 't1'));

    expect(taskState(migrated, raw)).toMatchObject({
      status: 'open',
      closedAt: undefined,
      scheduledFor: '2026-10-01',
    });
  });

  it('改判旧结算后按新状态顺序重放后续 restart/close', () => {
    const legacy = JSON.parse(JSON.stringify(v1BackupFixture)) as any;
    legacy.projects[0] = {
      ...legacy.projects[0],
      status: 'closed',
      closedAt: '2026-10-01',
    };
    legacy.tasks[0] = {
      ...legacy.tasks[0],
      status: 'done',
      closedAt: '2026-10-01',
      scheduledFor: '2026-10-01',
      postponeCount: 3,
    };
    legacy.entries[0] = { ...legacy.entries[0], outcome: 'done' };
    delete legacy.entries[0].reason;
    const taskLifeIndex = legacy.life.findIndex((row: any) => row.id === 'l|2026-10-01|task|t1');
    legacy.life[taskLifeIndex] = {
      ...legacy.life[taskLifeIndex],
      kind: 'done',
      text: '完成了「写周报」',
    };
    delete legacy.life[taskLifeIndex].reason;
    legacy.life.splice(
      taskLifeIndex + 1,
      0,
      { id: 'l-restart-after-done', date: '2026-10-01', projectId: 'p1', text: '重新启动', kind: 'restart' },
      { id: 'l-close-after-done', date: '2026-10-01', projectId: 'p1', text: '正式关闭', kind: 'close' },
    );

    const migrated = parseBackup(JSON.stringify(legacy));
    const raw = migrated.tasks.find((task) => task.id === 't1')!;
    expect(taskState(migrated, raw)).toMatchObject({ status: 'done', postponeCount: 3 });

    migrated.entries = migrated.entries.filter((entry) => !(entry.itemType === 'task' && entry.itemId === 't1'));
    expect(taskState(migrated, raw)).toMatchObject({
      status: 'dropped',
      closedAt: '2026-10-01',
      postponeCount: 0,
      scheduledFor: '2026-10-01',
    });
  });

  it('没有 meta.dataVersion 的现有数据库按 v1 接管，并写入当前数据版本', async () => {
    const name = dbName('legacy');
    const first = new IdbPersistence(name);
    await first.load();

    const raw = await openDB(name, IDB_SCHEMA_VERSION);
    await raw.delete('meta', 'dataVersion');
    await raw.put('projects', { id: 'p1', name: '旧村落', createdAt: '2026-10-01', status: 'active', islandSlot: 0 });
    raw.close();

    const reopened = new IdbPersistence(name);
    const loaded = await reopened.load();
    expect(loaded.projects.map((p) => p.name)).toEqual(['旧村落']);

    const inspect = await openDB(name, IDB_SCHEMA_VERSION);
    expect(await inspect.get('meta', 'dataVersion')).toBe(DATA_VERSION);
    for (const c of Object.keys(COLLECTIONS)) expect(inspect.objectStoreNames.contains(c)).toBe(true);
    expect(inspect.objectStoreNames.contains('interruptions')).toBe(false);
    inspect.close();
  });

  it('reader 和 writer 都拒绝未来 schema，避免旧客户端写坏新结构', async () => {
    const name = dbName('future-schema');
    const future = await openDB(name, IDB_SCHEMA_VERSION + 1, {
      upgrade(db) {
        for (const [store, keyPath] of Object.entries(COLLECTIONS)) db.createObjectStore(store, { keyPath });
        db.createObjectStore('meta');
      },
    });
    future.close();

    const reader = new IdbPersistence(name, false);
    await expect(reader.load()).rejects.toThrow('更新版本');
    await reader.close();

    const writer = new IdbPersistence(name, true);
    await expect(writer.load()).rejects.toThrow('更新版本');
    await writer.close();
  });

  it('staging/current schema 缺少当前集合时 fail closed', async () => {
    const name = dbName('partial-current-schema');
    const partial = await openDB(name, IDB_SCHEMA_VERSION, {
      upgrade(db) {
        for (const [store, keyPath] of Object.entries(COLLECTIONS)) {
          if (store !== 'projects') db.createObjectStore(store, { keyPath });
        }
        db.createObjectStore('meta');
      },
    });
    partial.close();

    const reader = new IdbPersistence(name, false);
    await expect(reader.load()).rejects.toThrow(/结构不完整.*projects/);
    await reader.close();

    const writer = new IdbPersistence(name, true);
    await expect(writer.load()).rejects.toThrow(/结构不完整.*projects/);
    await writer.close();
  });

  it('versionchange 时旧连接主动关闭，不阻塞下一次 schema upgrade', async () => {
    const name = dbName('versionchange');
    const old = new IdbPersistence(name);
    await old.load();

    const upgraded = await openDB(name, IDB_SCHEMA_VERSION + 1, {
      upgrade(db) {
        db.createObjectStore('future-test-store');
      },
    });
    expect(upgraded.version).toBe(IDB_SCHEMA_VERSION + 1);
    upgraded.close();
  });
});
