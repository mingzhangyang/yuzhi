import { openDB, type IDBPDatabase } from 'idb';
import type { Data, Settings } from './types';
import { localDate } from './lib/date';

/** 数据集合名 → 主键字段 */
export const COLLECTIONS = {
  projects: 'id',
  tasks: 'id',
  sources: 'id',
  events: 'id',
  rules: 'id',
  entries: 'id',
  days: 'date',
  chronicle: 'id',
  life: 'id',
  interruptions: 'id',
  snapshots: 'date',
} as const;
export type Coll = keyof typeof COLLECTIONS;
export const COLL_NAMES = Object.keys(COLLECTIONS) as Coll[];

const DB_NAME = 'yuzhi';
const DB_VERSION = 2;
export const BACKUP_FORMAT = 'yuzhi-backup';
export const BACKUP_VERSION = 1;

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
    chronicle: [],
    life: [],
    interruptions: [],
    snapshots: [],
    settings: defaultSettings(),
  };
}

export interface Persistence {
  load(): Promise<Data>;
  put(coll: Coll, item: object): Promise<void>;
  del(coll: Coll, key: string): Promise<void>;
  putSettings(s: Settings): Promise<void>;
  replaceAll(d: Data): Promise<void>;
}

export class IdbPersistence implements Persistence {
  private dbp: Promise<IDBPDatabase>;
  constructor(name = DB_NAME) {
    this.dbp = openDB(name, DB_VERSION, {
      upgrade(db) {
        for (const c of COLL_NAMES) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: COLLECTIONS[c] });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      },
    });
  }
  async load(): Promise<Data> {
    const db = await this.dbp;
    const d = emptyData();
    for (const c of COLL_NAMES) (d as unknown as Record<Coll, unknown[]>)[c] = await db.getAll(c);
    const s = (await db.get('meta', 'settings')) as Settings | undefined;
    if (s) d.settings = { ...defaultSettings(), ...s };
    else await db.put('meta', d.settings, 'settings');
    return d;
  }
  async put(coll: Coll, item: object) {
    await (await this.dbp).put(coll, structuredClone(item));
  }
  async del(coll: Coll, key: string) {
    await (await this.dbp).delete(coll, key);
  }
  async putSettings(s: Settings) {
    await (await this.dbp).put('meta', { ...s }, 'settings');
  }
  async replaceAll(d: Data) {
    const db = await this.dbp;
    const tx = db.transaction([...COLL_NAMES, 'meta'], 'readwrite');
    for (const c of COLL_NAMES) {
      const st = tx.objectStore(c);
      await st.clear();
      for (const item of (d as unknown as Record<Coll, object[]>)[c]) await st.put(structuredClone(item));
    }
    await tx.objectStore('meta').put({ ...d.settings }, 'settings');
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
  async del() {}
  async putSettings() {}
  async replaceAll(d: Data) {
    this.data = structuredClone(d);
  }
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 校验备份里的设置：类型、格式、取值范围都对才接受，否则整份备份拒绝 */
export function parseSettings(v: unknown): Settings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('备份里的设置格式不对');
  const o = v as Record<string, unknown>;
  const s = defaultSettings();
  const str = (k: string, re: RegExp, label: string) => {
    if (o[k] === undefined) return undefined;
    if (typeof o[k] !== 'string' || !re.test(o[k] as string)) throw new Error(`备份里的${label}格式不对`);
    return o[k] as string;
  };
  s.workStart = str('workStart', HM, '工作开始时间') ?? s.workStart;
  s.workEnd = str('workEnd', HM, '工作结束时间') ?? s.workEnd;
  s.firstDay = str('firstDay', YMD, '起始日期') ?? s.firstDay;
  if (s.workEnd <= s.workStart) throw new Error('备份里的工作时段不对：结束要晚于开始');
  if (o.theme !== undefined) {
    if (o.theme !== 'auto' && o.theme !== 'light' && o.theme !== 'dark') throw new Error('备份里的外观设置不对');
    s.theme = o.theme;
  }
  return s;
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
  if (typeof o.version !== 'number' || o.version > BACKUP_VERSION) throw new Error('备份来自更新的版本，请先升级屿志');
  const d = emptyData();
  for (const c of COLL_NAMES) {
    const v = o[c];
    if (v == null) continue;
    if (!Array.isArray(v)) throw new Error(`备份里的 ${c} 格式不对`);
    const key = COLLECTIONS[c];
    if (v.some((x) => !x || typeof x !== 'object' || typeof (x as Record<string, unknown>)[key] !== 'string')) throw new Error(`备份里的 ${c} 有损坏的记录`);
    (d as unknown as Record<Coll, unknown[]>)[c] = v;
  }
  if (o.settings != null) d.settings = parseSettings(o.settings);
  return d;
}
