import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppSession } from '../src/app-session';
import { emptyData } from '../src/db';
import { Store } from '../src/store';
import type { ChannelMessage } from '../src/single-writer';

class FakeChannel {
  static peers = new Set<FakeChannel>();
  static deliver = true;
  onmessage: ((event: MessageEvent<ChannelMessage>) => void) | null = null;

  constructor() {
    FakeChannel.peers.add(this);
  }

  postMessage(data: ChannelMessage) {
    if (!FakeChannel.deliver) return;
    for (const peer of FakeChannel.peers) {
      if (peer !== this) peer.onmessage?.({ data } as MessageEvent<ChannelMessage>);
    }
  }

  close() {
    FakeChannel.peers.delete(this);
  }
}

class FakeLocks {
  private held = false;

  async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<void> | void,
  ) {
    if (this.held && options.ifAvailable) return callback(null);
    this.held = true;
    try {
      return await callback({ name });
    } finally {
      this.held = false;
    }
  }
}

const channelFactory = (name: string) => {
  void name;
  return new FakeChannel();
};

beforeEach(() => {
  FakeChannel.peers.clear();
  FakeChannel.deliver = true;
});

describe('AppSession', () => {
  it('统一提交刷新、释放与接管，并从最终持久快照恢复 writer', async () => {
    const name = `yuzhi-session-${Date.now()}-${Math.random()}`;
    const locks = new FakeLocks();
    const a = (await AppSession.start({
      databaseName: name,
      coordinator: { ownerId: 'session-a', locks, channelFactory },
    })).session;
    const b = (await AppSession.start({
      databaseName: name,
      coordinator: { ownerId: 'session-b', locks, channelFactory },
    })).session;

    expect(a.state).toBe('writer');
    expect(b.state).toBe('reader');
    expect(a.store.isReadOnly).toBe(false);
    expect(b.store.isReadOnly).toBe(true);

    let bActivations = 0;
    b.setWriterActivation(() => { bActivations++; });

    a.store.batch(() => {
      a.store.put('projects', {
        id: 'p1',
        name: '最终提交',
        createdAt: '2026-10-04',
        status: 'active',
        islandSlot: 0,
      });
    });
    await a.store.flush();
    await b.whenIdle();
    expect(b.store.data.projects.map((project) => project.id)).toEqual(['p1']);

    await a.suspendForCache();
    expect(a.state).toBe('reader');
    expect(a.store.isReadOnly).toBe(true);

    expect(await b.requestTakeover()).toBe(true);
    expect(b.state).toBe('writer');
    expect(b.store.isReadOnly).toBe(false);
    expect(b.store.data.projects.map((project) => project.id)).toEqual(['p1']);
    expect(bActivations).toBe(1);

    await b.close();
    await a.close();
  });

  it('reader 可在错过广播后主动核对持久层，补偿冻结页面的新鲜度缺口', async () => {
    const name = `yuzhi-session-refresh-${Date.now()}-${Math.random()}`;
    const locks = new FakeLocks();
    const writer = (await AppSession.start({
      databaseName: name,
      coordinator: { ownerId: 'refresh-writer', locks, channelFactory },
    })).session;
    const reader = (await AppSession.start({
      databaseName: name,
      coordinator: { ownerId: 'refresh-reader', locks, channelFactory },
    })).session;

    FakeChannel.deliver = false;
    writer.store.batch(() => {
      writer.store.put('projects', {
        id: 'missed',
        name: '冻结期间提交',
        createdAt: '2026-10-04',
        status: 'active',
        islandSlot: 0,
      });
    });
    await writer.store.flush();
    await reader.whenIdle();
    expect(reader.store.data.projects).toHaveLength(0);

    FakeChannel.deliver = true;
    await reader.refreshReader();
    expect(reader.store.data.projects.map((project) => project.id)).toEqual(['missed']);

    await writer.close();
    await reader.close();
  });

  it('Store.reload 在写队列未静默时拒绝切换快照', async () => {
    let markStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const store = new Store(emptyData(), {
      load: async () => emptyData(),
      batch: async () => {
        markStarted();
        await gate;
        return [];
      },
    });

    store.batch(() => {
      store.put('projects', {
        id: 'pending',
        name: '尚未提交',
        createdAt: '2026-10-04',
        status: 'active',
        islandSlot: 0,
      });
    });
    await started;

    expect(() => store.reload(emptyData())).toThrow('在途写入');

    finish();
    await store.flush();
    expect(() => store.reload(emptyData())).not.toThrow();
  });
});
