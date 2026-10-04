export type WriterRole = 'writer' | 'reader';
export type WriterState = 'reader' | 'preparing' | 'writer' | 'releasing' | 'recovering' | 'closed';
export type WriterPreparation = () => Promise<void> | void;

type LockLike = { name: string } | null;
type LockRequest = (
  name: string,
  options: { ifAvailable?: boolean },
  callback: (lock: LockLike) => Promise<void> | void,
) => Promise<unknown>;

export interface ChannelMessage {
  type: 'writer-state' | 'commit';
  ownerId: string;
  active?: boolean;
  revision?: number;
}

export interface SingleWriterOptions {
  lockName?: string;
  channelName?: string;
  ownerId?: string;
  /**
   * Pass null to explicitly disable Web Locks (used by tests and unsupported
   * browsers). Undefined means "use navigator.locks when available".
   */
  locks?: { request: LockRequest } | null;
  channelFactory?: (name: string) => { onmessage: ((event: MessageEvent<ChannelMessage>) => void) | null; postMessage(message: ChannelMessage): void; close(): void };
  onStateChange?: (state: WriterState) => void;
  /** Compatibility observer for consumers that only care about reader/writer. */
  onRoleChange?: (role: WriterRole) => void;
  onPeerCommit?: () => void;
  /**
   * Runs while the writer lease is still held after a database versionchange.
   * The coordinator revokes writability before invoking this callback and
   * releases the lease only after the callback settles.
   */
  onVersionChange?: WriterPreparation;
}

const randomOwner = () => 'tab|' + Date.now().toString(36) + '|' + Math.random().toString(36).slice(2);

/**
 * Coordinates one write-capable tab per browser profile.
 *
 * This class is the single authority for write lifecycle. Only writer state is
 * writable; every transitional state is fail-closed. The Web Lock is the lease,
 * while BroadcastChannel remains notification-only.
 */
export class SingleWriterCoordinator {
  readonly ownerId: string;
  readonly lockName: string;
  readonly channelName: string;

  private readonly locks?: { request: LockRequest };
  private readonly channel?: ReturnType<NonNullable<SingleWriterOptions['channelFactory']>>;
  private readonly onStateChange?: (state: WriterState) => void;
  private readonly onRoleChange?: (role: WriterRole) => void;
  private readonly onPeerCommit?: () => void;
  private readonly onVersionChange?: WriterPreparation;
  private releaseLock: (() => void) | undefined;
  private lockTask: Promise<unknown> | undefined;
  private acquireTask: Promise<boolean> | undefined;
  private demotionTask: Promise<void> | undefined;
  private releaseRequested = false;
  private closed = false;
  private currentState: WriterState = 'reader';
  private stateRevision = 0;

