import type { Data, ISODate, Settings } from './types';
import { COLLECTIONS, type Coll, type FactSequenceUpdate, type Persistence, type PersistenceWrite } from './db';
import { localDate } from './lib/date';
import { backlog } from './logic/metrics';
import { computeAllVillages, markDecayDataChanged, type VillageState } from './logic/decay';
import { taskState, taskStates } from './logic/read-model';

type Item<C extends Coll> = Data[C][number];
type PendingBatch = { writes: PersistenceWrite[]; snapshot: Data };
type SyncCallback<T> = () => T & (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);

/**
 * 内存里的全部数据 + 持久层。一个 batch 对应一个 IndexedDB transaction；
 * 内存允许在写盘期间暂时前移，但只在整批写入完成后通知界面，失败时回到最近一次已提交状态。
 */
export class Store {
  private listeners = new Set<() => void>();
  private notifyPending = false;
  private villageCache: { key: string; map: Map<string, VillageState> } | null = null;
  private version = 0;
  /** Internal queue tail; always resolves so later generations can proceed. */
  private writeTail: Promise<void> = Promise.resolve();
  /** Observable outcome of the latest queued generation; rejection is reusable by every waiter. */
  private flushTail: Promise<void> = Promise.resolve();
  private activeWrites: PersistenceWrite[] | null = null;
  private pendingBatches = new Set<PendingBatch>();
  private committedData: Data;
  private batchChanged = false;
  private hasBatchFailure = false;
  private batchFailure: unknown;
  private readOnly = false;
  private accessGeneration = 0;
  /** Dynamic/JS callers can hide async work behind an ordinary function. */
  private rejectedAsyncCallbacks = 0;
  private callbackContractError: Error | undefined;
  /** Full-snapshot replacement is an exclusive barrier over the write queue. */
  private replacementInProgress = false;
  /** 测试时可以替换「今天」 */
  clock: () => Date = () => new Date();
  onError: (e: unknown) => void = (e) => console.error(e);
  /** Called after a persistence transaction commits, before subscribers run. */
  onCommitted: () => void = () => {};

  constructor(
    public data: Data,
    private persist: Persistence,
    private readonly lifecycleRevision: () => number = () => 0,
  ) {
    this.committedData = structuredClone(data);
  }

  setReadOnly(value: boolean) {
    if (this.readOnly !== value) this.accessGeneration++;
    this.readOnly = value;
  }

  get isReadOnly() {
    return this.readOnly;
  }

