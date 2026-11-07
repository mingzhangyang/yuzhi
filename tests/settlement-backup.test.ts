import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleDay } from '../src/actions/settlement';
import { createProject, createTask } from '../src/actions';
import { emptyData, MemoryPersistence, parseBackup } from '../src/db';
import { Store } from '../src/store';
import { deviceDelete, deviceGet, devicePut, devicePutIfCurrent } from '../src/ui/device-store';
import { readSettlementSnapshot, SettlementBackup } from '../src/ui/settlement-backup';

const key = 'lastSettlementSnapshot';

class GatedPersistence extends MemoryPersistence {
  private gates: Promise<void>[] = [];

  blockNext() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    this.gates.push(promise);
    return { resolve, reject };
  }

  override async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
    const gate = this.gates.shift();
    if (gate) await gate;
    return super.batch(writes);
  }
}

function setup() {
  const data = emptyData();
  const persistence = new GatedPersistence(data);
  const store = new Store(data, persistence);
  store.clock = () => new Date(2026, 10, 2, 21);
  store.onError = () => {};
  return { store, persistence, backup: new SettlementBackup(store) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await deviceDelete(key);
});

describe('本机结算快照', () => {
  it('等待结算持久化成功后才保存可导出的完整 JSON', async () => {
    const { store, persistence, backup } = setup();
    const project = createProject(store, '持续保存的项目');
    const task = createTask(store, { title: '已结算任务', projectId: project.id, scheduledFor: '2026-11-02' });
    await store.flush();
    const gate = persistence.blockNext();
    settleDay(store, '2026-11-02', new Map([[`task|${task.id}`, { outcome: 'done' }]]));
    const pending = backup.run('2026-11-02');
    expect(await readSettlementSnapshot()).toBeUndefined();
    gate.resolve();
    expect(await pending).toBe(true);
    const saved = (await readSettlementSnapshot())!;
    expect(saved.date).toBe('2026-11-02');
    expect(parseBackup(saved.json)).toEqual(await persistence.load());
    expect(parseBackup(saved.json).days).toContainEqual({ date: '2026-11-02', status: 'settled' });
    expect(parseBackup(saved.json).entries[0]).toMatchObject({ itemId: task.id, outcome: 'done' });
  });

  it('结算写入失败时不覆盖此前快照，并报告需要处理', async () => {
    const { store, persistence, backup } = setup();
    settleDay(store, '2026-11-01', new Map());
    expect(await backup.run('2026-11-01')).toBe(true);
    const previous = await readSettlementSnapshot();

    const gate = persistence.blockNext();
    settleDay(store, '2026-11-02', new Map());
    const pending = backup.run('2026-11-02');
    gate.reject(new Error('disk full'));
    expect(await pending).toBe(false);
    expect(backup.failed).toBe(true);
    expect(await readSettlementSnapshot()).toEqual(previous);
    expect(store.data.days.some((day) => day.date === '2026-11-02')).toBe(false);
  });

  it('连续结算分别等待自己的提交，不把后续尚未保存的记录放进较早快照', async () => {
    const { store, persistence, backup } = setup();
    const first = persistence.blockNext();
    const second = persistence.blockNext();
    settleDay(store, '2026-11-01', new Map());
    const one = backup.run('2026-11-01');
    settleDay(store, '2026-11-02', new Map());
    const two = backup.run('2026-11-02');
    first.resolve();
    expect(await one).toBe(true);
    expect(parseBackup((await readSettlementSnapshot())!.json).days.map((day) => day.date)).toEqual(['2026-11-01']);
    second.resolve();
    expect(await two).toBe(true);
    expect(parseBackup((await readSettlementSnapshot())!.json).days.map((day) => day.date)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('后续结算失败回滚时，先前已提交结算的快照仍能保存', async () => {
    const { store, persistence, backup } = setup();
    const first = persistence.blockNext();
    const second = persistence.blockNext();
    settleDay(store, '2026-11-01', new Map());
    const one = backup.run('2026-11-01');
    settleDay(store, '2026-11-02', new Map());
    const two = backup.run('2026-11-02');
    first.resolve();
    second.reject(new Error('later failure'));
    expect(await one).toBe(true);
    expect(await two).toBe(false);
    const saved = (await readSettlementSnapshot())!;
    expect(saved.date).toBe('2026-11-01');
    expect(parseBackup(saved.json).days.map((day) => day.date)).toEqual(['2026-11-01']);
  });

  it('导入开始后，旧备份的失败不能覆盖新会话状态', async () => {
    const { store, persistence, backup } = setup();
    const gate = persistence.blockNext();
    settleDay(store, '2026-11-02', new Map());
    const old = backup.run('2026-11-02');
    const importing = store.replaceAll(emptyData());
    importing.catch(() => {});
    gate.reject(new Error('old write failed'));
    expect(await old).toBe(false);
    await expect(importing).rejects.toThrow('old write failed');
    expect(backup.failed).toBe(false);
  });

  it('持久化期间失去并重新取得写权限时，旧请求不能写入快照', async () => {
    const { store, persistence, backup } = setup();
    const gate = persistence.blockNext();
    settleDay(store, '2026-11-02', new Map());
    const pending = backup.run('2026-11-02');
    store.setReadOnly(true);
    store.setReadOnly(false);
    gate.resolve();
    expect(await pending).toBe(false);
    expect(await readSettlementSnapshot()).toBeUndefined();
  });

  it('快照存储失败时保留旧记录并能在恢复后重试', async () => {
    const { store, backup } = setup();
    settleDay(store, '2026-11-01', new Map());
    expect(await backup.run('2026-11-01')).toBe(true);
    const previous = await readSettlementSnapshot();
    settleDay(store, '2026-11-02', new Map());
    await store.flush();
    const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, id) {
      if (this.name === 'kv' && id === key) throw new DOMException('quota', 'QuotaExceededError');
      return put.call(this, value, id);
    });
    expect(await backup.run('2026-11-02')).toBe(false);
    expect(backup.failed).toBe(true);
    expect(await readSettlementSnapshot()).toEqual(previous);
    fault.mockRestore();
    expect(await backup.retry()).toBe(true);
    expect(backup.failed).toBe(false);
    expect((await readSettlementSnapshot())?.date).toBe('2026-11-02');
  });

  it('启动或接管只补建缺失快照，不覆盖已有恢复点', async () => {
    const first = setup();
    settleDay(first.store, '2026-11-02', new Map());
    expect(await first.backup.run('2026-11-02')).toBe(true);
    const previous = await readSettlementSnapshot();
    const second = setup();
    settleDay(second.store, '2026-11-01', new Map());
    expect(await second.backup.ensure('2026-11-01')).toBe(false);
    expect(await readSettlementSnapshot()).toEqual(previous);
    await deviceDelete(key);
    expect(await second.backup.ensure('2026-11-01')).toBe(true);
    expect((await readSettlementSnapshot())?.date).toBe('2026-11-01');
  });

  it('重试不会把未成功保存的结算日期写成新快照', async () => {
    const { store, persistence, backup } = setup();
    settleDay(store, '2026-11-01', new Map());
    expect(await backup.run('2026-11-01')).toBe(true);
    const gate = persistence.blockNext();
    settleDay(store, '2026-11-02', new Map());
    const pending = backup.run('2026-11-02');
    gate.reject(new Error('disk full'));
    expect(await pending).toBe(false);
    store.saveSettings({ theme: 'dark' });
    await store.flush();
    expect(await backup.retry()).toBe(true);
    expect(backup.failed).toBe(false);
    const recovered = (await readSettlementSnapshot())!;
    expect(recovered.date).toBe('2026-11-01');
    expect(parseBackup(recovered.json).days.map((day) => day.date)).toEqual(['2026-11-01']);
    expect(parseBackup(recovered.json).settings.theme).toBe('dark');
  });

  it.each(['import', 'reload'] as const)('%s 后不保留旧快照失败提示，但保留恢复点', async (kind) => {
    const { store, backup } = setup();
    settleDay(store, '2026-11-01', new Map());
    expect(await backup.run('2026-11-01')).toBe(true);
    const previous = await readSettlementSnapshot();
    settleDay(store, '2026-11-02', new Map());
    await store.flush();
    const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, id) {
      if (this.name === 'kv' && id === key) throw new DOMException('quota', 'QuotaExceededError');
      return put.call(this, value, id);
    });
    expect(await backup.run('2026-11-02')).toBe(false);
    fault.mockRestore();
    expect(backup.failed).toBe(true);
    const notice = vi.fn();
    backup.onChange = notice;
    if (kind === 'import') await store.replaceAll(emptyData());
    else store.reload(emptyData());
    expect(backup.failed).toBe(false);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(await backup.retry()).toBe(false);
    expect(await readSettlementSnapshot()).toEqual(previous);
  });

  it.each(['release', 'replace'] as const)('%s 在 put 检查后、事务完成前取消旧备份', async (kind) => {
    await devicePut(key, 'previous');
    const { store } = setup();
    const context = store.captureBackupContext();
    let checks = 0;
    let replacing: Promise<void> | undefined;
    const current = () => {
      if (++checks === 3) queueMicrotask(() => {
        if (kind === 'release') store.setReadOnly(true);
        else replacing = store.replaceAll(emptyData());
      });
      return context.isCurrent();
    };
    expect(await devicePutIfCurrent(key, 'replacement', current, context.signal)).toBe(false);
    await replacing;
    expect(await deviceGet(key)).toBe('previous');
  });

  it('设备库中途失去权限时中止事务，保留原快照', async () => {
    await devicePut(key, 'previous');
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await devicePutIfCurrent(key, 'replacement', current)).toBe(false);
    expect(await deviceGet(key)).toBe('previous');
  });

  it('损坏的本机快照不会被当作可导出的备份', async () => {
    await devicePut(key, { date: '2026-11-02', json: '{invalid' });
    await expect(readSettlementSnapshot()).rejects.toThrow();
  });
});
