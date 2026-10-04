import {
  IdbPersistence,
  type Persistence,
  type StorageUnavailableError,
} from './db';
import { initializePersistence } from './persistence-startup';
import { SingleWriterCoordinator, type SingleWriterOptions, type WriterState } from './single-writer';
import { Store } from './store';

type CoordinatorOptions = Omit<SingleWriterOptions, 'onStateChange' | 'onPeerCommit' | 'onVersionChange'>;

export interface SessionPersistence extends Persistence {
  setWriteAccess(value: boolean): Promise<void>;
  reopen(writeAccess?: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface AppSessionOptions {
  databaseName?: string;
  coordinator?: CoordinatorOptions;
  /** Test seam for lifecycle ordering; production uses IdbPersistence. */
  persistenceFactory?: (writeAccess: boolean, onVersionChange: () => void) => SessionPersistence;
}

/**
 * Owns the browser-session boundary around coordinator, persistence and Store.
 *
 * SingleWriterCoordinator remains the authority for write ownership; this
 * class only sequences persistence refresh/recovery/cleanup around that state.
 * UI code observes state and supplies writer-only duties, but does not reopen
 * IndexedDB or manipulate the coordinator directly.
 */
export class AppSession {
  private readonly tabs: SingleWriterCoordinator;
  private idb?: SessionPersistence;
  private currentStore?: Store;
  private readonly stateListeners = new Set<(state: WriterState) => void>();
  private writerActivation?: () => void;
  private readerRefresh: Promise<void> = Promise.resolve();
  private pageSuspension?: Promise<void>;
  private resumeTask?: Promise<boolean>;
  private closing = false;
  private closeTask?: Promise<void>;

  private constructor(private readonly options: AppSessionOptions) {
    this.tabs = new SingleWriterCoordinator({
      ...options.coordinator,
      onStateChange: (state) => this.projectState(state),
      onPeerCommit: () => { void this.refreshReader(); },
      onVersionChange: () => this.recoverFromVersionChange(),
    });
  }

  static async start(options: AppSessionOptions = {}): Promise<{ session: AppSession; fallback?: StorageUnavailableError }> {
    const session = new AppSession(options);
    try {
      const fallback = await session.initialize();
      return { session, ...(fallback ? { fallback } : {}) };
    } catch (error) {
      await session.tabs.close().catch(() => {});
      throw error;
    }
  }

  get store(): Store {
    if (!this.currentStore) throw new Error('AppSession has not finished starting');
    return this.currentStore;
  }

  get state(): WriterState {
    return this.tabs.state;
  }

  get revision(): number {
    return this.tabs.revision;
  }

  get supportsWriterLock(): boolean {
    return this.tabs.supportsWriterLock;
  }

  private async initialize(): Promise<StorageUnavailableError | undefined> {
    await this.tabs.acquire();

    const notifyVersionChange = () => { void this.tabs.notifyVersionChange(); };
    const idb = this.options.persistenceFactory
      ? this.options.persistenceFactory(this.tabs.isWritable, notifyVersionChange)
      : new IdbPersistence(this.options.databaseName, this.tabs.isWritable, { onVersionChange: notifyVersionChange });
    this.idb = idb;

    const initialized = await initializePersistence(idb, () => this.tabs.runAgainstStableState(async (writable) => {
      await idb.setWriteAccess(writable);
      return idb.load();
    }));

    if (initialized.persistence !== idb) this.idb = undefined;

    const store = new Store(initialized.data, initialized.persistence, () => this.tabs.revision);
    this.currentStore = store;
    store.onCommitted = () => {
      if (this.idb) this.tabs.announceCommit();
    };
    this.projectState(this.tabs.state);
    return initialized.fallback;
  }

  private report(error: unknown) {
    try { this.currentStore?.onError(error); } catch { /* reporting must not break lifecycle cleanup */ }
  }

  private projectState(state: WriterState) {
    this.currentStore?.setReadOnly(state !== 'writer');

    for (const listener of this.stateListeners) {
      try { listener(state); } catch (error) { this.report(error); }
    }

    if (state === 'writer') this.activateWriterDuties();
  }

  private activateWriterDuties() {
    if (!this.writerActivation || this.currentStore?.isReadOnly) return;
    try { this.writerActivation(); } catch (error) { this.report(error); }
  }

  subscribeState(listener: (state: WriterState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.tabs.state);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Register the application work that should restart whenever this lifecycle
   * becomes writer. Registration immediately runs it for an already-active
   * writer, so startup and later takeover share exactly one path.
   */
  setWriterActivation(handler: () => void) {
    this.writerActivation = handler;
    this.activateWriterDuties();
  }

  /**
   * Queue one authoritative reader refresh. runIfCurrent prevents a read that
   * started in an older reader generation from overwriting a newer lifecycle.
   */
  async refreshReader(): Promise<void> {
    if (this.closing) return;
    const task = this.readerRefresh
      .catch(() => {})
      .then(async () => {
        const store = this.currentStore;
        const current = this.idb;
        if (this.closing || !store || !current || this.tabs.state !== 'reader') return;
        await this.tabs.runIfCurrent(() => current.load(), (fresh) => store.reload(fresh));
      })
      .catch((error) => this.report(error));
    this.readerRefresh = task;
    await task;
  }

  /**
   * Test/diagnostic barrier for session-owned async work. It is deliberately a
   * lifecycle barrier rather than a timer so callers do not encode races.
   */
  async whenIdle(): Promise<void> {
    while (true) {
      await this.tabs.whenStable();
      const refresh = this.readerRefresh;
      await refresh;
      await this.tabs.whenStable();
      if (refresh === this.readerRefresh) return;
    }
  }

  async requestTakeover(): Promise<boolean> {
    if (this.closing || !this.tabs.supportsWriterLock) return false;

    try {
      await this.tabs.whenStable();
      if (this.closing) return false;

      const acquired = await this.tabs.takeOver(this.idb
        ? async () => {
          // Finish or invalidate any reader refresh before reopening writable.
          await this.readerRefresh.catch(() => {});
          if (this.closing || this.tabs.state !== 'preparing') return;

          const current = this.idb;
          if (!current) return;
          await current.setWriteAccess(true);
          if (this.closing || this.tabs.state !== 'preparing') return;

          const fresh = await current.load();
          if (this.closing || this.tabs.state !== 'preparing') return;
          this.store.reload(fresh);
        }
        : undefined);
      return acquired;
    } catch (error) {
      await this.tabs.release().catch(() => {});
      const current = this.idb;
      // A failed takeover may restore reader persistence only while the
      // session is still live. The check and reopen enqueue are deliberately
      // adjacent: once final close marks closing, no later recovery may reopen.
      if (current && !this.closing) {
        try { await current.reopen(false); } catch (reopenError) { this.report(reopenError); }
      }
      throw error;
    }
  }

  private async drainAndClosePersistence() {
    const store = this.currentStore;
    if (store) {
      try { await store.flush(); } catch (error) { this.report(error); }
    }
    const current = this.idb;
    if (current) {
      try { await current.close(); } catch (error) { this.report(error); }
    }
  }

  /**
   * Navigation/freeze suspension synchronously revokes new actions, drains all
   * already accepted writes while the lease is still held, then drops every
   * resource that can keep a page out of BFCache. The notification channel is
   * closed only after the final commit has had a chance to broadcast.
   */
  suspendForCache(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.pageSuspension) return this.pageSuspension;

    const task = (async () => {
      await this.tabs.relinquish(() => this.drainAndClosePersistence());
      this.tabs.suspendNotifications();
    })();
    this.pageSuspension = task;
    task.catch(() => {});
    return task;
  }

  /**
   * Restore notification/persistence resources, reconcile durable state, then
   * reacquire the writer lease. Concurrent pageshow/resume/visibility events
   * share one task so they cannot reopen persistence twice.
   */
  resumeFromCache(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.resumeTask) return this.resumeTask;

    const task = (async () => {
      const suspension = this.pageSuspension;
      if (suspension) await suspension.catch(() => {});
      if (this.closing) return false;

      this.pageSuspension = undefined;
      this.tabs.resumeNotifications();

      const current = this.idb;
      if (current) await current.reopen(false);
      if (this.closing) return false;

      if (this.tabs.state === 'reader') await this.refreshReader();
      if (this.closing) return false;
      if (this.tabs.state !== 'reader') return this.tabs.state === 'writer';
      return this.requestTakeover();
    })();

    this.resumeTask = task;
    void task.then(
      () => { if (this.resumeTask === task) this.resumeTask = undefined; },
      () => { if (this.resumeTask === task) this.resumeTask = undefined; },
    );
    return task;
  }

  private async recoverFromVersionChange() {
    const current = this.idb;
    const store = this.currentStore;
    try {
      if (store) {
        try { await store.flush(); } catch (error) { this.report(error); }
      }
      if (!current) return;

      await current.close();
      await current.reopen(false);
      if (store) {
        await this.tabs.runIfCurrent(() => current.load(), (fresh) => store.reload(fresh));
      }
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;

    // Terminal state is published before coordinator.close() can yield, so
    // takeover failure recovery cannot enqueue a persistence reopen behind the
    // final close.
    this.closing = true;
    const task = this.tabs.close(async () => {
      const store = this.currentStore;
      if (store) {
        try { await store.flush(); } catch (error) { this.report(error); }
      }
      await this.idb?.close();
    });
    this.closeTask = task;
    task.catch(() => {});
    return task;
  }

  /**
   * Bind browser lifecycle once. The returned function only removes listeners;
   * final resource release is performed by close()/pagehide.
   */
  bindBrowserLifecycle(win: Window = window, doc: Document = document): () => void {
    const supportsPageSwap = 'onpageswap' in win;
    const suspend = () => {
      void this.suspendForCache().catch((error) => this.report(error));
    };
    const resume = () => {
      void this.resumeFromCache().catch((error) => this.report(error));
    };

    // pageswap runs early enough in modern Chrome/Safari to release Web Locks
    // and close IndexedDB before BFCache eligibility is finalized.
    const onPageSwap = () => suspend();
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        suspend();
        return;
      }
      void this.close().catch((error) => this.report(error));
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted && !this.pageSuspension) return;
      resume();
    };
    const onVisibilityChange = () => {
      if (doc.visibilityState === 'hidden') {
        // Browsers without pageswap use visibilitychange as the last reliable
        // pre-pagehide signal. This may also demote a background tab, which is
        // safe; a later visible transition resumes that same session.
        if (!supportsPageSwap) suspend();
        return;
      }
      if (this.pageSuspension || this.resumeTask) {
        resume();
        return;
      }
      if (this.tabs.state === 'reader') void this.refreshReader();
    };

    if (supportsPageSwap) win.addEventListener('pageswap', onPageSwap);
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
    doc.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (supportsPageSwap) win.removeEventListener('pageswap', onPageSwap);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }
}
