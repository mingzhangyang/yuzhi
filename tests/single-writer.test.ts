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
    expect(await b.acquire()).toBe(true);
    await b.close();
    await a.close();
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
  it('只读页可读但不能升级 schema 或写入', async () => {
    const name = `yuzhi-readonly-${Date.now()}-${Math.random()}`;
    const writer = new IdbPersistence(name, true);
    await writer.load();
    const reader = new IdbPersistence(name, false);
    const data = await reader.load();
    expect(data).toEqual(emptyData());
    await expect(reader.batch([{ kind: 'put', coll: 'projects', item: { id: 'p', name: '只读', createdAt: '2026-10-01', status: 'active', islandSlot: 0 } }])).rejects.toThrow('只读');
    writer.close();
    reader.close();
  });

  it('只读 Store 拒绝 action', () => {
    const store = new Store(emptyData(), new IdbPersistence('unused-readonly', false));
    store.setReadOnly(true);
    expect(() => store.batch(() => store.put('projects', { id: 'p', name: '只读', createdAt: '2026-10-01', status: 'active', islandSlot: 0 }))).toThrow('只读');
  });
});
