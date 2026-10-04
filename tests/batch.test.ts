import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbPersistence, MemoryPersistence, emptyData } from '../src/db';
import { Store } from '../src/store';
import { createProject } from '../src/actions';

const dbName = (label: string) => `yuzhi-batch-${label}-${Date.now()}-${Math.random()}`;

describe('原子批次写入', () => {
  it('一个用户操作只提交一次，并且成功后只通知一次', async () => {
    class CountedPersistence extends MemoryPersistence {
      commits = 0;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        this.commits++;
        return super.batch(writes);
      }
    }
    const persistence = new CountedPersistence();
    const store = new Store(emptyData(), persistence);
    const notifications: string[][] = [];
    store.subscribe(() => notifications.push(store.data.projects.map((project) => project.name)));

    createProject(store, '团队');
    expect(notifications).toEqual([]);
    await store.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(persistence.commits).toBe(1);
    expect(notifications).toEqual([['团队']]);
    expect((await persistence.load()).projects.map((project) => project.name)).toEqual(['团队']);
  });

  it('中途写入失败时 IndexedDB 整批回滚', async () => {
    const name = dbName('idb-rollback');
    const persistence = new IdbPersistence(name);
    await persistence.load();

    await expect(persistence.batch([
      { kind: 'put', coll: 'projects', item: { id: 'p1', name: '团队' } },
      // Missing the object store key forces a DataError after the first put.
      { kind: 'put', coll: 'tasks', item: { title: 'invalid task' } },
    ])).rejects.toThrow();

    const loaded = await new IdbPersistence(name).load();
    expect(loaded.projects).toEqual([]);
    expect(loaded.tasks).toEqual([]);
  });

  it('同一失败 generation 的所有 flush waiter 都收到同一个错误', async () => {
    class FailOncePersistence extends MemoryPersistence {
      private shouldFail = true;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        if (this.shouldFail) {
          this.shouldFail = false;
          throw new Error('同一代写入失败');
        }
        return super.batch(writes);
      }
    }
    const persistence = new FailOncePersistence();
    const store = new Store(emptyData(), persistence);
    store.onError = () => {};
    store.batch(() => {
      store.put('projects', { id: 'failed', name: '失败批次', createdAt: '2026-10-01', status: 'active', islandSlot: 0 });
    });

    const first = store.flush();
    const second = store.flush();
    await expect(first).rejects.toThrow('同一代写入失败');
    await expect(second).rejects.toThrow('同一代写入失败');

    createProject(store, '后续成功');
    await expect(store.flush()).resolves.toBeUndefined();
    expect((await persistence.load()).projects.map((project) => project.name)).toEqual(['后续成功']);
  });

  it('失败时恢复内存、通知回滚状态，并允许后续批次提交', async () => {
    class FailOncePersistence extends MemoryPersistence {
      private shouldFail = true;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        if (this.shouldFail) {
          this.shouldFail = false;
          throw new Error('模拟磁盘写入失败');
        }
        return super.batch(writes);
      }
    }
    const persistence = new FailOncePersistence();
    const store = new Store(emptyData(), persistence);
    const errors: unknown[] = [];
    const snapshots: string[][] = [];
    store.onError = (error) => errors.push(error);
    store.subscribe(() => snapshots.push(store.data.projects.map((project) => project.name)));

    store.batch(() => {
      store.put('projects', { id: 'p-failed', name: '不会留下', createdAt: '2026-10-01', status: 'active', islandSlot: 0 });
      store.put('chronicle', { id: 'c-failed', date: '2026-10-01', text: '临时记录', kind: 'event' });
    });
    await expect(store.flush()).rejects.toThrow('模拟磁盘写入失败');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(store.data.projects).toEqual([]);
    expect(store.data.chronicle).toEqual([]);
    expect(snapshots).toEqual([[]]);
    expect(errors).toHaveLength(1);

    createProject(store, '可重试');
    await store.flush();
    expect((await persistence.load()).projects.map((project) => project.name)).toEqual(['可重试']);
  });
});
