import { openDB, type IDBPDatabase } from 'idb';
import type { Data, Settings } from './types';
import { CHORES } from './types';
import { localDate } from './lib/date';
import { MAX_VILLAGES } from './logic/config';
import { runMigrationSteps, type MigrationStep } from './migrations';

/** 数据集合名 → 主键字段 */
export const COLLECTIONS = {
  projects: 'id',
  tasks: 'id',
  sources: 'id',
  events: 'id',
  rules: 'id',
  entries: 'id',
  days: 'date',
  operations: 'id',
  chronicle: 'id',
  snapshots: 'date',
} as const;
export type Coll = keyof typeof COLLECTIONS;
export const COLL_NAMES = Object.keys(COLLECTIONS) as Coll[];

const DB_NAME = 'yuzhi';
const FACT_SEQ_KEY = 'factSeq';
/**
 * Schema 7 is a staging schema: it keeps legacy stores available long enough
 * for the business-data migration to read them. Schema 8 drops those stores
 * after the migrated data has been durably written.
 *
 * Schema 8 also repairs databases that were briefly opened by the PR build
 * which reached schema 7 without deleting the legacy stores.
 */
const STAGING_SCHEMA_VERSION = 7;
export const IDB_SCHEMA_VERSION = 8;
export const DATA_VERSION = 4;
const LEGACY_DATA_VERSION = 1;
export const BACKUP_FORMAT = 'yuzhi-backup';
export const BACKUP_VERSION = DATA_VERSION;

const STORAGE_UNAVAILABLE_NAMES = new Set(['SecurityError', 'NotAllowedError', 'InvalidStateError', 'UnknownError', 'QuotaExceededError', 'NotSupportedError']);

function isStorageUnavailableCause(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && STORAGE_UNAVAILABLE_NAMES.has(name);
}

export class StorageUnavailableError extends Error {
  constructor(
    cause: unknown,
    /** Data that was already read and validated before persistence failed. */
    public readonly recoveredData?: Data,
  ) {
    super('浏览器本地存储不可用', { cause });
    this.name = 'StorageUnavailableError';
  }
}

export function isStorageUnavailableError(error: unknown): error is StorageUnavailableError {
  return error instanceof StorageUnavailableError;
}

export function defaultSettings(): Settings {
  return { workStart: '09:00', workEnd: '18:00', firstDay: localDate(), theme: 'auto' };
}

export function emptyData(): Data {
  return {
    projects: [],
    tasks: [],
    sources: [],
    events: [],
    rules: [],
    entries: [],
    days: [],
    operations: [],
    chronicle: [],
    snapshots: [],
    settings: defaultSettings(),
  };
}

type RawData = Record<string, unknown> & {
  settings: unknown;
  /** v1 backup arrays preserve export order; IndexedDB getAll only preserves primary-key order. */
  __legacyLifeOrder?: 'array' | 'id';
};

/** Business-data migrations. IndexedDB object-store changes stay in upgrade(). */
const ACTIVE_LIFE_KINDS = new Set(['start', 'task', 'close', 'restart', 'trim', 'drop', 'event', 'complete']);
const LEGACY_KIND_MAP: Record<string, string> = {
  start: 'project-created',
  close: 'project-closed',
  restart: 'project-restarted',
  trim: 'project-trimmed',
  drop: 'task-dropped',
  complete: 'project-completed',
};

const LEGACY_COLLECTIONS = ['life', 'interruptions'] as const;
const LEGACY_SKIP_REASONS = new Set(['interrupted', 'no_energy', 'not_important', 'postponed']);

function legacyLifeSnapshot(row: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof row.text !== 'string' || typeof row.kind !== 'string') return undefined;
  if (!ACTIVE_LIFE_KINDS.has(row.kind) || row.kind === 'stage') return undefined;
  const snapshot: Record<string, unknown> = { kind: row.kind, text: row.text };
  if (typeof row.projectId === 'string') snapshot.projectId = row.projectId;
  if (typeof row.taskId === 'string') snapshot.taskId = row.taskId;
  if (typeof row.reason === 'string' && LEGACY_SKIP_REASONS.has(row.reason)) snapshot.reason = row.reason;
  return snapshot;
}

