export type WriterRole = 'writer' | 'reader';

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
  locks?: { request: LockRequest };
  channelFactory?: (name: string) => { onmessage: ((event: MessageEvent<ChannelMessage>) => void) | null; postMessage(message: ChannelMessage): void; close(): void };
  onRoleChange?: (role: WriterRole) => void;
  onPeerCommit?: () => void;
  onVersionChange?: () => void;
}

const randomOwner = () => `tab|${Date.now().toString(36)}|${Math.random().toString(36).slice(2)}`;

/**
 * Coordinates one write-capable tab per browser profile. Web Locks supplies
 * the mutex; BroadcastChannel only announces state and committed revisions.
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
  private closed = false;

  constructor(options: SingleWriterOptions = {}) {
    this.ownerId = options.ownerId ?? randomOwner();
    this.lockName = options.lockName ?? 'yuzhi-single-writer';
    this.channelName = options.channelName ?? 'yuzhi-single-writer';
    this.locks = options.locks ?? (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: { request: LockRequest } }).locks : undefined);
    this.onRoleChange = options.onRoleChange;
    this.onPeerCommit = options.onPeerCommit;
    this.onVersionChange = options.onVersionChange;
    const makeChannel = options.channelFactory ?? ((name: string) => typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : undefined);
    this.channel = makeChannel?.(this.channelName) as typeof this.channel;
    if (this.channel) {
      this.channel.onmessage = (event) => this.receive(event.data);
    }
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

  /** Try to become the writer. Resolves false when another tab holds the lock. */
  async acquire(): Promise<boolean> {
    if (this.closed) return false;
    if (this.role === 'writer') return true;

    // A browser without Web Locks cannot safely coordinate multiple tabs. It
    // is still useful as a single-tab app, so keep the conservative fallback
    // explicit rather than pretending BroadcastChannel is a mutex.
    if (!this.locks) {
      this.setRole('writer');
      this.announce({ type: 'writer-state', ownerId: this.ownerId, active: true });
      return true;
    }

    let acquired = false;
    let resolveHeld!: () => void;
    const held = new Promise<void>((resolve) => { resolveHeld = resolve; });
    const acquiredSignal = new Promise<boolean>((resolve) => {
      this.lockTask = this.locks!.request(this.lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        acquired = true;
        this.releaseLock = resolveHeld;
        this.setRole('writer');
        this.announce({ type: 'writer-state', ownerId: this.ownerId, active: true });
        resolve(true);
        await held;
        this.releaseLock = undefined;
        if (!this.closed) {
          this.setRole('reader');
          this.announce({ type: 'writer-state', ownerId: this.ownerId, active: false });
        }
      }).catch(() => {
        resolve(false);
      });
    });
    const result = await acquiredSignal;
    if (!result && this.lockTask) await this.lockTask.catch(() => {});
    return acquired;
  }

  async takeOver(): Promise<boolean> {
    return this.acquire();
  }

  announceCommit(revision = Date.now()) {
    if (this.role !== 'writer') return;
    this.announce({ type: 'commit', ownerId: this.ownerId, revision });
  }

  /** Release the Web Lock but keep the channel alive for a possible takeover. */
  async release() {
    const release = this.releaseLock;
    if (release) release();
    await this.lockTask?.catch(() => {});
    this.releaseLock = undefined;
    this.lockTask = undefined;
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
