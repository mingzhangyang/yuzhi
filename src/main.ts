import './styles.css';
import { IdbPersistence, exportBackup, parseBackup, type Persistence } from './db';
import { initializePersistence } from './persistence-startup';
import { Store } from './store';
import type { Data } from './types';
import { IslandRenderer, type Selection } from './island/render';
import { $, download, esc, pickFile, setHTML, setText, toast } from './ui/dom';
import { closeModal, confirmModal, initModal, isModalOpen } from './ui/modal';
import { buildStats, updateStats } from './ui/stats';
import { Tracker, abandonPrompt, type View } from './ui/tracker';
import { SettleSheet } from './ui/settle';
import { buildScene, lightNow, ROOFS } from './ui/scene';
import { Ceremony } from './ui/ceremony';
import { openCalendar, openClassify, openNew, openSettings, openWelcome, seedDemo } from './ui/forms';
import * as A from './actions';
import { autoRefresh } from './calendar';
import { pendingDays } from './logic/days';
import { SEASONS, fmtDay, relDay, seasonOf, weekday } from './lib/date';
import { unclassifiedGroups } from './logic/classify';
import { SingleWriterCoordinator, type WriterState } from './single-writer';
import { syncThemeDataset } from './ui/theme';

async function boot() {
  initModal();
  let appStore: Store | undefined;
  let idb: IdbPersistence | undefined;
  let settle!: SettleSheet;
  let ceremony!: Ceremony;
  let readerRefresh: Promise<void> = Promise.resolve();
  let syncWriterState = (_state: WriterState) => {};
  const reloadAppSnapshot = (fresh: Data) => {
    if (!appStore) return;
    appStore.reload(fresh);
  };
  const tabs = new SingleWriterCoordinator({
    onStateChange: (state) => syncWriterState(state),
    onPeerCommit: () => {
      readerRefresh = readerRefresh
        .catch(() => {})
        .then(async () => {
          if (!appStore || !idb || tabs.state !== 'reader') return;
          const current = idb;
          // A return to reader after recovery is a new lifecycle, not permission
          // for a pre-recovery snapshot to replace the authoritative fresh one.
          await tabs.runIfCurrent(() => current.load(), reloadAppSnapshot);
        })
        .catch((error) => appStore?.onError(error));
    },
    onVersionChange: async () => {
      // The coordinator has already synchronously revoked writability here.
      // Keep the lease while persistence drains and reconnects as a reader;
      // SingleWriterCoordinator releases it only after this callback settles.
      const current = idb;
      try {
        if (appStore) {
          try { await appStore.flush(); } catch (error) { appStore.onError(error); }
        }
        if (current) {
          await current.close();
          await current.reopen(false);
          if (appStore) reloadAppSnapshot(await current.load());
        }
      } catch (error) {
        appStore?.onError(error);
        throw error;
      }
    },
  });
  await tabs.acquire();
  idb = new IdbPersistence(undefined, tabs.isWritable, { onVersionChange: () => { void tabs.notifyVersionChange(); } });
  let per: Persistence = idb;
  let data: Data;
  try {
    // Startup only accepts a snapshot produced under one stable coordinator
    // revision. If versionchange recovery races the load, the stale result is
    // discarded and retried against the new reader/writer state.
    const initialized = await initializePersistence(idb, () => tabs.runAgainstStableState(async (writable) => {
      await idb!.setWriteAccess(writable);
      return idb!.load();
    }));
    per = initialized.persistence;
    data = initialized.data;
    if (initialized.fallback) {
      idb = undefined;
      setTimeout(() => toast('这个浏览器不允许本地存储，这次的记录不会被保存', true), 500);
    }
  } catch (error) {
    console.error('无法打开屿志本地数据', error);
    const message = error instanceof Error ? error.message : String(error);
    const wrap = document.querySelector<HTMLElement>('.wrap');
    if (wrap) {
      setHTML(
        wrap,
        `<section class="card panel" role="alert" style="max-width:760px;margin:48px auto">
          <h2>无法打开已有数据</h2>
          <p>${esc(message)}</p>
          <p>为了保护原有记录，屿志没有切换到空白临时数据，也没有覆盖本地数据。请先刷新页面；如果提示数据来自更新版本，请先更新屿志。不要清除浏览器站点数据。</p>
        </section>`,
      );
    }
    await tabs.close();
    return;
  }
  const store = new Store(data, per, () => tabs.revision);
  appStore = store;

  const syncReadOnlyUi = (readOnly: boolean) => {
    for (const id of ['newBtn', 'settleBtn', 'fogGo', 'calBtn']) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = readOnly;
    }
    document.querySelectorAll<HTMLButtonElement>('#menu [data-m="settings"], #menu [data-m="import"], #menu [data-m="demo"]')
      .forEach((button) => { button.disabled = readOnly; });
    document.body.dataset.readOnly = readOnly ? 'true' : 'false';
  };

  const readOnlyNavActions = new Set(['archive', 'back', 'dock', 'project', 'task']);
  const guardReadOnlyMutation = (event: Event) => {
    if (!store.isReadOnly || !(event.target instanceof Element)) return;
    const target = event.target;
    let mutating = false;
    if (event.type === 'submit') {
      mutating = Boolean(target.closest('#tracker form, #mdl form'));
    } else if (event.type === 'change') {
      mutating = Boolean(target.closest('#tracker [data-act-change], #settle [data-pull]'));
    } else if (event.type === 'pointerdown') {
      // Pointerdown is only stateful for the settlement swipe gesture. Buttons
      // are handled on click so one user action produces one read-only notice.
      mutating = Boolean(target.closest('#settle .scard'));
    } else {
      const trackerAction = target.closest<HTMLElement>('#tracker [data-act]');
      mutating = Boolean(
        (trackerAction && !readOnlyNavActions.has(trackerAction.dataset.act ?? ''))
        || target.closest('#mdl [data-ok], #mdl [data-p], #mdl [data-c], #mdl [data-sync], #mdl [data-rm], #mdl [data-rule], #mdl [data-classify], #mdl [data-file], #mdl [data-d], #mdl [data-w]')
        || target.closest('#settle [data-set], #settle [data-reason], #settle [data-act="all"], #settle [data-act="commit"]')
        || target.closest('#ceremony [data-go]')
      );
    }
    if (!mutating) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('此页当前只读。请先接管写权限，再修改小岛。', true);
  };
  for (const type of ['click', 'submit', 'change', 'pointerdown']) {
    document.addEventListener(type, guardReadOnlyMutation, true);
  }

  store.onError = (e) => toast('保存失败：' + (e instanceof Error ? e.message : String(e)), true);
  store.onCommitted = () => {
    if (idb) tabs.announceCommit();
  };

  const tabNotice = document.querySelector<HTMLElement>('#tabNotice');
  const takeOver = document.querySelector<HTMLButtonElement>('#tabTakeover');
  if (!tabs.supportsWriterLock && tabNotice) {
    const text = tabNotice.querySelector('span');
    if (text) text.textContent = '此浏览器不支持安全的多标签页写入协调；为保护本地数据，此页保持只读。';
  }

  // Store/UI writability is a projection of coordinator state. No caller keeps
  // a second writable flag or replays an old acquisition result.
  syncWriterState = (state) => {
    const readOnly = state !== 'writer';
    store.setReadOnly(readOnly);
    syncReadOnlyUi(readOnly);
    if (readOnly) {
      closeModal(false);
      settle?.close();
      ceremony?.close();
    }
    if (tabNotice) {
      tabNotice.hidden = state === 'writer';
      if (state === 'recovering' || state === 'releasing' || state === 'closed') tabNotice.dataset.blocked = 'true';
      else delete tabNotice.dataset.blocked;
    }
    if (takeOver) takeOver.disabled = !tabs.supportsWriterLock || state !== 'reader';
  };
  syncWriterState(tabs.state);

  let calendarRefreshTask: Promise<void> | undefined;
  let calendarRefreshAgain = false;
  function runWriterAutoRefresh() {
    if (store.isReadOnly) return;
    if (calendarRefreshTask) {
      calendarRefreshAgain = true;
      return;
    }
    calendarRefreshTask = autoRefresh(store)
      .then((n) => {
        if (!n || store.isReadOnly) return;
        if (!isModalOpen() && !settle.isOpen()) afterImport();
        else daily();
      })
      .finally(() => {
        calendarRefreshTask = undefined;
        const rerun = calendarRefreshAgain && !store.isReadOnly;
        calendarRefreshAgain = false;
        if (rerun) runWriterAutoRefresh();
      });
  }

  const requestTakeover = async (notify = true): Promise<boolean> => {
    if (!tabs.supportsWriterLock) {
      if (notify) toast('当前浏览器不支持安全的写权限协调，此页保持只读', true);
      return false;
    }
    try {
      await tabs.whenStable();
      const acquired = await tabs.takeOver(idb
        ? async () => {
          // Coordinator is preparing here, so Store/UI stay read-only until
          // the fresh write-capable snapshot succeeds.
          await readerRefresh.catch(() => {});
          await idb!.setWriteAccess(true);
          const fresh = await idb!.load();
          reloadAppSnapshot(fresh);
        }
        : undefined);
      if (!acquired) {
        if (notify) toast('另一个标签页仍在写入，请稍后再试', true);
        return false;
      }
      resumeWriterDuties();
      if (notify) toast('已接管写权限');
      return true;
    } catch (error) {
      await tabs.release().catch(() => {});
      if (idb) {
        try { await idb.reopen(false); } catch { /* coordinator remains non-writable */ }
      }
      console.error('接管写权限失败', error);
      if (notify) toast('接管写权限失败：' + (error instanceof Error ? error.message : String(error)), true);
      return false;
    }
  };

  if (takeOver && tabs.supportsWriterLock) takeOver.onclick = () => { void requestTakeover(); };

  const applyTheme = () => {
    syncThemeDataset(store.data.settings.theme, document.documentElement.dataset);
    setTimeout(() => {
      renderer.readTheme();
      update();
    }, 30);
  };

  buildStats();
  $('legend').innerHTML =
    `<span><i style="background:${ROOFS[0]}"></i>村落 = 项目</span><span>小人 = 没做完的任务</span><span><i style="background:#a8794a"></i>船 = 码头上待安排的任务</span><span><i style="background:#e2ad2f"></i>粮仓 = 今天的可用时间</span><span><i style="background:#d8dcdc"></i>海雾 = 没结算的日子</span>`;

  const renderer = new IslandRenderer($('map') as HTMLCanvasElement, $('mapwrap'));
  let dusk = false;
  const tracker = new Tracker(store, {
    openNewProject: () => openNew(store, 'project', (id) => tracker.open({ kind: 'project', id })),
    openClassify: () => openClassify(store),
    openPrompt: (p) => abandonPrompt(store, p, () => setTimeout(maybePrompt, 300)),
    openSettings: () => openSettings(store, applyTheme),
    openCeremony: (p) => ceremony.open(p),
    onViewChange: () => update(),
  });
  tracker.bindChange();

  ceremony = new Ceremony(store, {
    pause: (on) => (renderer.paused = on),
    done: (p, where) => {
      tracker.open(where === 'landmark' ? { kind: 'project', id: p.id } : { kind: 'archive' });
      setTimeout(() => renderer.pulse(p.id), 400);
    },
  });

  settle = new SettleSheet(store, {
    brick: (pid, from) => flyBrick(pid, from),
    onOpenChange: (o) => {
      dusk = o;
      update();
      if (!o) setTimeout(maybePrompt, 600);
    },
  });

  function flyBrick(pid: string, from: DOMRect) {
    const to = renderer.villageClientPos(pid);
    const b = document.createElement('div');
    b.className = 'brick';
    const x0 = from.left + from.width - 40;
    const y0 = from.top + from.height / 2;
    b.style.left = `${x0}px`;
    b.style.top = `${y0}px`;
    document.body.appendChild(b);
    const tx = to ? to.x - x0 : 120;
    const ty = to ? to.y - y0 : -300;
    requestAnimationFrame(() => {
      b.style.transform = `translate(${tx}px, ${ty}px) rotate(200deg) scale(.7)`;
      b.style.opacity = '0.2';
    });
    setTimeout(() => {
      b.remove();
      renderer.pulse(pid);
    }, 780);
  }

  const selectionOf = (v: View): Selection | null => {
    switch (v.kind) {
      case 'project':
        return { kind: 'project', id: v.id };
      case 'task':
        return { kind: 'task', id: v.id };
      case 'dock':
      case 'granary':
      case 'chores':
      case 'archive':
        return { kind: v.kind };
      default:
        return null;
    }
  };

  renderer.onTap = (hit) => {
    $('tip').style.opacity = '0';
    if (!hit) return;
    if (hit.kind === 'project' || hit.kind === 'task') tracker.open({ kind: hit.kind, id: hit.id });
    else tracker.open({ kind: hit.kind });
  };
  $('zin').onclick = () => renderer.zoomBy(1.35);
  $('zout').onclick = () => renderer.zoomBy(1 / 1.35);
  $('zfit').onclick = () => renderer.resetView();

  /* ---------------- 每次数据变化 ---------------- */
  let lastToday = store.today();
  function update() {
    if (syncThemeDataset(store.data.settings.theme, document.documentElement.dataset)) {
      // Store notifications include persistence rollback and peer reloads.
      // Theme is therefore derived from the authoritative Store snapshot, not
      // only from the UI action that originally requested a theme change.
      setTimeout(() => {
        renderer.readTheme();
        update();
      }, 30);
    }
    const today = store.today();
    const now = store.clock();
    updateStats(store);
    tracker.render();
    renderer.setScene(buildScene(store, selectionOf(tracker.view), dusk));

    const pend = pendingDays(store.data, today);
    const light = lightNow(now, dusk);
    setText($('date'), `${fmtDay(today)} ${weekday(today)} · ${SEASONS[seasonOf(today)]}`);
    const sb = $('settleBtn');
    setHTML(sb, `${light === 'day' ? '结算' : '晚间结算'}${pend.length ? `<span class="dot">${pend.length}</span>` : ''}`);
    const wb = $('weather');
    const lt = { day: '白天', dusk: '黄昏', night: '夜里' }[light];
    setText(wb, `${SEASONS[seasonOf(today)]}季 · ${lt}${pend.length ? ` · 海雾 ${pend.length} 天` : ''}`);
    wb.classList.toggle('dusk', light !== 'day' || pend.length > 0);
    $('fogbar').hidden = !pend.length;
    if (pend.length) setHTML($('fogTxt'), `<b>海雾笼罩着小岛</b><span>${pend.map((d) => esc(relDay(d, today))).join('、')}还没结算。补上记录，雾就散了；超过 3 天会自动归档为「未记录」。</span>`);
    const ps = store.activeProjects().length;
    setText($('mapDesc'), ps ? `${ps} 座村落。点村落看项目，点小人看任务，点码头安排新任务。` : '项目是村落，任务是住在里面的人。先建一座村落吧。');

    // 编年史
    const lines = store.data.chronicle.map((c, i) => [c, i] as const).sort((a, b) => b[0].date.localeCompare(a[0].date) || b[1] - a[1]);
    setHTML($('chron'), lines.length ? lines.slice(0, 80).map(([c]) => `<li class="k-${c.kind}"><time>${esc(relDay(c.date, today))}</time><span>${esc(c.text)}</span></li>`).join('') : '<li class="empty">每天结算后，这里会自动多一行。</li>');
    setText($('chronCount'), `共 ${store.data.chronicle.length} 条`);
  }

  /** 进入「搬离」阶段的村落：询问重新启动 / 缩小规模 / 正式关闭 */
  const asked = new Set<string>();
  function maybePrompt() {
    if (store.isReadOnly || isModalOpen() || settle.isOpen() || ceremony.isOpen()) return;
    const p = A.projectsNeedingPrompt(store).find((x) => !asked.has(x.id));
    if (!p) return;
    asked.add(p.id);
    abandonPrompt(store, p, () => setTimeout(maybePrompt, 300));
  }

  /** 新的一天：归档超过 3 天的未结算日子，记下阶段变化 */
  function daily() {
    if (store.isReadOnly) return;
    // Replay missed time-passage boundaries before archive lines advance the
    // chronicle boundary used for legacy compatibility.
    const archived = store.batch(() => {
      A.refreshStages(store);
      return A.archiveOldDays(store);
    });
    if (archived.length) toast(`${archived.map(fmtDay).join('、')}没有记录，已归档。不算做了，也不算没做。`);
  }

  function resumeWriterDuties() {
    if (store.isReadOnly) return;
    daily();
    lastToday = store.today();
    asked.clear();
    setTimeout(maybePrompt, 0);
    runWriterAutoRefresh();
  }

  store.subscribe(update);
  daily();
  update();
  renderer.start();

  setInterval(() => {
    const t = store.today();
    if (t !== lastToday && !store.isReadOnly) {
      daily();
      lastToday = t;
    }
    update();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (store.today() !== lastToday && !store.isReadOnly) {
        daily();
        lastToday = store.today();
      }
      update();
    }
  });
  let pageSuspension: Promise<void> | undefined;
  const suspendForCache = () => tabs.relinquish(async () => {
    // Enter releasing state synchronously, then drain/demote persistence while
    // the lease is still held. Store/UI writability follows coordinator state.
    try { await store.flush(); } catch (error) { store.onError(error); }
    if (idb) {
      try { await idb.setWriteAccess(false); } catch (error) { store.onError(error); }
    }
  });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) {
      pageSuspension = suspendForCache();
      return;
    }
    void tabs.close(async () => {
      try { await store.flush(); } catch (error) { store.onError(error); }
      await idb?.close();
    });
  });
  window.addEventListener('pageshow', () => {
    if (!store.isReadOnly) return;
    void (async () => {
      if (pageSuspension) await pageSuspension.catch(() => {});
      pageSuspension = undefined;
      await requestTakeover(false);
    })();
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(() => renderer.readTheme(), 50));

  /* ---------------- 顶部按钮 ---------------- */
  $('settleBtn').onclick = () => settle.open();
  $('fogGo').onclick = () => settle.open();
  $('newBtn').onclick = () => openNew(store, 'task');
  function afterImport() {
    // 导入可能带来早于归档期限的事件日子，马上归档，不要等到明天
    daily();
    const context = store.captureWriteContext();
    if (unclassifiedGroups(store.data.events).length) setTimeout(() => {
      if (context.isCurrent()) openClassify(store);
    }, 400);
  }
  $('calBtn').onclick = () => openCalendar(store, afterImport);
  const menu = $('menu');
  $('moreBtn').onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const r = $('moreBtn').getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = `${r.bottom + window.scrollY + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  };
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
  });
  menu.addEventListener('click', async (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m;
    if (!m) return;
    menu.hidden = true;
    if (m === 'settings') openSettings(store, applyTheme);
    else if (m === 'export') {
      download(`yuzhi-backup-${store.today()}.json`, exportBackup(store.data));
      toast('备份已导出');
    } else if (m === 'import') {
      const context = store.captureWriteContext();
      const revision = tabs.revision;
      const f = await pickFile($('fileBackup') as HTMLInputElement);
      if (!f || !context.isCurrent()) return;
      try {
        const d = parseBackup(await f.text());
        if (!context.isCurrent()) return;
        const ok = await confirmModal({ title: '用备份替换现在的小岛？', text: `备份里有 ${d.projects.length} 个项目、${d.tasks.length} 件任务、${d.entries.length} 条结算记录。现在这座岛上的数据会被替换。`, ok: '替换', danger: true });
        if (!ok || !context.isCurrent()) return;
        await store.replaceAll(d);
        if (tabs.revision !== revision || store.isReadOnly) return;
        tracker.open({ kind: 'overview' }, false);
        applyTheme();
        daily();
        toast('备份已导入');
      } catch (err) {
        if (tabs.revision !== revision || store.isReadOnly) return;
        toast(err instanceof Error ? err.message : String(err), true);
      }
    } else if (m === 'archive') tracker.open({ kind: 'archive' });
    else if (m === 'demo') seedDemo(store);
  });

  applyTheme();

  // 第一次打开
  if (!store.isReadOnly && !store.data.projects.length && !store.data.tasks.length && !store.data.sources.length) {
    openWelcome({
      project: () => openNew(store, 'project', (id) => tracker.open({ kind: 'project', id })),
      calendar: () => openCalendar(store, afterImport),
      demo: () => {
        seedDemo(store);
        setTimeout(maybePrompt, 1500);
      },
    });
  } else setTimeout(maybePrompt, 1200);

  // 后台日历 I/O 只属于当前 writer；reader 不发重复网络请求。
  runWriterAutoRefresh();

  // 方便调试
  (window as unknown as { yuzhi: unknown }).yuzhi = { store, actions: A };
}

boot();