  constructor(options: SingleWriterOptions = {}) {
    this.ownerId = options.ownerId ?? randomOwner();
    this.lockName = options.lockName ?? 'yuzhi-single-writer';
    this.channelName = options.channelName ?? 'yuzhi-single-writer';
    const nativeLocks = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: { request: LockRequest } }).locks
      : undefined;
    this.locks = options.locks === undefined ? nativeLocks : options.locks ?? undefined;
    this.onStateChange = options.onStateChange;
    this.onRoleChange = options.onRoleChange;
    this.onPeerCommit = options.onPeerCommit;
    this.onVersionChange = options.onVersionChange;
    const makeChannel = options.channelFactory ?? ((name: string) => typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : undefined);
    this.channel = makeChannel?.(this.channelName) as typeof this.channel;
    if (this.channel) this.channel.onmessage = (event) => this.receive(event.data);
  }

  get supportsWriterLock() {
    return Boolean(this.locks);
  }

  get state(): WriterState {
    return this.currentState;
  }

  get revision(): number {
    return this.stateRevision;
  }

  get role(): WriterRole {
    return this.currentState === 'writer' ? 'writer' : 'reader';
  }

  get isWritable(): boolean {
    return this.currentState === 'writer';
  }

  private setState(state: WriterState) {
    if (this.currentState === state) return;
    const previousRole = this.role;
    this.currentState = state;
    this.stateRevision++;
    this.onStateChange?.(state);
    const nextRole = this.role;
    if (previousRole !== nextRole) this.onRoleChange?.(nextRole);
  }

  private announce(message: ChannelMessage) {
    try { this.channel?.postMessage(message); } catch { /* a closing tab is already done */ }
  }

  private receive(message: ChannelMessage) {
    if (!message || message.ownerId === this.ownerId) return;
    // Transitional states deliberately ignore peer commits. Recovery/preparation
    // already performs its own authoritative refresh.
    if (message.type === 'commit' && this.currentState === 'reader') this.onPeerCommit?.();
  }

  /**
   * Acquire the single-writer lease. Preparation runs while the lock is held
   * and state is preparing; writability is published only after it succeeds.
   */
  async acquire(prepare?: WriterPreparation): Promise<boolean> {
    if (this.closed || this.currentState === 'closed') return false;
    if (this.releaseRequested || this.currentState === 'recovering' || this.currentState === 'releasing') return false;
    if (this.isWritable) return true;
    if (!this.locks) return false;
    if (this.acquireTask) return this.acquireTask;

    const task = this.acquireOnce(prepare);
    this.acquireTask = task;
    try {
      return await task;
    } finally {
      if (this.acquireTask === task) this.acquireTask = undefined;
    }
  }

  private acquireOnce(prepare?: WriterPreparation): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const succeed = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      this.lockTask = this.locks!.request(this.lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          succeed(false);
          return;
        }

        let resolveHeld!: () => void;
        const held = new Promise<void>((resolveHeldPromise) => { resolveHeld = resolveHeldPromise; });
        let activated = false;
        this.setState('preparing');
        try {
          await prepare?.();
          if (this.closed || this.releaseRequested || this.currentState !== 'preparing') {
            succeed(false);
            return;
          }

          this.releaseLock = resolveHeld;
          activated = true;
          this.setState('writer');
          this.announce({ type: 'writer-state', ownerId: this.ownerId, active: true });
          succeed(true);
          await held;
        } catch (error) {
          fail(error);
        } finally {
          this.releaseLock = undefined;
          if (!this.closed && this.currentState === 'preparing') this.setState('reader');
          if (activated && !this.closed) {
            if (this.currentState === 'writer') this.setState('reader');
            this.announce({ type: 'writer-state', ownerId: this.ownerId, active: false });
          }
        }
      }).catch(fail);
    });
  }

  async takeOver(prepare?: WriterPreparation): Promise<boolean> {
    return this.acquire(prepare);
  }

  announceCommit(revision = Date.now()) {
    if (!this.isWritable) return;
    this.announce({ type: 'commit', ownerId: this.ownerId, revision });
  }

  private async releaseLease() {
    this.releaseRequested = true;
    const release = this.releaseLock;
    if (release) release();
    await this.lockTask?.catch(() => {});
    this.releaseLock = undefined;
    this.lockTask = undefined;
    this.releaseRequested = false;
  }

  private startDemotion(state: 'releasing' | 'recovering', prepare?: WriterPreparation): Promise<void> {
    if (this.closed || this.currentState === 'closed') return Promise.resolve();
    if (this.demotionTask) return this.demotionTask;
    if (this.currentState === 'reader' && !this.lockTask && !prepare) return Promise.resolve();

    // Revocation is synchronous: observers cannot keep writing while async
    // persistence cleanup or lease release is still in flight.
    this.setState(state);
    const task = (async () => {
      try {
        await prepare?.();
      } finally {
        await this.releaseLease();
        if (!this.closed) this.setState('reader');
      }
    })();
    this.demotionTask = task;
    task.catch(() => {});
    void task.then(
      () => { if (this.demotionTask === task) this.demotionTask = undefined; },
      () => { if (this.demotionTask === task) this.demotionTask = undefined; },
    );
    return task;
  }

  /** Release the lease while keeping the channel alive for a later takeover. */
  async release() {
    await this.startDemotion('releasing');
  }

  /**
   * Stop writes synchronously, run persistence cleanup while still owning the
   * lease, then release it. Used for bfcache/page suspension.
   */
  async relinquish(prepare?: WriterPreparation) {
    await this.startDemotion('releasing', prepare);
  }

  /**
   * Wait until any preparation or demotion transition has settled. This is a
   * lifecycle barrier, not a timer.
   */
  async whenStable(): Promise<void> {
    while (true) {
      const demotion = this.demotionTask;
      if (demotion) {
        await demotion;
        continue;
      }
      const acquisition = this.currentState === 'preparing' ? this.acquireTask : undefined;
      if (acquisition) {
        await acquisition;
        continue;
      }
      return;
    }
  }

  /**
   * Run work against one stable coordinator revision. If role changes while the
   * async work is in flight, discard that result and retry against the new
   * authoritative state.
   */
  async runAgainstStableState<T>(work: (writable: boolean) => Promise<T>): Promise<T> {
    while (true) {
      await this.whenStable();
      const revision = this.stateRevision;
      try {
        const result = await work(this.isWritable);
        await this.whenStable();
        if (revision === this.stateRevision) return result;
      } catch (error) {
        await this.whenStable();
        if (revision === this.stateRevision) throw error;
      }
    }
  }

  async close(prepare?: WriterPreparation) {
    if (this.closed) return;
    this.closed = true;
    this.setState('closed');
    try {
      await prepare?.();
    } finally {
      await this.releaseLease();
      try { this.channel?.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Hook used by the database layer when another tab requests a schema upgrade.
   * Writability is revoked synchronously; recovery and lease release are one
   * coordinator-owned transition.
   */
  notifyVersionChange(): Promise<void> {
    return this.startDemotion('recovering', this.onVersionChange);
  }
}