  /**
   * Async work belongs to one ownership generation and one data snapshot.
   * A writer -> reader -> writer cycle never revives the old permission.
   * The application supplies the coordinator revision; accessGeneration also
   * protects standalone Stores and snapshot identity covers reload/import.
   */
  captureWriteContext() {
    this.assertWritable();
    const generation = this.accessGeneration;
    const revision = this.lifecycleRevision();
    const data = this.data;
    const isCurrent = () => !this.readOnly && generation === this.accessGeneration
      && revision === this.lifecycleRevision() && data === this.data;
    return {
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new Error('异步任务的写权限或数据快照已失效，已丢弃结果');
      },
    };
  }

  /** Replace the in-memory snapshot after a read-only tab observes another tab's commit. */
  reload(data: Data) {
    this.data = structuredClone(data);
    this.committedData = structuredClone(this.data);
    this.pendingBatches.clear();
    this.hasBatchFailure = false;
    this.batchFailure = undefined;
    this.writeTail = Promise.resolve();
    this.flushTail = Promise.resolve();
    this.invalidateData();
    this.batchChanged = true;
    this.scheduleNotify();
  }

  private assertWritable(allowReplacement = false) {
    if (this.rejectedAsyncCallbacks) throw new Error('被拒绝的异步 batch 尚未结束，暂时禁止写入');
    if (this.readOnly) throw new Error('当前标签页是只读的，请切换到拥有写权限的标签页');
    if (this.replacementInProgress && !allowReplacement) throw new Error('正在替换全部数据，请等待导入完成');
  }

  today(): ISODate {
    return localDate(this.clock());
  }

  /**
   * Group synchronous in-memory mutations into one durable commit. Nested calls
   * share the outer transaction, so composite actions such as settleDay or
   * seedDemo still produce one persistence transaction.
   */
  batch<T>(fn: SyncCallback<T>): T {
    return this.batchInternal(fn, false);
  }

  private invokeSynchronous<T>(fn: () => T): T {
    // Reject native async callbacks before even their pre-await side effects.
    if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') {
      throw new Error('Store.batch callback must be synchronous');
    }
    const result = fn();
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') {
      // TypeScript rejects PromiseLike results, but a JS caller/wrapper may
      // still return one. Quarantine all mutations until that work settles so
      // its continuation cannot escape the rejected batch as a fresh action.
      // Consume its rejection too: the caller already receives the sync error.
      this.rejectedAsyncCallbacks++;
      const settled = () => { this.rejectedAsyncCallbacks--; };
      void Promise.resolve(result).then(settled, settled);
      const error = new Error('Store.batch callback must be synchronous');
      this.callbackContractError = error;
      throw error;
    }
    return result;
  }

  private batchInternal<T>(fn: () => T, allowReplacement: boolean): T {
    this.assertWritable(allowReplacement);
    if (this.activeWrites) {
      return this.invokeSynchronous(fn);
    }

    if (this.pendingBatches.size === 0) {
      this.committedData = structuredClone(this.data);
      this.hasBatchFailure = false;
      this.batchFailure = undefined;
    }
    const before = structuredClone(this.data);
    const changedBefore = this.batchChanged;
    const writes: PersistenceWrite[] = [];
    this.activeWrites = writes;
    this.callbackContractError = undefined;

    let result: T;
    try {
      result = this.invokeSynchronous(fn);
      // A caller catching a nested async violation must not commit its prefix.
      if (this.callbackContractError) throw this.callbackContractError;
      this.updateBacklogSnapshot();
    } catch (error) {
      this.activeWrites = null;
      this.data = before;
      this.batchChanged = changedBefore;
      this.invalidateData();
      throw error;
    }
    this.activeWrites = null;

    if (!writes.length) {
      if (this.pendingBatches.size === 0 && this.batchChanged) {
        this.batchChanged = false;
        this.scheduleNotify();
      }
      return result;
    }

    const pending: PendingBatch = { writes, snapshot: structuredClone(this.data) };
    this.pendingBatches.add(pending);
    const commit = this.writeTail.then(async () => {
      if (this.hasBatchFailure) throw this.batchFailure;
      const sequenceUpdates = await this.persist.batch(writes);
      this.applySequenceUpdates(sequenceUpdates);
      this.committedData = structuredClone(pending.snapshot);
      try { this.onCommitted(); } catch (error) { this.onError(error); }
    });

    const finish = () => {
      this.pendingBatches.delete(pending);
      if (this.pendingBatches.size === 0) {
        if (this.hasBatchFailure) {
          this.data = structuredClone(this.committedData);
          this.hasBatchFailure = false;
          this.batchFailure = undefined;
        }
        if (this.batchChanged) {
          this.batchChanged = false;
          this.scheduleNotify();
        }
      }
    };

    const outcome = commit.then(
      () => { finish(); },
      (error) => {
        if (!this.hasBatchFailure) {
          this.hasBatchFailure = true;
          this.batchFailure = error;
          this.data = structuredClone(this.committedData);
          this.invalidateData();
          this.batchChanged = true;
          try { this.onError(error); } catch { /* reporting must not block cleanup */ }
        }
        finish();
        throw error;
      },
    );

    // Attach a handler immediately to avoid unhandled-rejection noise when no
    // caller flushes, while retaining the original rejected promise so every
    // waiter for this generation observes the same failure.
    outcome.catch(() => {});
    this.flushTail = outcome;
    this.writeTail = outcome.catch(() => {});
    return result;
  }

  private updateBacklogSnapshot() {
    const date = this.today();
    const value = backlog(this.data, date).total;
    const current = this.data.snapshots.find((snapshot) => snapshot.date === date);
    if (current?.backlog !== value) this.put('snapshots', { date, backlog: value });
  }

  private applySequenceUpdates(updates: FactSequenceUpdate[]) {
    const apply = (data: Data, update: FactSequenceUpdate) => {
      const keyField = COLLECTIONS[update.coll];
      const row = (data[update.coll] as unknown as Record<string, unknown>[]).find((item) => item[keyField] === update.key);
      if (row) row.seq = update.seq;
    };
    for (const update of updates) {
      apply(this.data, update);
      for (const batch of this.pendingBatches) apply(batch.snapshot, update);
    }
    if (updates.length) this.invalidateData();
  }

  put<C extends Coll>(coll: C, item: Item<C>): void {
    const writes = this.activeWrites;
    if (!writes) {
      this.batch(() => this.put(coll, item));
      return;
    }
    const stored = structuredClone(item);
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const rec = stored as unknown as Record<string, unknown>;
    const i = arr.findIndex((x) => x[key] === rec[key]);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    writes.push({ kind: 'put', coll, item: stored as object });
    this.changed();
  }

  renameFact<C extends 'entries' | 'operations'>(coll: C, oldKey: string, item: Item<C>): void {
    const writes = this.activeWrites;
    if (!writes) {
      this.batch(() => this.renameFact(coll, oldKey, item));
      return;
    }
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const rec = structuredClone(item) as unknown as Record<string, unknown>;
    const i = arr.findIndex((x) => x[key] === oldKey);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    writes.push({ kind: 'renameFact', coll, oldKey, item: rec });
    this.changed();
  }

  del<C extends Coll>(coll: C, keyValue: string): void {
    const writes = this.activeWrites;
    if (!writes) {
      this.batch(() => this.del(coll, keyValue));
      return;
    }
    const key = COLLECTIONS[coll];
    const arr = this.data[coll] as unknown as Record<string, unknown>[];
    const i = arr.findIndex((x) => x[key] === keyValue);
    if (i >= 0) arr.splice(i, 1);
    writes.push({ kind: 'del', coll, key: keyValue });
    if (i >= 0) this.changed();
  }

  saveSettings(patch: Partial<Settings>): void {
    const writes = this.activeWrites;
    if (!writes) {
      this.batch(() => this.saveSettings(patch));
      return;
    }
    this.data.settings = { ...this.data.settings, ...patch };
    writes.push({ kind: 'putSettings', settings: { ...this.data.settings } });
    this.changed();
  }

  /**
   * Drain every batch that is still pending while this barrier is waiting.
   * Unlike flush(), which intentionally snapshots one generation for ordinary
   * callers, replacement must begin from a fully committed queue boundary.
   */
  private async drainPendingWrites(): Promise<void> {
    while (this.pendingBatches.size > 0) {
      const generation = this.flushTail;
      await generation;
    }
  }

  async replaceAll(d: Data): Promise<void> {
    this.assertWritable();
    if (this.activeWrites) throw new Error('Store.replaceAll cannot run inside Store.batch');
    const replacement = structuredClone(d);
    this.replacementInProgress = true;

    try {
      // Replacement is an exclusive queue boundary. New business batches are
      // rejected from this point until the replacement commits, so nothing can
      // slip into the gap between draining the old queue and capturing the new
      // durable snapshot.
      await this.drainPendingWrites();
      this.assertWritable(true);

      this.batchInternal(() => {
        this.data = structuredClone(replacement);
        this.activeWrites!.push({ kind: 'replaceAll', data: structuredClone(replacement) });
        this.changed();
      }, true);
      await this.flush();
    } finally {
      this.replacementInProgress = false;
    }
  }

  /** 等调用时已经排队的写入落盘；同一代的所有 waiter 都观察到同一个结果。 */
  async flush(): Promise<void> {
    const generation = this.flushTail;
    await generation;
  }

  private invalidateData(): void {
    markDecayDataChanged(this.data);
    this.version++;
  }

  private scheduleNotify() {
    if (this.notifyPending) return;
    this.notifyPending = true;
    queueMicrotask(() => {
      this.notifyPending = false;
      for (const listener of this.listeners) listener();
    });
  }

  /** Mark data changed. Inside a batch this invalidates caches immediately but delays UI notification. */
  changed(): void {
    this.invalidateData();
    if (this.activeWrites) {
      this.batchChanged = true;
      return;
    }
    this.scheduleNotify();
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

  /** Raw entity record. Use only when editing entity-owned fields. */
  taskRecord(id: string | undefined) {
    return id ? this.data.tasks.find((t) => t.id === id) : undefined;
  }

  /** Effective task after replaying facts. */
  task(id: string | undefined) {
    const raw = this.taskRecord(id);
    return raw ? taskState(this.data, raw) : undefined;
  }

  /** Effective task list after replaying facts. */
  tasks() {
    return taskStates(this.data);
  }

  activeProjects() {
    return this.data.projects.filter((p) => p.status === 'active').sort((a, b) => a.islandSlot - b.islandSlot);
  }
}
