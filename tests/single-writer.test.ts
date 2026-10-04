import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbPersistence, emptyData } from '../src/db';
import { Store } from '../src/store';
import { SingleWriterCoordinator } from '../src/single-writer';

class FakeChannel {
  static peers = new Set<FakeChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { FakeChannel.peers.add(this); }
  postMessage(data: unknown) {
    for (const peer of FakeChannel.peers) if (peer !== this) peer.onmessage?.({ data } as MessageEvent);
  }
  close() { FakeChannel.peers.delete(this); }
}

class FakeLocks {
  private held = false;
  async request(_name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<void> | void) {
    if (this.held && options.ifAvailable) return callback(null);
    this.held = true;
    try { return await callback({ name: _name }); } finally { this.held = false; }
  }
}

const channelFactory = () => new FakeChannel();

describe('single writer', () => {
  it('同一时间只允许一个 writer，释放后 reader 可以接管', async () => {
    const locks = new FakeLocks();
    const a = new SingleWriterCoordinator({ ownerId: 'a', locks, channelFactory });
    const b = new SingleWriterCoordinator({ ownerId: 'b', locks, channelFactory });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(a.role).toBe('reader');
    expect(await b.acquire()).toBe(true);
    await b.close();
    await a.close();
  });

  it('拿到锁后仍保持只读，直到刷新准备完成才发布 writer', async () => {
    const locks = new FakeLocks();
    const roles: string[] = [];
    let finish!: () => void;
    const prepared = new Promise<void>((resolve) => { finish = resolve; });
    const tab = new SingleWriterCoordinator({
      ownerId: 'prepared',
      locks,
      channelFactory,
      onRoleChange: (role) => roles.push(role),
    });

    const takeover = tab.takeOver(async () => {
      expect(tab.role).toBe('reader');
      await prepared;
    });
    await Promise.resolve();

    expect(tab.role).toBe('reader');
    expect(roles).toEqual([]);
    finish();
    expect(await takeover).toBe(true);
    expect(tab.role).toBe('writer');
    expect(roles).toEqual(['writer']);

    await tab.release();
    expect(tab.role).toBe('reader');
    expect(roles).toEqual(['writer', 'reader']);
    await tab.close();
  });

  it('刷新失败不会短暂开放写权限，并会释放 lease 给其他标签页', async () => {
    const locks = new FakeLocks();
    const a = new SingleWriterCoordinator({ ownerId: 'failed', locks, channelFactory });
    const b = new SingleWriterCoordinator({ ownerId: 'after-failed', locks, channelFactory });

    await expect(a.takeOver(async () => {
      throw new Error('fresh reload failed');
    })).rejects.toThrow('fresh reload failed');
    expect(a.role).toBe('reader');
    expect(await b.acquire()).toBe(true);

    await b.close();
    await a.close();
  });

  it('没有 Web Locks 时 fail closed，不把 BroadcastChannel 当互斥锁', async () => {
    const tab = new SingleWriterCoordinator({ ownerId: 'unsupported', locks: null, channelFactory });
    expect(tab.supportsWriterLock).toBe(false);
    expect(await tab.acquire()).toBe(false);
    expect(tab.role).toBe('reader');
    await tab.close();
  });

  it('同一 coordinator 释放后可以重新准备并接管，支持 bfcache 恢复', async () => {
    const locks = new FakeLocks();
    let refreshes = 0;
    const tab = new SingleWriterCoordinator({ ownerId: 'resume', locks, channelFactory });
    expect(await tab.acquire()).toBe(true);
    await tab.release();
    expect(await tab.takeOver(async () => { refreshes++; })).toBe(true);
    expect(refreshes).toBe(1);
    expect(tab.role).toBe('writer');
    await tab.close();
  });

  it('commit 广播只通知 reader，不承担互斥', async () => {
    const locks = new FakeLocks();
    let commits = 0;
    const a = new SingleWriterCoordinator({ ownerId: 'a2', locks, channelFactory });
    const b = new SingleWriterCoordinator({ ownerId: 'b2', locks, channelFactory, onPeerCommit: () => commits++ });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    a.announceCommit(1);
    expect(commits).toBe(1);
    await a.close();
    await b.close();
  });
});

