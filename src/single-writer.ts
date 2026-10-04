export type WriterRole = 'writer' | 'reader';
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
  onRoleChange?: (role: WriterRole) => void;
  onPeerCommit?: () => void;
  onVersionChange?: () => void;
}

const randomOwner = () => `tab|${Date.now().toString(36)}|${Math.random().toString(36).slice(2)}`;

/**
 * Coordinates one write-capable tab per browser profile.
 *
 * The Web Lock is the lease. A tab is not promoted to writer until its
 * preparation callback has completed, so callers can refresh the authoritative
 * snapshot while writes are still blocked. BroadcastChannel is notification
 * only and never participates in mutual exclusion.
 */
export class SingleWriterCoordinator {
  readonly ownerId: string;
  readonly lockName: string;
  readonly channelName: string;
  role: WriterRole = 'reader';

  private readonly locks?: { request: LockRequest };
  private readonly channel?: ReturnType<NonNullable<SingleWriterOptions['channelFactory']>>;
  private readonly onRoleChange?: (role: WriterRole) => void;
  private readonly onPeerCommit?: () => void;
  private readonly onVersionChange?: () => void;
  private releaseLock: (() => void) | undefined;
  private lockTask: Promise<unknown> | undefined;
  private acquireTask: Promise<boolean> | undefined;
  private releaseRequested = false;
  private closed = false;

  constructor(options: SingleWriterOptions = {}) {
    this.ownerId = options.ownerId ?? randomOwner();
    this.lockName = options.lockName ?? 'yuzhi-single-writer';
    this.channelName = options.channelName ?? 'yuzhi-single-writer';
    const nativeLocks = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: { request: LockRequest } }).locks
      : undefined;
    this.locks = options.locks === undefined ? nativeLocks : options.locks ?? undefined;
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

  private setRole(role: WriterRole) {
    if (this.role === role) return;
    this.role = role;
    this.onRoleChange?.(role);
  }

  private announce(message: ChannelMessage) {
    try { this.channel?.postMessage(message); } catch { /* a closing tab is already done */ }
  }

  private receive(message: ChannelMessage) {
    if (!message || message.ownerId === this.ownerId) return;
    if (message.type === 'commit' && this.role === 'reader') this.onPeerCommit?.();
  }

  /**
   * Acquire the single-writer lease. The optional preparation runs while the
   * Web Lock is already held but this coordinator is still a reader. Only
   * after it succeeds do we publish writer state and resolve true.
   */
  async acquire(prepare?: WriterPreparation): Promise<boolean> {
    if (this.closed) return false;
    if (this.releaseRequested) return false;
    if (this.role === 'writer') return true;
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
        try {
          await prepare?.();
          if (this.closed || this.releaseRequested) {
            succeed(false);
            return;
          }

          this.releaseLock = resolveHeld;
          activated = true;
          this.setRole('writer');
          this.announce({ type: 'writer-state', ownerId: this.ownerId, active: true });
          succeed(true);
          await held;
        } catch (error) {
          fail(error);
        } finally {
          this.releaseLock = undefined;
          if (activated && this.role === 'writer') {
            this.setRole('reader');
            if (!this.closed) this.announce({ type: 'writer-state', ownerId: this.ownerId, active: false });
          }
        }
      }).catch(fail);
    });
  }

  async takeOver(prepare?: WriterPreparation): Promise<boolean> {
    return this.acquire(prepare);
  }

  announceCommit(revision = Date.now()) {
    if (this.role !== 'writer') return;
    this.announce({ type: 'commit', ownerId: this.ownerId, revision });
  }

  /** Release the lease while keeping the channel alive for a later takeover. */
  async release() {
    this.releaseRequested = true;
    const release = this.releaseLock;
    if (release) release();
    await this.lockTask?.catch(() => {});
    this.releaseLock = undefined;
    this.lockTask = undefined;
    this.releaseRequested = false;
  }

  async close() {
    this.closed = true;
    await this.release();
    try { this.channel?.close(); } catch { /* already closed */ }
  }

  /** Hook used by the database layer when another tab requests a schema upgrade. */
  notifyVersionChange() {
    this.onVersionChange?.();
  }
}
