import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  DATA_VERSION,
  IDB_SCHEMA_VERSION,
  IdbPersistence,
  StorageUnavailableError,
  exportBackup,
  isStorageUnavailableError,
  parseBackup,
} from '../src/db';
import { runMigrationSteps } from '../src/migrations';
import { v1BackupFixture } from './fixtures/v1-backup';

const dbName = (label: string) => `yuzhi-${label}-${Date.now()}-${Math.random()}`;

describe('数据迁移基础设施', () => {
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

  it('旧 v1 备份先走迁移入口，再按当前结构校验并可 round-trip', () => {
    const parsed = parseBackup(JSON.stringify(v1BackupFixture));
    expect(parsed.projects[0]).toMatchObject({ id: 'p1', lastStage: 0 });
    expect(parsed.tasks.find((t) => t.id === 't1')?.postponeCount).toBe(1);
    expect(parsed.interruptions).toHaveLength(1);

    const exported = JSON.parse(exportBackup(parsed)) as { version: number };
    expect(exported.version).toBe(DATA_VERSION);
    expect(parseBackup(JSON.stringify(exported))).toEqual(parsed);
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
    inspect.close();
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