const DATA_MIGRATIONS: readonly MigrationStep<RawData>[] = [
  {
    to: 2,
    run(data) {
      const life = Array.isArray(data.life) ? data.life : [];
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const operations = Array.isArray(data.operations) ? data.operations.slice() : [];

      // v2 introduces one stable fact sequence shared by settlement facts and
      // explicit operation facts. Rejudging an old settlement keeps its seq,
      // so later manual operations still replay after it.
      let seq = 0;
      for (const value of [...entries, ...operations]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const n = (value as Record<string, unknown>).seq;
        if (Number.isInteger(n) && (n as number) > seq) seq = n as number;
      }
      const entryById = new Map<string, Record<string, unknown>>();
      for (const value of entries) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.id === 'string') entryById.set(row.id, row);
      }

      const idbFallback = data.__legacyLifeOrder === 'id';
      const orderedLife = life
        .map((value, index) => ({ value, index }))
        .sort((a, b) => {
          const ar = a.value && typeof a.value === 'object' && !Array.isArray(a.value) ? a.value as Record<string, unknown> : {};
          const br = b.value && typeof b.value === 'object' && !Array.isArray(b.value) ? b.value as Record<string, unknown> : {};
          const byDate = String(ar.date ?? '').localeCompare(String(br.date ?? ''));
          if (byDate) return byDate;
          // Backups retain their serialized array order. IndexedDB v1 upgrades
          // cannot recover legacy write order because getAll() returns key
          // order, so use an explicit stable id fallback rather than pretending
          // the incoming index is occurrence order.
          return idbFallback
            ? String(ar.id ?? '').localeCompare(String(br.id ?? '')) || a.index - b.index
            : a.index - b.index;
        });

      for (const { value } of orderedLife) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.id !== 'string' || typeof row.date !== 'string' || typeof row.kind !== 'string') continue;

        // Settlement-generated life rows already encode the legacy write order.
        // Use that order to give the corresponding settlement a stable seq.
        if (row.id.startsWith('l|')) {
          const entry = entryById.get(row.id.slice(2));
          if (entry && !Number.isInteger(entry.seq)) entry.seq = ++seq;
        }

        if (!ACTIVE_LIFE_KINDS.has(row.kind) || typeof row.text !== 'string') continue;
        const lifeSnapshot: Record<string, unknown> = { kind: row.kind, text: row.text };
        if (typeof row.projectId === 'string') lifeSnapshot.projectId = row.projectId;
        if (typeof row.taskId === 'string') lifeSnapshot.taskId = row.taskId;
        if (typeof row.reason === 'string') lifeSnapshot.reason = row.reason;
        operations.push({
          id: `op|legacy-life|${row.id}`,
          seq: ++seq,
          date: row.date,
          kind: LEGACY_KIND_MAP[row.kind] ?? 'legacy-life',
          ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
          ...(typeof row.taskId === 'string' ? { taskId: row.taskId } : {}),
          payload: { legacyLifeId: row.id, legacyKind: row.kind, life: [lifeSnapshot] },
        });
      }

      // A few legacy settlement records may have no life row (for example a
      // partially written old database). Keep them valid and deterministic.
      const missing = [...entryById.values()]
        .filter((row) => !Number.isInteger(row.seq))
        .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
      for (const row of missing) row.seq = ++seq;

      data.entries = entries;
      data.operations = operations;
      delete data.__legacyLifeOrder;
    },
  },
  {
    to: 3,
    run(data) {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const operations = Array.isArray(data.operations) ? data.operations.slice() : [];
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const life = Array.isArray(data.life) ? data.life : [];
      const chronicle = Array.isArray(data.chronicle) ? data.chronicle : [];

      let seq = 0;
      for (const value of [...entries, ...operations]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const n = (value as Record<string, unknown>).seq;
        if (Number.isInteger(n) && (n as number) > seq) seq = n as number;
      }

      let baselineDate = '1970-01-01';
      const considerDate = (value: unknown) => {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value > baselineDate) baselineDate = value;
      };
      for (const value of [...entries, ...operations, ...life, ...(Array.isArray(data.days) ? data.days : []), ...(Array.isArray(data.snapshots) ? data.snapshots : [])]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        considerDate((value as Record<string, unknown>).date);
      }
      for (const value of projects) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        considerDate(row.createdAt);
        considerDate(row.closedAt);
        considerDate(row.doneAt);
        delete row.lastProgressAt;
        delete row.lastStage;
      }
      for (const value of tasks) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        considerDate(row.createdAt);
        considerDate(row.closedAt);
      }
      if (baselineDate === '1970-01-01') baselineDate = '2000-01-01';

      // Phase 2 must never invent pre-migration stage chronicle rows. Persist
      // the old chronicle horizon as an explicit no-op fact so refreshStages()
      // keeps the same cutoff after it starts writing new stage lines.
      let stageReplayBoundary: string | undefined;
      for (const value of chronicle) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const date = (value as Record<string, unknown>).date;
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && (!stageReplayBoundary || date > stageReplayBoundary)) {
          stageReplayBoundary = date;
        }
      }

      for (const value of tasks) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.id !== 'string') continue;
        if (row.postponeCount !== undefined && (!Number.isInteger(row.postponeCount) || (row.postponeCount as number) < 0)) {
          throw new Error('旧数据里的 postponeCount 损坏');
        }
        const legacyEntries = entries
          .filter((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
            const e = entry as Record<string, unknown>;
            return e.itemType === 'task' && e.itemId === row.id;
          })
          .map((entry) => structuredClone(entry));
        const payload: Record<string, unknown> = {
          status: typeof row.status === 'string' ? row.status : 'open',
          postponeCount: row.postponeCount ?? 0,
          legacyEntries,
        };
        if (typeof row.projectId === 'string') payload.projectId = row.projectId;
        if (typeof row.scheduledFor === 'string') payload.scheduledFor = row.scheduledFor;
        if (typeof row.closedAt === 'string') payload.closedAt = row.closedAt;
        operations.push({
          id: `op|v3-task-baseline|${row.id}`,
          seq: ++seq,
          date: baselineDate,
          kind: 'task-state-baseline',
          ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
          taskId: row.id,
          payload,
        });
        delete row.postponeCount;
      }

      if (stageReplayBoundary) {
        operations.push({
          id: 'op|v3-stage-replay-boundary',
          seq: ++seq,
          date: stageReplayBoundary,
          kind: 'migration-boundary',
        });
      }

      const settlementLifeIds = new Set<string>();
      for (const value of entries) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const id = (value as Record<string, unknown>).id;
        if (typeof id === 'string') settlementLifeIds.add(`l|${id}`);
      }
      data.life = life.filter((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        if (row.kind === 'stage') return false;
        if (typeof row.id === 'string' && settlementLifeIds.has(row.id)) return false;
        delete row.fromStage;
        return true;
      });
      data.projects = projects;
      data.tasks = tasks;
      data.operations = operations;
      delete data.interruptions;
    },
  },
  {
    to: 4,
    run(data) {
      const operations = Array.isArray(data.operations) ? data.operations.slice() : [];
      const life = Array.isArray(data.life) ? data.life : [];
      const migrated = new Set<string>();
      let seq = 0;
      for (const value of operations) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq > seq) seq = row.seq;
        const payload = row.payload;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const id = (payload as Record<string, unknown>).legacyLifeId;
          if (typeof id === 'string') migrated.add(id);
        }
      }

      // Phase 2 left the non-derivable part of the old life collection in
      // place for one compatibility release. Convert those rows to the same
      // operation-fact shape used by the v1 migration, then remove the
      // collection entirely. Settlement/stage rows were already discarded by
      // the v3 step and are reconstructed from facts at read time.
      for (const value of life) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.id !== 'string' || typeof row.date !== 'string') continue;
        if (migrated.has(row.id)) continue;
        const snapshot = legacyLifeSnapshot(row);
        if (!snapshot) continue;
        const kind = LEGACY_KIND_MAP[String(row.kind)] ?? 'legacy-life';
        operations.push({
          id: `op|legacy-life|${row.id}`,
          seq: ++seq,
          date: row.date,
          kind,
          ...(typeof row.projectId === 'string' ? { projectId: row.projectId } : {}),
          ...(typeof row.taskId === 'string' ? { taskId: row.taskId } : {}),
          payload: { legacyLifeId: row.id, legacyKind: row.kind, life: [snapshot] },
        });
      }
      data.operations = operations;
      delete data.life;
      delete data.interruptions;
      delete data.__legacyLifeOrder;
    },
  },
];
function ensureCurrentCollections(raw: RawData): RawData {
  for (const c of COLL_NAMES) if (raw[c] === undefined) raw[c] = [];
  if (raw.settings === undefined) raw.settings = defaultSettings();
  return raw;
}

