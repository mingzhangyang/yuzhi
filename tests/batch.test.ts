import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbPersistence, MemoryPersistence, emptyData } from '../src/db';
import { Store } from '../src/store';
import { createProject, createTask, editTaskPlan } from '../src/actions';
import { syncThemeDataset } from '../src/ui/theme';

const dbName = (label: string) => `yuzhi-batch-${label}-${Date.now()}-${Math.random()}`;

describe('原子批次写入', () => {
  it('原生 async 回调在执行前拒绝，包括绑定后的回调', async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(emptyData(), persistence);
    let entered = false;
    const callback = async () => {
      entered = true;
      store.saveSettings({ theme: 'dark' });
      await Promise.resolve();
      createProject(store, '逃逸的写入');
    };
    // @ts-expect-error Promise-returning callbacks are forbidden by the public API.
    expect(() => store.batch(callback)).toThrow('must be synchronous');
    // @ts-expect-error Binding must not hide an async callback from the contract.
    expect(() => store.batch(callback.bind(null))).toThrow('must be synchronous');
    await Promise.resolve();
    await store.flush();
    expect(entered).toBe(false);
    expect(await persistence.load()).toEqual(emptyData());
    createProject(store, '正常同步动作');
    await store.flush();
    expect(store.data.projects).toHaveLength(1);
  });

  it('普通函数包装的异步工作在回滚后不能另起批次，结束后恢复正常写入', async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(emptyData(), persistence);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let attempted = false;
    let continuation!: Promise<void>;
    const wrapped = () => {
      store.saveSettings({ theme: 'dark' });
      continuation = gate.then(() => {
        attempted = true;
        createProject(store, '异步逃逸');
      });
      return continuation;
    };
    // @ts-expect-error Test the JS/untyped boundary as well as static rejection.
    expect(() => store.batch(wrapped)).toThrow('must be synchronous');
    expect(store.data.settings.theme).toBe('auto');
    expect(() => store.saveSettings({ theme: 'light' })).toThrow('异步 batch 尚未结束');
    resume();
    await expect(continuation).rejects.toThrow('异步 batch 尚未结束');
    await store.flush();
    expect(attempted).toBe(true);
    expect(await persistence.load()).toEqual(emptyData());
    createProject(store, '结束后重试');
    await store.flush();
    expect((await persistence.load()).projects.map((p) => p.name)).toEqual(['结束后重试']);
  });

  it('捕获嵌套 thenable 错误也不能提交异步回调的同步前缀', async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(emptyData(), persistence);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let continuation!: Promise<void>;
    expect(() => store.batch(() => {
      createProject(store, '外层前缀');
      try {
        // @ts-expect-error Runtime rejection must poison the outer transaction.
        store.batch(() => {
          store.saveSettings({ theme: 'dark' });
          continuation = gate.then(() => store.saveSettings({ theme: 'light' }));
          return continuation;
        });
      } catch { /* the outer callback must not hide the invalid nested batch */ }
    })).toThrow('must be synchronous');
    resume();
    await expect(continuation).rejects.toThrow('异步 batch 尚未结束');
    await store.flush();
    expect(store.data).toEqual(emptyData());
    expect(await persistence.load()).toEqual(emptyData());
  });

  it('PromiseLike（包括可调用 thenable）失败被消费且不会留下永久写入禁用', async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(emptyData(), persistence);
    const thenable = Object.assign(() => {}, {
      then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        try { store.saveSettings({ theme: 'dark' }); } catch (error) { reject(error); }
      },
    });
    expect(() => store.batch(() => thenable)).toThrow('must be synchronous');
    await Promise.resolve();
    await Promise.resolve();
    store.saveSettings({ theme: 'light' });
    await store.flush();
    expect((await persistence.load()).settings.theme).toBe('light');
  });

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

  it('任务归属和日期一起保存时只产生一个持久化 transaction', async () => {
    class CountedPersistence extends MemoryPersistence {
      commits = 0;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        this.commits++;
        return super.batch(writes);
      }
    }
    const persistence = new CountedPersistence();
    const store = new Store(emptyData(), persistence);
    const from = createProject(store, '原村落');
    const to = createProject(store, '新村落');
    const task = createTask(store, { title: '同时改归属和日期', projectId: from.id, scheduledFor: '2026-10-04' });
    await store.flush();

    persistence.commits = 0;
    editTaskPlan(store, task.id, to.id, '2026-10-10');
    await store.flush();

    expect(persistence.commits).toBe(1);
    expect(store.task(task.id)).toMatchObject({ projectId: to.id, scheduledFor: '2026-10-10' });
  });

  it('组合任务保存落盘失败时归属和日期一起回滚', async () => {
    class FailNextPersistence extends MemoryPersistence {
      failNext = false;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('组合保存失败');
        }
        return super.batch(writes);
      }
    }
    const persistence = new FailNextPersistence();
    const store = new Store(emptyData(), persistence);
    store.onError = () => {};
    const from = createProject(store, '原村落');
    const to = createProject(store, '新村落');
    const task = createTask(store, { title: '原子编辑', projectId: from.id, scheduledFor: '2026-10-04' });
    await store.flush();

    persistence.failNext = true;
    editTaskPlan(store, task.id, to.id, '2026-10-10');
    await expect(store.flush()).rejects.toThrow('组合保存失败');

    expect(store.task(task.id)).toMatchObject({ projectId: from.id, scheduledFor: '2026-10-04' });
    const durable = await persistence.load();
    const durableStore = new Store(durable, persistence);
    expect(durableStore.task(task.id)).toMatchObject({ projectId: from.id, scheduledFor: '2026-10-04' });
  });

  it('replaceAll 等待写队列真正排空，事实序号不会跨替换边界串改', async () => {
    let markStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });

    class DelayedFirstPersistence extends MemoryPersistence {
      private first = true;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        if (this.first) {
          this.first = false;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
            markStarted();
          });
        }
        return super.batch(writes);
      }
    }

    const persistence = new DelayedFirstPersistence();
    const store = new Store(emptyData(), persistence);
    store.put('operations', {
      id: 'shared-fact',
      seq: 99,
      date: '2026-10-01',
      kind: 'legacy-life',
    });

    const replacement = emptyData();
    replacement.operations = [{
      id: 'shared-fact',
      seq: 77,
      date: '2026-10-01',
      kind: 'legacy-life',
    }];

    const replacing = store.replaceAll(replacement);
    await firstStarted;
    expect(() => createProject(store, '不应插入替换边界')).toThrow('正在替换全部数据');
    releaseFirst();
    await replacing;

    expect(store.data.operations).toEqual(replacement.operations);
    expect((await persistence.load()).operations).toEqual(replacement.operations);
  });

  it('设置写盘失败后，Store 通知会把主题恢复到已提交状态', async () => {
    class FailNextPersistence extends MemoryPersistence {
      failNext = false;
      async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('主题保存失败');
        }
        return super.batch(writes);
      }
    }

    const persistence = new FailNextPersistence();
    const store = new Store(emptyData(), persistence);
    store.onError = () => {};
    const dataset: { theme?: string } = {};
    store.subscribe(() => { syncThemeDataset(store.data.settings.theme, dataset); });

    persistence.failNext = true;
    store.saveSettings({ theme: 'dark' });
    syncThemeDataset(store.data.settings.theme, dataset);
    expect(dataset.theme).toBe('dark');

    await expect(store.flush()).rejects.toThrow('主题保存失败');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(store.data.settings.theme).toBe('auto');
    expect(dataset.theme).toBeUndefined();
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
