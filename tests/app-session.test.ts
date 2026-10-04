import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppSession, type SessionPersistence } from '../src/app-session';
import { emptyData, type FactSequenceUpdate, type PersistenceWrite } from '../src/db';
import { Store } from '../src/store';
import { SingleWriterCoordinator, type ChannelMessage } from '../src/single-writer';

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

class ControlledPersistence implements SessionPersistence {
  readonly operations: string[] = [];
  private writeAccess: boolean;
  private promotionGate?: Promise<void>;
  private finishPromotion?: () => void;
  private markPromotionStarted?: () => void;
  private closeGate?: Promise<void>;
  private finishClose?: () => void;
  private markCloseStarted?: () => void;
  promotionStarted: Promise<void> = Promise.resolve();
  closeStarted: Promise<void> = Promise.resolve();

  constructor(writeAccess: boolean) {
    this.writeAccess = writeAccess;
  }

  blockNextPromotion() {
    this.promotionStarted = new Promise<void>((resolve) => { this.markPromotionStarted = resolve; });
    this.promotionGate = new Promise<void>((resolve) => { this.finishPromotion = resolve; });
    return () => this.finishPromotion?.();
  }

  blockNextClose() {
    this.closeStarted = new Promise<void>((resolve) => { this.markCloseStarted = resolve; });
    this.closeGate = new Promise<void>((resolve) => { this.finishClose = resolve; });
    return () => this.finishClose?.();
  }

  async load() {
    this.operations.push('load');
    return emptyData();
  }

  async batch(_writes: PersistenceWrite[]): Promise<FactSequenceUpdate[]> {
    if (!this.writeAccess) throw new Error('只读');
    return [];
  }

  async setWriteAccess(value: boolean) {
    this.operations.push(`access:${value}:start`);
    if (value && this.promotionGate) {
      this.markPromotionStarted?.();
      await this.promotionGate;
      this.promotionGate = undefined;
      this.finishPromotion = undefined;
      this.markPromotionStarted = undefined;
    }
    this.writeAccess = value;
    this.operations.push(`access:${value}:end`);
  }

  async reopen(writeAccess = this.writeAccess) {
    this.operations.push(`reopen:${writeAccess}`);
    this.writeAccess = writeAccess;
  }

  async close() {
    this.operations.push('close');
    if (this.closeGate) {
      this.markCloseStarted?.();
      await this.closeGate;
      this.closeGate = undefined;
      this.finishClose = undefined;
      this.markCloseStarted = undefined;
    }
  }
}

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

  it('页面暂停会关闭持久层与通知通道，恢复后重建资源再开放 writer', async () => {
    const locks = new FakeLocks();
    let persistence!: ControlledPersistence;
    const session = (await AppSession.start({
      coordinator: { ownerId: 'page-lifecycle', locks, channelFactory },
      persistenceFactory: (writeAccess) => {
        persistence = new ControlledPersistence(writeAccess);
        return persistence;
      },
    })).session;

    expect(session.state).toBe('writer');
    expect(FakeChannel.peers.size).toBe(1);
    persistence.operations.length = 0;

    await session.suspendForCache();
    expect(session.state).toBe('reader');
    expect(session.store.isReadOnly).toBe(true);
    expect(FakeChannel.peers.size).toBe(0);
    expect(persistence.operations).toContain('close');

    persistence.operations.length = 0;
    expect(await session.resumeFromCache()).toBe(true);
    expect(session.state).toBe('writer');
    expect(session.store.isReadOnly).toBe(false);
    expect(FakeChannel.peers.size).toBe(1);
    expect(persistence.operations[0]).toBe('reopen:false');
    expect(persistence.operations).toContain('access:true:start');

    await session.close();
  });

  it('resume 等待旧 suspension 时再次 suspend，会使旧 resume 失效且不会重开资源', async () => {
    const locks = new FakeLocks();
    let persistence!: ControlledPersistence;
    const session = (await AppSession.start({
      coordinator: { ownerId: 'overlap-lifecycle', locks, channelFactory },
      persistenceFactory: (writeAccess) => {
        persistence = new ControlledPersistence(writeAccess);
        return persistence;
      },
    })).session;

    expect(session.state).toBe('writer');
    persistence.operations.length = 0;

    const finishClose = persistence.blockNextClose();
    const firstSuspend = session.suspendForCache();
    await persistence.closeStarted;
    expect(session.store.isReadOnly).toBe(true);

    const staleResume = session.resumeFromCache();
    const secondSuspend = session.suspendForCache();

    finishClose();
    await Promise.all([firstSuspend, secondSuspend]);
    expect(await staleResume).toBe(false);

    expect(session.state).toBe('reader');
    expect(session.store.isReadOnly).toBe(true);
    expect(FakeChannel.peers.size).toBe(0);
    expect(persistence.operations.some((operation) => operation.startsWith('reopen:'))).toBe(false);

    await session.close();
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

  it('close 与 takeover preparation 竞态时，final close 之后不会再重开持久层', async () => {
    const locks = new FakeLocks();
    const blocker = new SingleWriterCoordinator({
      ownerId: 'session-close-blocker',
      locks,
      channelFactory,
    });
    expect(await blocker.acquire()).toBe(true);

    let persistence!: ControlledPersistence;
    const session = (await AppSession.start({
      coordinator: { ownerId: 'session-close-reader', locks, channelFactory },
      persistenceFactory: (writeAccess) => {
        persistence = new ControlledPersistence(writeAccess);
        return persistence;
      },
    })).session;
    expect(session.state).toBe('reader');

    await blocker.release();
    persistence.operations.length = 0;
    const finishPromotion = persistence.blockNextPromotion();

    const takeover = session.requestTakeover();
    await persistence.promotionStarted;
    expect(session.state).toBe('preparing');

    const closing = session.close();
    expect(session.state).toBe('closed');

    finishPromotion();
    expect(await takeover).toBe(false);
    await closing;

    const promotionEnd = persistence.operations.indexOf('access:true:end');
    const closeIndex = persistence.operations.indexOf('close');
    expect(promotionEnd).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(promotionEnd);
    expect(persistence.operations.some((operation) => operation.startsWith('reopen:'))).toBe(false);

    await blocker.close();
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