describe('read-only persistence', () => {
  it('全新 profile 的只读启动返回空快照，不因缺少 stores 退出', async () => {
    const name = `yuzhi-fresh-readonly-${Date.now()}-${Math.random()}`;
    const reader = new IdbPersistence(name, false);
    expect(await reader.load()).toEqual(emptyData());
    await expect(reader.batch([
      { kind: 'put', coll: 'projects', item: { id: 'p', name: '不能写', createdAt: '2026-10-01', status: 'active', islandSlot: 0 } },
    ])).rejects.toThrow('只读');

    // The same instance can later acquire writer access and initialize schema.
    await reader.setWriteAccess(true);
    expect(await reader.load()).toEqual(emptyData());
    await reader.close();
  });

  it('只读页可读但不能升级 schema 或写入', async () => {
    const name = `yuzhi-readonly-${Date.now()}-${Math.random()}`;
    const writer = new IdbPersistence(name, true);
    await writer.load();
    const reader = new IdbPersistence(name, false);
    const data = await reader.load();
    expect(data).toEqual(emptyData());
    await expect(reader.batch([{ kind: 'put', coll: 'projects', item: { id: 'p', name: '只读', createdAt: '2026-10-01', status: 'active', islandSlot: 0 } }])).rejects.toThrow('只读');
    await writer.close();
    await reader.close();
  });

  it('reader 只有在重连并刷新后才获得持久层写权限', async () => {
    const name = `yuzhi-promote-${Date.now()}-${Math.random()}`;
    const writer = new IdbPersistence(name, true);
    await writer.load();
    await writer.batch([{ kind: 'put', coll: 'projects', item: { id: 'p1', name: '已有村落', createdAt: '2026-10-01', status: 'active', islandSlot: 0 } }]);
    await writer.close();

    const reader = new IdbPersistence(name, false);
    expect((await reader.load()).projects.map((row) => row.id)).toEqual(['p1']);
    await reader.setWriteAccess(true);
    const fresh = await reader.load();
    expect(fresh.projects.map((row) => row.id)).toEqual(['p1']);
    await reader.batch([{ kind: 'put', coll: 'projects', item: { id: 'p2', name: '接管后新增', createdAt: '2026-10-02', status: 'active', islandSlot: 1 } }]);
    await reader.setWriteAccess(false);
    await expect(reader.batch([{ kind: 'del', coll: 'projects', key: 'p1' }])).rejects.toThrow('只读');
    await reader.close();
  });

  it('快速 write -> read 切换按请求顺序串行，不会遗留可写连接', async () => {
    const name = `yuzhi-access-flip-${Date.now()}-${Math.random()}`;
    const seed = new IdbPersistence(name, true);
    await seed.load();
    await seed.close();

    const persistence = new IdbPersistence(name, false);
    await persistence.load();

    const promote = persistence.setWriteAccess(true);
    const demote = persistence.setWriteAccess(false);
    await Promise.all([promote, demote]);

    await expect(persistence.batch([
      { kind: 'put', coll: 'projects', item: { id: 'late', name: '不应写入', createdAt: '2026-10-01', status: 'active', islandSlot: 0 } },
    ])).rejects.toThrow('只读');
    await persistence.close();
  });

  it('并发 replaceAll 与 load 只会看到完整的数据库 revision', async () => {
    const name = `yuzhi-snapshot-${Date.now()}-${Math.random()}`;
    const writer = new IdbPersistence(name, true);
    await writer.load();
    const reader = new IdbPersistence(name, false);

    const versionData = (version: number) => {
      const data = emptyData();
      data.projects.push({ id: 'p', name: `v${version}`, createdAt: '2026-10-01', status: 'active', islandSlot: 0 });
      data.tasks.push({ id: 't', projectId: 'p', title: `v${version}`, status: 'open', createdAt: '2026-10-01' });
      return data;
    };
    await writer.batch([{ kind: 'replaceAll', data: versionData(0) }]);

    for (let version = 1; version <= 12; version++) {
      const load = reader.load();
      const write = writer.batch([{ kind: 'replaceAll', data: versionData(version) }]);
      const [snapshot] = await Promise.all([load, write]);
      expect(snapshot.projects[0]?.name).toBe(snapshot.tasks[0]?.title);
    }

    await reader.close();
    await writer.close();
  });

  it('只读 Store 拒绝 action', () => {
    const store = new Store(emptyData(), new IdbPersistence('unused-readonly', false));
    store.setReadOnly(true);
    expect(() => store.batch(() => store.put('projects', { id: 'p', name: '只读', createdAt: '2026-10-01', status: 'active', islandSlot: 0 }))).toThrow('只读');
  });
});