function migrateRawData(raw: RawData, fromVersion: number) {
  return runMigrationSteps(raw, fromVersion, DATA_VERSION, DATA_MIGRATIONS);
}

function parseStoredDataVersion(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error('本地数据版本号损坏');
  return v as number;
}

export interface Persistence {
  load(): Promise<Data>;
  /** Commit one user action using a single IndexedDB readwrite transaction. */
  batch(writes: PersistenceWrite[]): Promise<FactSequenceUpdate[]>;
}

export type PersistenceWrite =
  | { kind: 'put'; coll: Coll; item: object }
  | { kind: 'renameFact'; coll: 'entries' | 'operations'; oldKey: string; item: object }
  | { kind: 'del'; coll: Coll; key: string }
  | { kind: 'putSettings'; settings: Settings }
  | { kind: 'replaceAll'; data: Data };

export interface FactSequenceUpdate {
  coll: 'entries' | 'operations';
  key: string;
  seq: number;
}

export class IdbPersistence implements Persistence {
  private dbp: Promise<IDBPDatabase>;
  private readonly name: string;
  private writeAccess: boolean;
  private requestedWriteAccess: boolean;
  private versionChangeHandler?: () => void;
  private accessTail: Promise<void> = Promise.resolve();
  constructor(name = DB_NAME, writeAccess = true, options: { onVersionChange?: () => void } = {}) {
    this.name = name;
    this.writeAccess = writeAccess;
    this.requestedWriteAccess = writeAccess;
    this.versionChangeHandler = options.onVersionChange;
    this.dbp = writeAccess ? this.openWritableDatabase() : this.openDatabase(undefined, false);
  }

  private queueReconnect(writeAccess: boolean): Promise<void> {
    const change = this.accessTail.catch(() => {}).then(async () => {
      let current: IDBPDatabase | undefined;
      try { current = await this.dbp; } catch { /* reconnect from a failed/closed connection */ }
      current?.close();
      this.writeAccess = writeAccess;
      this.dbp = writeAccess ? this.openWritableDatabase() : this.openDatabase(undefined, false);
      await this.dbp;
    });
    this.accessTail = change;
    return change;
  }

  async setWriteAccess(value: boolean) {
    // Compare against the requested mode, not only the currently-open
    // connection. A true -> false request may arrive while true is still
    // queued; dropping the second request would leave a writable connection
    // behind after the Store has become read-only.
    if (this.requestedWriteAccess === value) {
      await this.accessTail;
      return;
    }
    this.requestedWriteAccess = value;
    await this.queueReconnect(value);
  }

