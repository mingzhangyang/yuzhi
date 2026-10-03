import { openDB, type IDBPDatabase } from 'idb';
import type { Data, Settings } from './types';
import { CHORES } from './types';
import { localDate } from './lib/date';
import { MAX_VILLAGES, STAGE_NAMES } from './logic/config';
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
  life: 'id',
  interruptions: 'id',
  snapshots: 'date',
} as const;
export type Coll = keyof typeof COLLECTIONS;
export const COLL_NAMES = Object.keys(COLLECTIONS) as Coll[];

const DB_NAME = 'yuzhi';
const FACT_SEQ_KEY = 'factSeq';
export const IDB_SCHEMA_VERSION = 3;
export const DATA_VERSION = 2;
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
    life: [],
    interruptions: [],
    snapshots: [],
    settings: defaultSettings(),
  };
}

type RawData = Record<string, unknown> & { settings: unknown };

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

      const orderedLife = life
        .map((value, index) => ({ value, index }))
        .sort((a, b) => {
          const ad = a.value && typeof a.value === 'object' && !Array.isArray(a.value) ? (a.value as Record<string, unknown>).date : '';
          const bd = b.value && typeof b.value === 'object' && !Array.isArray(b.value) ? (b.value as Record<string, unknown>).date : '';
          return String(ad ?? '').localeCompare(String(bd ?? '')) || a.index - b.index;
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
  put(coll: Coll, item: object): Promise<void>;
  renameFact(coll: 'entries' | 'operations', oldKey: string, item: object): Promise<void>;
  del(coll: Coll, key: string): Promise<void>;
  putSettings(s: Settings): Promise<void>;
  replaceAll(d: Data): Promise<void>;
}

export class IdbPersistence implements Persistence {
  private dbp: Promise<IDBPDatabase>;
  constructor(name = DB_NAME) {
    this.dbp = openDB(name, IDB_SCHEMA_VERSION, {
      upgrade(db) {
        for (const c of COLL_NAMES) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: COLLECTIONS[c] });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      },
      blocking(_currentVersion, _blockedVersion, event) {
        // Do not let an old tab keep a future schema upgrade blocked indefinitely.
        (event.target as IDBDatabase | null)?.close();
      },
    });
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

    const storedVersion = parseStoredDataVersion(storedVersionValue);
    const fromVersion = storedVersion ?? LEGACY_DATA_VERSION;
    const migrated = migrateRawData(raw, fromVersion);
    const data = validateCurrentData(migrated.data, '本地数据');

    try {
      if (migrated.version !== fromVersion) {
        await this.writeAll(db, data, migrated.version);
      } else if (storedVersion === undefined || storedSettings === undefined) {
        const tx = db.transaction('meta', 'readwrite');
        if (storedSettings === undefined) await tx.objectStore('meta').put({ ...data.settings }, 'settings');
        if (storedVersion === undefined) await tx.objectStore('meta').put(DATA_VERSION, 'dataVersion');
        await tx.done;
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
  async put(coll: Coll, item: object) {
    if (coll === 'entries' || coll === 'operations') {
      await this.putFact(coll, item);
      return;
    }
    await (await this.dbp).put(coll, structuredClone(item));
  }

  /**
   * entries / operations share one persisted sequence. The readwrite
   * transaction serializes competing tabs, so two writers cannot commit the
   * same seq even when both tab-local stores computed the same provisional one.
   * Updating an existing fact keeps its original seq (rejudgment/backdating).
   */
  private async putFact(coll: 'entries' | 'operations', item: object) {
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
    // Store keeps the same object reference in memory; update it to the
    // authoritative persisted value once the atomic reservation succeeds.
    (item as Record<string, unknown>).seq = seq;
    await store.put(record);
    await tx.done;
  }
  async renameFact(coll: 'entries' | 'operations', oldKey: string, item: object) {
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
    (item as Record<string, unknown>).seq = previous.seq;
    if (newKey !== oldKey) await store.delete(oldKey);
    await store.put(record);
    await tx.done;
  }

  async del(coll: Coll, key: string) {
    await (await this.dbp).delete(coll, key);
  }
  async putSettings(s: Settings) {
    await (await this.dbp).put('meta', { ...s }, 'settings');
  }
  async replaceAll(d: Data) {
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
  async put() {}
  async renameFact() {}
  async del() {}
  async putSettings() {}
  async replaceAll(d: Data) {
    this.data = structuredClone(d);
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
  'task-moved', 'task-dropped', 'legacy-life',
);
const LIFE_KIND = oneOf('start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete');
const OPERATION_PAYLOAD: Check = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.legacyLifeId !== undefined && typeof o.legacyLifeId !== 'string') return false;
  if (o.life !== undefined && !arrayOf({
    'projectId?': isText, 'taskId?': isText, text: isStr, kind: LIFE_KIND, 'reason?': REASON,
  })(o.life)) return false;
  return true;
};

const SHAPES: Record<Coll, Shape> = {
  projects: {
    id: isText, name: isText, createdAt: isDate, 'lastProgressAt?': isDate, status: oneOf('active', 'closed', 'done'),
    islandSlot: intIn(0, MAX_VILLAGES - 1), 'closedAt?': isDate, 'closeReason?': isStr,
    'resets?': arrayOf({ date: isDate, neglect: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, kind: oneOf('restart', 'trim') }),
    'promptSnoozeUntil?': isDate, 'lastStage?': intIn(0, STAGE_NAMES.length - 1), 'doneAt?': isDate,
    'resting?': oneOf('landmark', 'archive'), 'landmarkIndex?': intIn(0),
  },
  tasks: {
    id: isText, 'projectId?': isText, title: isText, 'scheduledFor?': isDate, postponeCount: intIn(0),
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
  life: {
    id: isText, date: isDate, 'projectId?': isText, 'taskId?': isText, text: isStr,
    kind: oneOf('start', 'task', 'done', 'partial', 'skip', 'stage', 'close', 'restart', 'trim', 'drop', 'event', 'complete'),
    'reason?': REASON, 'fromStage?': intIn(0, STAGE_NAMES.length - 1),
  },
  interruptions: { id: isText, date: isDate, itemType: ITEM_TYPE, itemId: isText, title: isStr, 'projectId?': isText },
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
