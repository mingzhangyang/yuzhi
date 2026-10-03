import type { Data, ISODate, Settings } from './types';
import { COLLECTIONS, type Coll, type Persistence } from './db';
import { localDate } from './lib/date';
import { computeAllVillages, type VillageState } from './logic/decay';

type Item<C extends Coll> = Data[C][number];

/**
 * 内存里的全部数据 + 写穿到持久层。
 * 数据量很小（个人使用），所以启动时全部载入，之后每次改动逐条写回。
 */
export class Store {
  private listeners = new Set<() => void>();
  private pending = false;
  private villageCache: { key: string; map: Map<string, VillageState> } | null = null;
  private version = 0;
  private writes: Promise<unknown> = Promise.resolve();
  /** 测试时可以替换「今天」 */
  clock: () => Date = () => new Date();
  onError: (e: unknown) => void = (e) => console.error(e);

  constructor(public data: Data, private persist: Persistence) {}

  today(): ISODate {
    return localDate(this.clock());
  }

  put<C extends Coll>(coll: C, item: Item<C>): void {
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const rec = item as unknown as Record<string, unknown>;
    const i = arr.findIndex((x) => x[key] === rec[key]);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    this.queue(() => this.persist.put(coll, item as object));
    this.changed();
  }

  renameFact<C extends 'entries' | 'operations'>(coll: C, oldKey: string, item: Item<C>): void {
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const rec = item as unknown as Record<string, unknown>;
    const i = arr.findIndex((x) => x[key] === oldKey);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    this.queue(() => this.persist.renameFact(coll, oldKey, item as object));
    this.changed();
  }

  del<C extends Coll>(coll: C, keyValue: string): void {
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const i = arr.findIndex((x) => x[key] === keyValue);
    if (i >= 0) arr.splice(i, 1);
    this.queue(() => this.persist.del(coll, keyValue));
    this.changed();
  }

  saveSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    const s = this.data.settings;
    this.queue(() => this.persist.putSettings(s));
    this.changed();
  }

  async replaceAll(d: Data): Promise<void> {
    this.data = d;
    this.changed();
    await this.queue(() => this.persist.replaceAll(d));
  }

  /** 等所有写入落盘 */
  flush(): Promise<unknown> {
    return this.writes;
  }

  /**
   * 串行写入。队列本身吞掉错误（交给 onError），后续写入照常进行；
   * 返回的是这一次写入本身，失败时会 reject，等待它的调用方能知道。
   */
  private queue(fn: () => Promise<void>): Promise<void> {
    const op = this.writes.then(fn);
    this.writes = op.catch((e) => this.onError(e));
    return op;
  }

  /** 标记数据已变化，并在本轮任务结束后通知界面 */
  changed(): void {
    this.version++;
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const l of this.listeners) l();
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 各村落的衰败状态（按数据版本和日期缓存） */
  villages(): Map<string, VillageState> {
    const today = this.today();
    const key = `${this.version}|${today}`;
    if (this.villageCache?.key !== key) this.villageCache = { key, map: computeAllVillages(this.data, today) };
    return this.villageCache.map;
  }

  project(id: string | undefined) {
    return id ? this.data.projects.find((p) => p.id === id) : undefined;
  }

  task(id: string | undefined) {
    return id ? this.data.tasks.find((t) => t.id === id) : undefined;
  }

  activeProjects() {
    return this.data.projects.filter((p) => p.status === 'active').sort((a, b) => a.islandSlot - b.islandSlot);
  }
}
