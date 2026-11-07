import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStore } from './helpers';
import { createProject } from '../src/actions';
import { settleDay } from '../src/actions/settlement';
import { emptyData, MemoryPersistence, parseBackup } from '../src/db';
import { Store } from '../src/store';

/** Device storage double: in memory, with switchable read/write failures. */
const device = vi.hoisted(() => ({
  map: new Map<string, unknown>(),
  failGet: false,
  failPut: false,
}));
vi.mock('../src/ui/device-store', () => ({
  deviceGet: async (key: string) => {
    if (device.failGet) throw new Error('device storage unavailable');
    return device.map.get(key);
  },
  devicePut: async (key: string, value: unknown) => {
    if (device.failPut) throw new DOMException('quota', 'QuotaExceededError');
    device.map.set(key, value);
  },
  deviceDelete: async (key: string) => {
    if (device.failPut) throw new DOMException('quota', 'QuotaExceededError');
    device.map.delete(key);
  },
}));

import { AutoBackup } from '../src/ui/auto-backup';
import { readSafetyState } from '../src/ui/safety';

function folder(name: string) {
  const files = new Map<string, string>();
  const handle = {
    name,
    files,
    queryPermission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    isSameEntry: async (other: unknown) => other === handle,
    getFileHandle: async (file: string) => ({
      createWritable: async () => {
        let text = '';
        return {
          write: async (chunk: string) => { text += chunk; },
          close: async () => { files.set(file, text); },
          abort: async () => {},
        };
      },
    }),
    keys: async function* () { yield* files.keys(); },
    removeEntry: async (file: string) => { files.delete(file); },
  };
  return handle;
}

class FakeFileHandle {}
(FakeFileHandle.prototype as unknown as Record<string, unknown>).createWritable = () => {};

let picked: ReturnType<typeof folder>;
const storage = new Map<string, string>();
let storageBlocked = false;

beforeEach(() => {
  device.map.clear();
  device.failGet = false;
  device.failPut = false;
  storage.clear();
  storageBlocked = false;
  picked = folder('iCloud 屿志');
  vi.stubGlobal('FileSystemFileHandle', FakeFileHandle);
  vi.stubGlobal('window', { showDirectoryPicker: async () => picked });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageBlocked) throw new DOMException('quota', 'QuotaExceededError');
      storage.set(key, value);
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function island() {
  const env = makeStore('2026-11-02', '2026-10-01');
  createProject(env.store, '屿志推广');
  return env;
}

describe('自动备份（PR #37 第三轮评审）', () => {
  it.each([true, false])('结算保存完成前不覆盖文件，保存成功=%s', async (succeeds) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    gate.catch(() => {});
    class SlowPersistence extends MemoryPersistence {
      override async batch(writes: Parameters<MemoryPersistence['batch']>[0]) {
        await gate;
        return super.batch(writes);
      }
    }
    const data = emptyData();
    const store = new Store(data, new SlowPersistence(data));
    store.clock = () => new Date(2026, 10, 2, 21);
    store.onError = () => {};
    const backup = new AutoBackup(store);
    expect(await backup.choose()).toBe(true);
    const filename = 'yuzhi-auto-2026-11-02.json';
    const previous = picked.files.get(filename)!;
    settleDay(store, '2026-11-02', new Map());
    const pending = backup.run('settled');
    await Promise.resolve();
    expect(picked.files.get(filename)).toBe(previous);
    if (succeeds) resolve();
    else reject(new Error('settlement write failed'));
    expect(await pending).toBe(succeeds);
    if (succeeds) expect(parseBackup(picked.files.get(filename)!).days).toContainEqual({ date: '2026-11-02', status: 'settled' });
    else expect(picked.files.get(filename)).toBe(previous);
  });

  it('不支持文件夹备份的浏览器，启动后的每日备份不会把「不支持」改成「未开启」', async () => {
    vi.stubGlobal('window', {});
    const backup = new AutoBackup(island().store);
    expect(backup.status.kind).toBe('unsupported');
    expect(await backup.run('daily')).toBe(false);
    expect(backup.status.kind).toBe('unsupported');
  });

  it('今天已备份时，接管后读到的另一标签页设置也会反映到状态上', async () => {
    const { store } = island();
    const backup = new AutoBackup(store);
    await backup.run('daily');
    expect(backup.status.kind).toBe('off');
    // Another tab chose a folder and already backed up today.
    device.map.set('autoBackup', { handle: picked, folder: picked.name, lastDate: '2026-11-02' });
    expect(await backup.run('daily')).toBe(false);
    expect(backup.status).toEqual({ kind: 'ready', folder: 'iCloud 屿志', lastDate: '2026-11-02' });
  });

  it('设备库能读但写不进时，选文件夹会报告失败，而不是之后悄悄丢掉选择', async () => {
    const backup = new AutoBackup(island().store);
    await backup.run('daily');
    device.failPut = true;
    expect(await backup.choose()).toBe(false);
    expect(backup.status.kind).toBe('error');
    expect(picked.files.size).toBe(0);
  });

  it('设备库完全不可用时，选择只在本页有效，并照常备份', async () => {
    const backup = new AutoBackup(island().store);
    await backup.run('daily');
    device.failGet = true;
    device.failPut = true;
    expect(await backup.choose()).toBe(true);
    expect([...picked.files.keys()]).toEqual(['yuzhi-auto-2026-11-02.json']);
    expect(await backup.run('settled')).toBe(true);
    expect(backup.status.kind).toBe('ready');
  });

  it('localStorage 写不进时，导出记录仍在本页生效', async () => {
    storageBlocked = true;
    const backup = new AutoBackup(island().store);
    await backup.choose();
    expect(readSafetyState().lastBackup).toBe('2026-11-02');
  });
});