  /** Reopen even when the logical access mode is unchanged (for versionchange recovery). */
  async reopen(writeAccess = this.requestedWriteAccess) {
    this.requestedWriteAccess = writeAccess;
    await this.queueReconnect(writeAccess);
  }

  async close() {
    await this.accessTail.catch(() => {});
    try { (await this.dbp).close(); } catch { /* already failed or closed */ }
  }

  onVersionChange(fn: () => void) {
    this.versionChangeHandler = fn;
  }

  private openDatabase(version: number | undefined, allowUpgrade: boolean): Promise<IDBPDatabase> {
    const notifyVersionChange = () => {
      const handler = this.versionChangeHandler;
      if (!handler) return false;
      handler();
      return true;
    };
    return openDB(this.name, version, {
      upgrade: allowUpgrade
        ? (db, oldVersion, newVersion) => {
          // Every old schema first reaches the staging version with legacy
          // stores intact. Business migration runs in load(); only the final
          // staging -> current upgrade is allowed to delete migration input.
          for (const c of COLL_NAMES) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: COLLECTIONS[c] });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (newVersion === IDB_SCHEMA_VERSION && oldVersion >= STAGING_SCHEMA_VERSION) {
            for (const name of LEGACY_COLLECTIONS) {
              if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
            }
          }
        }
        : undefined,
      blocking(_currentVersion, _blockedVersion, event) {
        // "blocking" means this open connection is preventing another tab's
        // upgrade. Let the application drain pending writes before closing.
        // Persistence instances without a lifecycle handler still fail safe by
        // closing immediately.
        if (!notifyVersionChange()) (event.target as IDBDatabase | null)?.close();
      },
      // "blocked" is the opposite direction: this tab is the upgrader waiting
      // for an older connection. Do not demote the writer that owns the upgrade.
      blocked() {},
    });
  }

  private async openWritableDatabase(): Promise<IDBPDatabase> {
    const current = await this.openDatabase(undefined, false);
    if (current.version >= STAGING_SCHEMA_VERSION) return current;
    current.close();
    return this.openDatabase(STAGING_SCHEMA_VERSION, true);
  }

  private async dropLegacyCollections(db: IDBPDatabase): Promise<IDBPDatabase> {
    const hasLegacy = LEGACY_COLLECTIONS.some((name) => db.objectStoreNames.contains(name));
    if (db.version >= IDB_SCHEMA_VERSION) {
      if (hasLegacy) throw new Error('数据库最终 schema 仍包含旧集合，拒绝继续写入');
      return db;
    }
    db.close();
    return this.openDatabase(IDB_SCHEMA_VERSION, true);
  }
  async load(): Promise<Data> {
    let db: IDBPDatabase;
    let raw: RawData;
    let storedSettings: unknown;
    let storedVersionValue: unknown;
    try {
      db = await this.dbp;
      // Read every persisted collection, including legacy stores that are no
      // longer part of the current Data type. A skipped-version upgrade may
      // still need them as migration input.
      raw = { settings: defaultSettings() };
      for (const name of Array.from(db.objectStoreNames)) {
        if (name !== 'meta') raw[name] = await db.getAll(name);
      }
      ensureCurrentCollections(raw);
      storedSettings = await db.get('meta', 'settings');
      storedVersionValue = await db.get('meta', 'dataVersion');
    } catch (error) {
      // Only known browser/IndexedDB availability failures may fall back to
      // transient memory storage. Migration, version and validation failures
      // must remain visible so we never make existing data look "empty".
      if (isStorageUnavailableCause(error)) throw new StorageUnavailableError(error);
      throw error;
    }
    raw.settings = storedSettings ?? defaultSettings();
    raw.__legacyLifeOrder = 'id';

    const storedVersion = parseStoredDataVersion(storedVersionValue);
    const fromVersion = storedVersion ?? LEGACY_DATA_VERSION;
    const migrated = migrateRawData(raw, fromVersion);
    const data = validateCurrentData(migrated.data, '本地数据');

    try {
      if (this.writeAccess && migrated.version !== fromVersion) {
        await this.writeAll(db, data, migrated.version);
      } else if (this.writeAccess && (storedVersion === undefined || storedSettings === undefined)) {
        const tx = db.transaction('meta', 'readwrite');
        if (storedSettings === undefined) await tx.objectStore('meta').put({ ...data.settings }, 'settings');
        if (storedVersion === undefined) await tx.objectStore('meta').put(DATA_VERSION, 'dataVersion');
        await tx.done;
      }
      if (this.writeAccess) {
        this.dbp = this.dropLegacyCollections(db);
        await this.dbp;
      }
    } catch (error) {
      // Startup persistence failures such as quota/security errors mean the
      // browser cannot safely persist this session. Keep migration/version/
      // validation errors outside this block so they remain actionable.
      if (isStorageUnavailableCause(error)) throw new StorageUnavailableError(error, data);
      throw error;
    }
    return data;
  }
  async batch(writes: PersistenceWrite[]): Promise<FactSequenceUpdate[]> {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    const db = await this.dbp;
    const tx = db.transaction([...COLL_NAMES, 'meta'], 'readwrite');
    const meta = tx.objectStore('meta');
    const seqUpdates: FactSequenceUpdate[] = [];
    let maxFactSeq: number | undefined;

    const currentMaxFactSeq = async (): Promise<number> => {
      if (maxFactSeq !== undefined) return maxFactSeq;
      const saved = await meta.get(FACT_SEQ_KEY);
      if (typeof saved === 'number' && Number.isInteger(saved) && saved >= 0) {
        maxFactSeq = saved;
        return saved;
      }
      let largest = 0;
      for (const coll of ['entries', 'operations'] as const) {
        for (const fact of await tx.objectStore(coll).getAll() as Array<{ seq?: unknown }>) {
          if (typeof fact.seq === 'number' && Number.isInteger(fact.seq) && fact.seq > largest) largest = fact.seq;
        }
      }
      maxFactSeq = largest;
      return largest;
    };

    try {
      for (const write of writes) {
        if (write.kind === 'replaceAll') {
          const d = structuredClone(write.data);
          for (const coll of COLL_NAMES) {
            const store = tx.objectStore(coll);
            await store.clear();
            for (const item of d[coll]) await store.put(item as object);
          }
          let next = 0;
          for (const fact of [...d.entries, ...d.operations]) if (fact.seq > next) next = fact.seq;
          await meta.put({ ...d.settings }, 'settings');
          await meta.put(DATA_VERSION, 'dataVersion');
          await meta.put(next, FACT_SEQ_KEY);
          maxFactSeq = next;
          continue;
        }

        if (write.kind === 'putSettings') {
          await meta.put({ ...write.settings }, 'settings');
          continue;
        }

        const store = tx.objectStore(write.coll);
        if (write.kind === 'del') {
          await store.delete(write.key);
          continue;
        }

        if (write.kind === 'renameFact') {
          const previous = await store.get(write.oldKey) as Record<string, unknown> | undefined;
          if (!previous || typeof previous.seq !== 'number' || !Number.isInteger(previous.seq) || previous.seq < 1) {
            throw new Error(`找不到要重命名的事实：${write.oldKey}`);
          }
          const record = structuredClone(write.item) as Record<string, unknown>;
          const newKey = record[COLLECTIONS[write.coll]];
          if (typeof newKey !== 'string' || !newKey) throw new Error('事实的新 key 无效');
          if (newKey !== write.oldKey && await store.get(newKey)) throw new Error(`事实的新 key 已存在：${newKey}`);
          record.seq = previous.seq;
          if (newKey !== write.oldKey) await store.delete(write.oldKey);
          await store.put(record);
          seqUpdates.push({ coll: write.coll, key: newKey, seq: previous.seq });
          continue;
        }

        const record = structuredClone(write.item) as Record<string, unknown>;
        if (write.coll === 'entries' || write.coll === 'operations') {
          const key = record[COLLECTIONS[write.coll]];
          if (typeof key !== 'string' || !key) throw new Error('事实的 key 无效');
          const existing = await store.get(key) as Record<string, unknown> | undefined;
          const existingSeq = existing?.seq;
          if (typeof existingSeq === 'number' && Number.isInteger(existingSeq) && existingSeq >= 1) {
            record.seq = existingSeq;
          } else {
            maxFactSeq = await currentMaxFactSeq() + 1;
            record.seq = maxFactSeq;
            await meta.put(maxFactSeq, FACT_SEQ_KEY);
          }
          await store.put(record);
          seqUpdates.push({ coll: write.coll, key, seq: record.seq as number });
        } else {
          await store.put(record);
        }
      }
      await tx.done;
      return seqUpdates;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      try { await tx.done; } catch { /* consume the aborted transaction error */ }
      throw error;
    }
  }
  async put(coll: Coll, item: object): Promise<number | undefined> {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    if (coll === 'entries' || coll === 'operations') {
      return this.putFact(coll, item);
    }
    await (await this.dbp).put(coll, structuredClone(item));
    return undefined;
  }

  /**
   * entries / operations share one persisted sequence. The readwrite
   * transaction serializes competing tabs, so two writers cannot commit the
   * same seq even when both tab-local stores computed the same provisional one.
   * Updating an existing fact keeps its original seq (rejudgment/backdating).
   */
  private async putFact(coll: 'entries' | 'operations', item: object): Promise<number> {
    const db = await this.dbp;
    const tx = db.transaction(['entries', 'operations', 'meta'], 'readwrite');
    const store = tx.objectStore(coll);
    const meta = tx.objectStore('meta');
    const record = structuredClone(item) as Record<string, unknown>;
    const key = record[COLLECTIONS[coll]];
    const existing = typeof key === 'string' ? await store.get(key) as Record<string, unknown> | undefined : undefined;

    const validSeq = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    const existingSeq = existing?.seq;
    let seq: number | undefined = validSeq(existingSeq) && existingSeq >= 1 ? existingSeq : undefined;
    if (seq === undefined) {
      const saved = await meta.get(FACT_SEQ_KEY);
      if (validSeq(saved)) {
        seq = saved;
      } else {
        seq = 0;
        for (const fact of await tx.objectStore('entries').getAll() as Array<{ seq?: unknown }>) {
          if (validSeq(fact.seq) && fact.seq > seq) seq = fact.seq;
        }
        for (const fact of await tx.objectStore('operations').getAll() as Array<{ seq?: unknown }>) {
          if (validSeq(fact.seq) && fact.seq > seq) seq = fact.seq;
        }
      }
      seq += 1;
      await meta.put(seq, FACT_SEQ_KEY);
    }

    record.seq = seq;
    await store.put(record);
    await tx.done;
    return seq;
  }
  async renameFact(coll: 'entries' | 'operations', oldKey: string, item: object): Promise<number> {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    const db = await this.dbp;
    const tx = db.transaction(coll, 'readwrite');
    const store = tx.objectStore(coll);
    const previous = await store.get(oldKey) as Record<string, unknown> | undefined;
    if (!previous || typeof previous.seq !== 'number' || !Number.isInteger(previous.seq) || previous.seq < 1) {
      tx.abort();
      throw new Error(`找不到要重命名的事实：${oldKey}`);
    }

    const record = structuredClone(item) as Record<string, unknown>;
    const newKey = record[COLLECTIONS[coll]];
    if (typeof newKey !== 'string' || !newKey) {
      tx.abort();
      throw new Error('事实的新 key 无效');
    }
    if (newKey !== oldKey && await store.get(newKey)) {
      tx.abort();
      throw new Error(`事实的新 key 已存在：${newKey}`);
    }

    record.seq = previous.seq;
    if (newKey !== oldKey) await store.delete(oldKey);
    await store.put(record);
    await tx.done;
    return previous.seq;
  }

  async del(coll: Coll, key: string) {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    await (await this.dbp).delete(coll, key);
  }
  async putSettings(s: Settings) {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    await (await this.dbp).put('meta', { ...s }, 'settings');
  }
  async replaceAll(d: Data) {
    if (!this.writeAccess) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    await this.writeAll(await this.dbp, d, DATA_VERSION);
  }
  private async writeAll(db: IDBPDatabase, d: Data, dataVersion: number) {
    const tx = db.transaction([...COLL_NAMES, 'meta'], 'readwrite');
    for (const c of COLL_NAMES) {
      const st = tx.objectStore(c);
      await st.clear();
      for (const item of (d as unknown as Record<Coll, object[]>)[c]) await st.put(structuredClone(item));
    }
    const meta = tx.objectStore('meta');
    let maxFactSeq = 0;
    for (const entry of d.entries) if (entry.seq > maxFactSeq) maxFactSeq = entry.seq;
    for (const event of d.operations) if (event.seq > maxFactSeq) maxFactSeq = event.seq;
    await meta.put({ ...d.settings }, 'settings');
    await meta.put(dataVersion, 'dataVersion');
    await meta.put(maxFactSeq, FACT_SEQ_KEY);
    await tx.done;
  }
}

