import { IdbPersistence, type StorageUnavailableError } from './db';
import { initializePersistence } from './persistence-startup';
import { SingleWriterCoordinator, type SingleWriterOptions, type WriterState } from './single-writer';
import { Store } from './store';

type CoordinatorOptions = Omit<SingleWriterOptions, 'onStateChange' | 'onPeerCommit' | 'onVersionChange'>;

export interface AppSessionOptions {
  databaseName?: string;
  coordinator?: CoordinatorOptions;
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
  private idb?: IdbPersistence;
  private currentStore?: Store;
  private readonly stateListeners = new Set<(state: WriterState) => void>();
  private writerActivation?: () => void;
  private readerRefresh: Promise<void> = Promise.resolve();
  private pageSuspension?: Promise<void>;

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

    const idb = new IdbPersistence(this.options.databaseName, this.tabs.isWritable, {
      onVersionChange: () => { void this.tabs.notifyVersionChange(); },
    });
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
    const task = this.readerRefresh
      .catch(() => {})
      .then(async () => {
        const store = this.currentStore;
        const current = this.idb;
        if (!store || !current || this.tabs.state !== 'reader') return;
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
    if (!this.tabs.supportsWriterLock) return false;

    try {
      await this.tabs.whenStable();
      const acquired = await this.tabs.takeOver(this.idb
        ? async () => {
          // Finish or invalidate any reader refresh before reopening writable.
          await this.readerRefresh.catch(() => {});
          const current = this.idb;
          if (!current) return;
          await current.setWriteAccess(true);
          const fresh = await current.load();
          this.store.reload(fresh);
        }
        : undefined);
      return acquired;
    } catch (error) {
      await this.tabs.release().catch(() => {});
      const current = this.idb;
      if (current) {
        try { await current.reopen(false); } catch (reopenError) { this.report(reopenError); }
      }
      throw error;
    }
  }

  private async drainAndDemotePersistence() {
    const store = this.currentStore;
    if (store) {
      try { await store.flush(); } catch (error) { this.report(error); }
    }
    const current = this.idb;
    if (current) {
      try { await current.setWriteAccess(false); } catch (error) { this.report(error); }
    }
  }

  /**
   * bfcache suspension synchronously revokes new actions through coordinator
   * state, then drains accepted writes before the lease is released.
   */
  suspendForCache(): Promise<void> {
    if (this.pageSuspension) return this.pageSuspension;
    const task = this.tabs.relinquish(() => this.drainAndDemotePersistence());
    this.pageSuspension = task;
    task.catch(() => {});
    return task;
  }

  /**
   * A restored/visible reader always rechecks durable state. This compensates
   * for BroadcastChannel notifications that may have been missed while the page
   * was frozen; takeover then performs its own write-capable refresh as well.
   */
  async resumeFromCache(): Promise<boolean> {
    const suspension = this.pageSuspension;
    if (suspension) await suspension.catch(() => {});
    this.pageSuspension = undefined;

    if (this.tabs.state === 'reader') await this.refreshReader();
    if (this.tabs.state !== 'reader') return this.tabs.state === 'writer';
    return this.requestTakeover();
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

  async close(): Promise<void> {
    await this.tabs.close(async () => {
      const store = this.currentStore;
      if (store) {
        try { await store.flush(); } catch (error) { this.report(error); }
      }
      await this.idb?.close();
    });
  }

  /**
   * Bind browser lifecycle once. The returned function only removes listeners;
   * final resource release is performed by close()/pagehide.
   */
  bindBrowserLifecycle(win: Window = window, doc: Document = document): () => void {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void this.suspendForCache();
        return;
      }
      void this.close().catch((error) => this.report(error));
    };
    const onPageShow = () => {
      if (!this.currentStore?.isReadOnly) return;
      void this.resumeFromCache().catch((error) => this.report(error));
    };
    const onVisibilityChange = () => {
      if (doc.visibilityState !== 'visible' || this.tabs.state !== 'reader') return;
      void this.refreshReader();
    };

    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
    doc.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }
}