/** 测试与降级用：只存在内存里 */
export class MemoryPersistence implements Persistence {
  constructor(private data: Data = emptyData()) {}
  async load() {
    return structuredClone(this.data);
  }
  async batch(writes: PersistenceWrite[]): Promise<FactSequenceUpdate[]> {
    const next = structuredClone(this.data);
    const seqUpdates: FactSequenceUpdate[] = [];
    const largestSequence = (data: Data) => {
      let largest = 0;
      for (const fact of [...data.entries, ...data.operations]) if (fact.seq > largest) largest = fact.seq;
      return largest;
    };
    let maxFactSeq = largestSequence(next);
    for (const write of writes) {
      if (write.kind === 'replaceAll') {
        Object.assign(next, structuredClone(write.data));
        maxFactSeq = largestSequence(next);
        continue;
      }
      if (write.kind === 'putSettings') {
        next.settings = { ...write.settings };
        continue;
      }
      const arr = next[write.coll] as unknown as Record<string, unknown>[];
      const keyField = COLLECTIONS[write.coll];
      if (write.kind === 'del') {
        const index = arr.findIndex((row) => row[keyField] === write.key);
        if (index >= 0) arr.splice(index, 1);
        continue;
      }
      const record = structuredClone(write.item) as Record<string, unknown>;
      const oldKey = write.kind === 'renameFact' ? write.oldKey : undefined;
      const targetKey = record[keyField];
      const index = arr.findIndex((row) => row[keyField] === (oldKey ?? targetKey));
      if (write.kind === 'renameFact' && index < 0) throw new Error(`找不到要重命名的事实：${write.oldKey}`);
      if (write.kind === 'renameFact' && targetKey !== write.oldKey && arr.some((row) => row[keyField] === targetKey)) {
        throw new Error(`事实的新 key 已存在：${String(targetKey)}`);
      }
      if (typeof targetKey !== 'string' || !targetKey) throw new Error('记录的 key 无效');
      if (write.coll === 'entries' || write.coll === 'operations') {
        const previous = index >= 0 ? arr[index] : undefined;
        const seq = previous && typeof previous.seq === 'number' && Number.isInteger(previous.seq) && previous.seq >= 1
          ? previous.seq
          : write.kind === 'renameFact'
            ? (record.seq as number)
            : ++maxFactSeq;
        record.seq = seq;
        seqUpdates.push({ coll: write.coll, key: targetKey as string, seq });
      }
      if (index >= 0) arr.splice(index, 1);
      arr.push(record);
    }
    this.data = next;
    return seqUpdates;
  }
  async put(coll: Coll, item: object) {
    const key = (item as Record<string, unknown>)[COLLECTIONS[coll]];
    const updates = await this.batch([{ kind: 'put', coll, item }]);
    return coll === 'entries' || coll === 'operations'
      ? updates.find((update) => update.coll === coll && update.key === key)?.seq
      : undefined;
  }
  async renameFact(coll: 'entries' | 'operations', oldKey: string, item: object) {
    return (await this.batch([{ kind: 'renameFact', coll, oldKey, item }]))[0]?.seq ?? 0;
  }
  async del(coll: Coll, key: string) {
    await this.batch([{ kind: 'del', coll, key }]);
  }
  async putSettings(settings: Settings) {
    await this.batch([{ kind: 'putSettings', settings }]);
  }
  async replaceAll(d: Data) {
    await this.batch([{ kind: 'replaceAll', data: d }]);
  }
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 校验备份里的设置：类型、格式、取值范围都对才接受，否则整份备份拒绝 */
export function parseSettings(v: unknown, source = '备份'): Settings {
  const at = `${source}里的`;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at}设置格式不对`);
  const o = v as Record<string, unknown>;
  const s = defaultSettings();
  const str = (k: string, re: RegExp, label: string) => {
    if (o[k] === undefined) return undefined;
    if (typeof o[k] !== 'string' || !re.test(o[k] as string)) throw new Error(`${at}${label}格式不对`);
    return o[k] as string;
  };
  s.workStart = str('workStart', HM, '工作开始时间') ?? s.workStart;
  s.workEnd = str('workEnd', HM, '工作结束时间') ?? s.workEnd;
  s.firstDay = str('firstDay', YMD, '起始日期') ?? s.firstDay;
  if (s.workEnd <= s.workStart) throw new Error(`${at}工作时段不对：结束要晚于开始`);
  if (o.theme !== undefined) {
    if (o.theme !== 'auto' && o.theme !== 'light' && o.theme !== 'dark') throw new Error(`${at}外观设置不对`);
    s.theme = o.theme;
  }
  return s;
}

/* ---------------- 备份记录校验 ---------------- */

/** 一个字段的检查：返回 true 表示合格 */
type Check = (v: unknown) => boolean;
const isStr: Check = (v) => typeof v === 'string';
const isText: Check = (v) => typeof v === 'string' && v.trim() !== '';
const isDate: Check = (v) => typeof v === 'string' && YMD.test(v);
const isStamp: Check = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isBool: Check = (v) => typeof v === 'boolean';
const intIn = (min: number, max = Infinity): Check => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const oneOf = (...xs: string[]): Check => (v) => typeof v === 'string' && xs.includes(v);
const arrayOf = (shape: Shape): Check => (v) => Array.isArray(v) && v.every((x) => badField(x, shape) === null);

/** 字段名 → 检查；名字以 ? 结尾的字段可以没有 */
type Shape = Record<string, Check>;

const OUTCOME = oneOf('done', 'partial', 'skipped');
const REASON = oneOf('interrupted', 'no_energy', 'not_important', 'postponed');
const ITEM_TYPE = oneOf('task', 'event');
const OPERATION_KIND = oneOf(
  'project-created', 'project-renamed', 'project-restarted', 'project-trimmed', 'project-closed',
  'project-completed', 'project-resting-changed', 'task-created', 'task-arranged', 'task-rescheduled',
  'task-moved', 'task-dropped', 'task-state-baseline', 'migration-boundary', 'legacy-life',
);
const LIFE_KIND = oneOf('start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete');
const OPERATION_LIFE = arrayOf({
  'projectId?': isText, 'taskId?': isText, text: isStr, kind: LIFE_KIND, 'reason?': REASON,
});
const OPERATION_PAYLOAD: Check = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.legacyLifeId !== undefined && (typeof o.legacyLifeId !== 'string' || !o.legacyLifeId.trim())) return false;
  if (o.life !== undefined && !OPERATION_LIFE(o.life)) return false;
  // A migrated legacy row suppresses the original life record. Never accept
  // that suppression marker unless the replacement snapshot is present.
  if (o.legacyLifeId !== undefined && (!Array.isArray(o.life) || o.life.length === 0)) return false;
  return true;
};

const SHAPES: Record<Coll, Shape> = {
  projects: {
    id: isText, name: isText, createdAt: isDate, status: oneOf('active', 'closed', 'done'),
    islandSlot: intIn(0, MAX_VILLAGES - 1), 'closedAt?': isDate, 'closeReason?': isStr,
    'resets?': arrayOf({ date: isDate, neglect: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, kind: oneOf('restart', 'trim') }),
    'promptSnoozeUntil?': isDate, 'doneAt?': isDate,
    'resting?': oneOf('landmark', 'archive'), 'landmarkIndex?': intIn(0),
  },
  tasks: {
    id: isText, 'projectId?': isText, title: isText, 'scheduledFor?': isDate,
    status: oneOf('open', 'done', 'dropped'), createdAt: isDate, 'closedAt?': isDate,
  },
  sources: { id: isText, name: isStr, 'icsUrl?': isStr, 'lastFetchedAt?': isStamp, 'lastError?': isStr },
  events: {
    id: isText, sourceId: isText, uid: isText, title: isStr, start: isStamp, end: isStamp, allDay: isBool,
    'projectId?': isText, classified: isBool,
  },
  rules: { id: isText, contains: isText, projectId: isText },
  entries: {
    id: isText, seq: intIn(1), date: isDate, itemType: ITEM_TYPE, itemId: isText, outcome: OUTCOME, 'reason?': REASON,
    'projectId?': isText, title: isStr,
  },
  days: { date: isDate, status: oneOf('settled', 'unrecorded') },
  operations: {
    id: isText, seq: intIn(1), date: isDate, kind: OPERATION_KIND,
    'projectId?': isText, 'taskId?': isText, 'payload?': OPERATION_PAYLOAD,
  },
  chronicle: { id: isText, date: isDate, text: isStr, kind: oneOf('day', 'event', 'quiet', 'recover', 'landmark') },
  snapshots: { date: isDate, backlog: intIn(0) },
};

/** 不合格时返回出问题的字段名；合格返回 null */
function badField(x: unknown, shape: Shape): string | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return '(整条记录)';
  const o = x as Record<string, unknown>;
  for (const [k, check] of Object.entries(shape)) {
    const optional = k.endsWith('?');
    const name = optional ? k.slice(0, -1) : k;
    if (optional && o[name] === undefined) continue;
    if (!check(o[name])) return name;
  }
  return null;
}

/** 记录之间的引用：任务、事件归属、规则指向的项目要存在；活跃村落的位置不能重叠 */
function checkRelations(d: Data, source: string) {
  const projects = new Set(d.projects.map((p) => p.id));
  const fail = (what: string) => {
    throw new Error(`${source}里的数据对不上：${what}`);
  };
  for (const c of COLL_NAMES) {
    const key = COLLECTIONS[c];
    const seen = new Set<string>();
    for (const x of d[c] as unknown as Record<string, string>[]) {
      if (seen.has(x[key])) fail(`${c} 里有重复的记录`);
      seen.add(x[key]);
    }
  }
  for (const t of d.tasks) if (t.projectId !== undefined && !projects.has(t.projectId)) fail(`任务「${t.title}」所属的项目不存在`);
  for (const e of d.events) if (e.projectId !== undefined && e.projectId !== CHORES && !projects.has(e.projectId)) fail(`事件「${e.title}」所属的项目不存在`);
  for (const r of d.rules) if (r.projectId !== CHORES && !projects.has(r.projectId)) fail(`归类规则「${r.contains}」指向的项目不存在`);
  const factSeqs = new Set<number>();
  for (const fact of [...d.entries, ...d.operations]) {
    if (factSeqs.has(fact.seq)) fail(`事实序号 ${fact.seq} 重复`);
    factSeqs.add(fact.seq);
  }
  const slots = new Set<number>();
  for (const p of d.projects) {
    if (p.status !== 'active') continue;
    if (slots.has(p.islandSlot)) fail('两座村落占了同一个位置');
    slots.add(p.islandSlot);
  }
}

function validateCurrentData(raw: RawData, source: string): Data {
  const d = emptyData();
  for (const c of COLL_NAMES) {
    const v = raw[c];
    if (!Array.isArray(v)) throw new Error(`${source}里的 ${c} 格式不对`);
    v.forEach((x, i) => {
      const bad = badField(x, SHAPES[c]);
      if (bad) throw new Error(`${source}里的 ${c} 第 ${i + 1} 条记录损坏（${bad}）`);
    });
    (d as unknown as Record<Coll, unknown[]>)[c] = v;
  }
  d.settings = parseSettings(raw.settings, source);
  checkRelations(d, source);
  return d;
}

function rawBackupData(o: Record<string, unknown>): RawData {
  // Preserve unknown legacy fields so future migrations can consume them
  // before current-schema validation discards them from the Data read model.
  const raw: RawData = { settings: o.settings ?? defaultSettings() };
  for (const [key, value] of Object.entries(o)) {
    if (key === 'format' || key === 'version' || key === 'exportedAt' || key === 'settings') continue;
    raw[key] = value;
  }
  ensureCurrentCollections(raw);
  raw.__legacyLifeOrder = 'array';
  for (const c of COLL_NAMES) if (!Array.isArray(raw[c])) throw new Error(`备份里的 ${c} 格式不对`);
  return raw;
}

export function exportBackup(d: Data): string {
  const out: Record<string, unknown> = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), settings: d.settings };
  for (const c of COLL_NAMES) out[c] = (d as unknown as Record<Coll, unknown[]>)[c];
  return JSON.stringify(out, null, 1);
}

/** 解析备份文件；格式不对时抛出带中文说明的错误 */
export function parseBackup(text: string): Data {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('这不是有效的 JSON 文件');
  }
  if (!o || o.format !== BACKUP_FORMAT) throw new Error('这不是屿志的备份文件');
  if (!Number.isInteger(o.version) || (o.version as number) < LEGACY_DATA_VERSION) throw new Error('备份版本号不对');
  if ((o.version as number) > DATA_VERSION) throw new Error('备份来自更新的版本，请先升级屿志');

  const migrated = migrateRawData(rawBackupData(o), o.version as number);
  return validateCurrentData(migrated.data, '备份');
}
