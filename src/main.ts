import './styles.css';
import { exportBackup, parseBackup } from './db';
import { AppSession } from './app-session';
import { IslandRenderer, type SceneryInspection, type Selection } from './island/render';
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
import { agendaAt } from './logic/agenda';
import { fmtDay, localDate, relDay, seasonOf, weekday } from './lib/date';
import { festivalsOf, weatherOf } from './island/ambience';
import { unclassifiedGroups } from './logic/classify';
import type { WriterState } from './single-writer';
import { syncThemeDataset } from './ui/theme';
import { markDriftSeen } from './ui/drift';
import { festivalName, getLocale, initI18n, lightName, onLocaleChange, seasonName, t, toggleLocale, weatherName } from './i18n';
import { formatChronicleLine } from './history';

async function boot() {
  initI18n();
  initModal();
  let settle!: SettleSheet;
  let ceremony!: Ceremony;
  let session: AppSession;
  try {
    const started = await AppSession.start();
    session = started.session;
    if (started.fallback) {
      setTimeout(() => toast(t('main.storageBlocked'), true), 500);
    }
  } catch (error) {
    console.error('无法打开屿志本地数据', error);
    const message = error instanceof Error ? error.message : String(error);
    const wrap = document.querySelector<HTMLElement>('.wrap');
    if (wrap) {
      setHTML(
        wrap,
        `<section class="card panel" role="alert" style="max-width:760px;margin:48px auto">
          <h2>${esc(t('main.openDataTitle'))}</h2>
          <p>${esc(message)}</p>
          <p>${esc(t('main.openDataBody'))}</p>
        </section>`,
      );
    }
    return;
  }
  const store = session.store;
  let renderer!: IslandRenderer;
  let releasePreparingCueBaseline: (() => void) | undefined;
  // Map inspections capture the permission state used to build their actions.
  // A session generation change invalidates that UI snapshot.
  let clearSessionSensitiveMapInfo: () => void = () => {};

  const syncReadOnlyUi = (readOnly: boolean) => {
    for (const id of ['newBtn', 'settleBtn', 'fogGo', 'calBtn']) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = readOnly;
    }
    document.querySelectorAll<HTMLButtonElement>('#menu [data-m="settings"], #menu [data-m="import"], #menu [data-m="demo"]')
      .forEach((button) => { button.disabled = readOnly; });
    document.body.dataset.readOnly = readOnly ? 'true' : 'false';
  };

  const readOnlyNavActions = new Set(['archive', 'back', 'dock', 'project', 'task', 'diaries', 'diary', 'schedules', 'schedule']);
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
      const modalAction = target.closest<HTMLElement>('#mdl [data-ok], #mdl [data-p], #mdl [data-c], #mdl [data-sync], #mdl [data-rm], #mdl [data-rule], #mdl [data-classify], #mdl [data-file], #mdl [data-d], #mdl [data-w]');
      mutating = Boolean(
        (trackerAction && !readOnlyNavActions.has(trackerAction.dataset.act ?? ''))
        || (modalAction && !modalAction.hasAttribute('data-readonly-safe'))
        || target.closest('#settle [data-set], #settle [data-reason], #settle [data-act="all"], #settle [data-act="commit"]')
        || target.closest('#ceremony [data-go]')
      );
    }
    if (!mutating) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toast(t('forms.readOnly'), true);
  };
  for (const type of ['click', 'submit', 'change', 'pointerdown']) {
    document.addEventListener(type, guardReadOnlyMutation, true);
  }

  store.onError = (e) => toast(t('main.saveFailed', { error: e instanceof Error ? e.message : String(e) }), true);

  const tabNotice = document.querySelector<HTMLElement>('#tabNotice');
  const takeOver = document.querySelector<HTMLButtonElement>('#tabTakeover');
  const tabNoticeText = tabNotice?.querySelector<HTMLElement>('span') ?? null;
  if (tabNoticeText) {
    const key = session.supportsWriterLock ? 'shell.readOnly' : 'shell.readOnlyUnsupported';
    tabNoticeText.dataset.i18n = key;
    setText(tabNoticeText, t(key));
  }

  // Store/UI writability is a projection of coordinator state. No caller keeps
  // a second writable flag or replays an old acquisition result.
  const syncWriterState = (state: WriterState) => {
    // A successful takeover enters preparing before its durable reload. Start
    // the silent baseline there, so missed broadcasts cannot replay old cues.
    // Initial startup has no renderer yet; visibility restoration owns its
    // separate (nestable) suppression scope.
    if (state === 'preparing' && renderer && !releasePreparingCueBaseline) {
      releasePreparingCueBaseline = renderer.beginCueSuppression();
    }

    const readOnly = state !== 'writer';
    store.setReadOnly(readOnly);
    syncReadOnlyUi(readOnly);
    clearSessionSensitiveMapInfo();
    if (readOnly) {
      closeModal(false);
      settle?.discard();
      ceremony?.close();
    }
    if (tabNotice) {
      tabNotice.hidden = state === 'writer';
      if (state === 'recovering' || state === 'releasing' || state === 'closed') tabNotice.dataset.blocked = 'true';
      else delete tabNotice.dataset.blocked;
    }
    if (takeOver) takeOver.disabled = !session.supportsWriterLock || state !== 'reader';

    if (!releasePreparingCueBaseline || !renderer) return;
    if (state === 'writer') {
      // AppSession runs writer activation after state listeners. A microtask
      // therefore installs one final scene after daily/refresh duties while
      // suppression is still active, then releases exactly this scope.
      const release = releasePreparingCueBaseline;
      queueMicrotask(() => {
        try {
          if (releasePreparingCueBaseline === release && session.state === 'writer') update();
        } finally {
          release();
          if (releasePreparingCueBaseline === release) releasePreparingCueBaseline = undefined;
        }
      });
    } else if (state !== 'preparing') {
      // Failed/cancelled takeover: release the exact scope that preparation acquired.
      const release = releasePreparingCueBaseline;
      releasePreparingCueBaseline = undefined;
      release();
    }
  };
  session.subscribeState(syncWriterState);

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
    if (!session.supportsWriterLock) {
      if (notify) toast(t('main.coordUnsupported'), true);
      return false;
    }
    try {
      const acquired = await session.requestTakeover();
      if (!acquired) {
        if (notify) toast(t('main.writerBusy'), true);
        return false;
      }
      if (notify) toast(t('main.takeoverOk'));
      return true;
    } catch (error) {
      console.error('接管写权限失败', error);
      if (notify) toast(t('main.takeoverFailed', { error: error instanceof Error ? error.message : String(error) }), true);
      return false;
    }
  };

  if (takeOver && session.supportsWriterLock) takeOver.onclick = () => { void requestTakeover(); };

  const applyTheme = () => {
    syncThemeDataset(store.data.settings.theme, document.documentElement.dataset);
    setTimeout(() => {
      renderer.readTheme();
      update();
    }, 30);
  };

  const renderLegend = () => {
    $('legend').innerHTML =
      `<span><i style="background:${ROOFS[0]}"></i>${t('legend.project')}</span><span>${t('legend.todo')}</span><span><i style="background:#a8794a"></i>${t('legend.dock')}</span><span><i style="background:#e2ad2f"></i>${t('legend.granary')}</span><span><i style="background:#d8dcdc"></i>${t('legend.fog')}</span><span>${t('legend.cultivation')}</span><span>${t('legend.agenda')}</span><span>${t('legend.drift')}</span>`;
  };
  const syncLanguageButton = () => {
    const button = $('langBtn');
    setText(button, t('language.switch'));
    button.setAttribute('aria-label', t('language.switchAria'));
  };
  buildStats();
  renderLegend();
  syncLanguageButton();

  renderer = new IslandRenderer($('map') as HTMLCanvasElement, $('mapwrap'));
  let dusk = false;
  function openProjectAfterCreate(id: string) {
    tracker.open({ kind: 'project', id });
    requestAnimationFrame(() => {
      $('trackerBody').querySelector<HTMLInputElement>('input[name="ptask"]')?.focus();
    });
  }

  const tracker = new Tracker(store, {
    openNew: (kind) => openNew(store, kind, openProjectAfterCreate),
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
      // 砖落地时村落亮一下；任务和日程都一样。之后的盖房、烧窑提示由场景差分另行产生。
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

  /* 景物说明：指针与键盘共享 renderer 里的同一套景物语义。 */
  const infoBox = $('mapinfo');
  const infoAnnounce = $('mapAnnounce');
  const mapCanvas = $('map') as HTMLCanvasElement;
  let currentInspection: SceneryInspection | null = null;
  const hideInfo = () => {
    currentInspection = null;
    if (infoBox.hidden) return;
    infoBox.hidden = true;
    setText(infoAnnounce, '');
    renderer.clearFocus();
  };
  clearSessionSensitiveMapInfo = hideInfo;
  function pickAndClassifyDrift(title: string): boolean {
    // Pointer, keyboard and card button share the same writer guard.
    if (store.isReadOnly) return false;
    hideInfo();
    renderer.pickDrift(title);
    markDriftSeen(title);
    update();
    openClassify(store, new Set(), title);
    return true;
  }
  const showInspection = (r: SceneryInspection | null) => {
    if (!r) return hideInfo();
    currentInspection = r;
    const { info } = r;
    const driftAction = r.target?.kind === 'drift'
      ? `<div class="mi-actions"><button type="button" class="mi-action"${store.isReadOnly ? ' disabled' : ''}>${store.isReadOnly ? t('map.driftReadOnly') : t('map.driftClassify')}</button></div>`
      : '';
    setHTML(
      infoBox,
      `<div class="mi-head"><b>${esc(info.title)}</b>${info.sub ? `<small>${esc(info.sub)}</small>` : ''}<button type="button" class="mi-x" aria-label="${esc(t('common.close'))}">×</button></div>` +
        info.lines.map((l) => `<p>${esc(l)}</p>`).join('') +
        driftAction,
    );
    infoBox.hidden = false;
    // 播报通道永久留在可访问性树里；可视卡片可以自由 hidden/unhidden。
    setText(infoAnnounce, [info.title, info.sub, ...info.lines].filter(Boolean).join('。'));
    // 卡片放在景物上方；太靠上就放到下方，左右不超出地图
    const wrap = $('mapwrap');
    const W = wrap.clientWidth;
    const bw = infoBox.offsetWidth;
    const bh = infoBox.offsetHeight;
    const below = r.y - bh - 12 < 8;
    infoBox.classList.toggle('below', below);
    const left = Math.min(Math.max(8, r.x - bw / 2), W - bw - 8);
    infoBox.style.left = `${left}px`;
    infoBox.style.top = `${below ? Math.min(r.y + 14, wrap.clientHeight - bh - 8) : r.y - bh - 12}px`;
    infoBox.style.setProperty('--arrow', `${Math.min(Math.max(14, r.x - left), bw - 14)}px`);
    infoBox.querySelector<HTMLButtonElement>('.mi-x')!.onclick = hideInfo;
    const action = infoBox.querySelector<HTMLButtonElement>('.mi-action');
    if (action && r.target?.kind === 'drift') {
      const title = r.target.title;
      action.onclick = () => { pickAndClassifyDrift(title); };
    }
  };
  const showInfo = (pt: { x: number; y: number }) => showInspection(renderer.inspect(pt));

  mapCanvas.addEventListener('pointerdown', hideInfo);
  mapCanvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && currentInspection?.target?.kind === 'drift') {
      e.preventDefault();
      $('tip').style.opacity = '0';
      pickAndClassifyDrift(currentInspection.target.title);
      return;
    }
    let step: 1 | -1 | null = null;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown') step = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step = -1;
    if (step) {
      e.preventDefault();
      $('tip').style.opacity = '0';
      showInspection(renderer.browseScenery(step));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideInfo();
  });

  renderer.onTap = (hit, pt) => {
    $('tip').style.opacity = '0';
    if (!hit) return showInfo(pt);
    if (hit.kind === 'drift') {
      // 只读标签页不能归类；统一动作返回 false 时只显示说明。
      if (!pickAndClassifyDrift(hit.title)) showInfo(pt);
      return;
    }
    if (hit.kind === 'agenda' || hit.kind === 'cultivation') return showInfo(pt);
    if (hit.kind === 'project' || hit.kind === 'task') tracker.open({ kind: hit.kind, id: hit.id });
    else tracker.open({ kind: hit.kind });
  };
  $('zin').onclick = () => {
    hideInfo();
    renderer.zoomBy(1.35);
  };
  $('zout').onclick = () => {
    hideInfo();
    renderer.zoomBy(1 / 1.35);
  };
  $('zfit').onclick = () => {
    hideInfo();
    renderer.resetView();
  };

  /* ---------------- 每次数据变化 ---------------- */
  let lastToday = store.today();
  let agendaTimer = 0;
  function scheduleAgendaRefresh(agenda: ReturnType<typeof agendaAt>, now: Date) {
    window.clearTimeout(agendaTimer);
    const until = agenda.nextChange ? agenda.nextChange.getTime() - now.getTime() : 60_000;
    const delay = Math.max(1_000, Math.min(60_000, Number.isFinite(until) ? until : 60_000));
    agendaTimer = window.setTimeout(() => {
      const todayNow = store.today();
      if (todayNow !== lastToday && !store.isReadOnly) {
        daily();
        lastToday = todayNow;
      }
      update();
    }, delay);
  }

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
    // 地图场景和顶部日期/天气共用同一个时间快照，避免午夜边界出现互相矛盾的状态。
    const now = store.clock();
    const today = localDate(now);
    const agenda = agendaAt(store.data, now);
    updateStats(store);
    tracker.render();
    renderer.setScene(buildScene(store, selectionOf(tracker.view), dusk, now, agenda));

    const pend = pendingDays(store.data, today);
    const light = lightNow(now, dusk);
    const listSeparator = getLocale() === 'zh-CN' ? '、' : ', ';
    const allDayText = agenda.allDay.length
      ? ` · ${agenda.allDay.slice(0, 2).join(listSeparator)}${agenda.allDay.length > 2 ? t('map.allDayMore', { count: agenda.allDay.length - 2 }) : ''}`
      : '';
    setText($('date'), `${fmtDay(today)} ${weekday(today)} · ${seasonName(seasonOf(today))}${allDayText}`);
    const sb = $('settleBtn');
    setHTML(sb, `${t(light === 'day' ? 'shell.settleDay' : 'shell.settle')}${pend.length ? `<span class="dot">${pend.length}</span>` : ''}`);
    const wb = $('weather');
    const festival = festivalsOf(today).map((f) => ' · ' + festivalName(f)).join('');
    const fog = pend.length ? t('map.fogSuffix', { count: pend.length }) : '';
    setText(wb, t('map.weather', {
      season: seasonName(seasonOf(today)),
      light: lightName(light),
      weather: weatherName(weatherOf(today, seasonOf(today))),
      festival,
      fog,
    }));
    wb.classList.toggle('dusk', light !== 'day' || pend.length > 0);
    $('fogbar').hidden = !pend.length;
    if (pend.length) {
      const days = pend.map((d) => relDay(d, today)).join(listSeparator);
      setHTML($('fogTxt'), `<b>${esc(t('map.fogTitle'))}</b><span>${esc(t('map.fogBody', { days }))}</span>`);
    }
    const ps = store.activeProjects().length;
    setText($('mapDesc'), ps ? t('map.descActive', { count: ps }) : t('map.descEmpty'));

    const lines = store.data.chronicle.map((c, i) => [c, i] as const).sort((a, b) => b[0].date.localeCompare(a[0].date) || b[1] - a[1]);
    setHTML($('chron'), lines.length ? lines.slice(0, 80).map(([c]) => `<li class="k-${c.kind}"><time>${esc(relDay(c.date, today))}</time><span>${esc(formatChronicleLine(c))}</span></li>`).join('') : `<li class="empty">${esc(t('chron.empty'))}</li>`);
    setText($('chronCount'), t('chron.count', { count: store.data.chronicle.length }));
    scheduleAgendaRefresh(agenda, now);
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
    if (archived.length) toast(t('daily.archived', { days: archived.map(fmtDay).join(getLocale() === 'zh-CN' ? '、' : ', ') }));
  }

  function resumeWriterDuties() {
    if (store.isReadOnly) return;
    daily();
    lastToday = store.today();
    asked.clear();
    setTimeout(maybePrompt, 0);
    runWriterAutoRefresh();
  }

  session.setWriterActivation(resumeWriterDuties);
  onLocaleChange(() => {
    const trackerDraft = tracker.captureDraftState();
    syncLanguageButton();
    buildStats();
    renderLegend();
    update();
    tracker.restoreDraftState(trackerDraft);
  });
  store.subscribe(update);
  update();
  renderer.start();

  // Bind the session first: on a visible transition it publishes any durable
  // reload/resume work before the renderer waits on the lifecycle barrier.
  session.bindBrowserLifecycle();
  let visibilityRefresh = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      visibilityRefresh++;
      return;
    }
    const generation = ++visibilityRefresh;
    const releaseCueSuppression = renderer.beginCueSuppression();
    const applyFreshBaseline = () => {
      try {
        if (document.visibilityState !== 'visible' || generation !== visibilityRefresh) return;
        if (store.today() !== lastToday && !store.isReadOnly) {
          daily();
          lastToday = store.today();
        }
        // This update runs while suppression is still sticky, so the refreshed
        // durable snapshot becomes the cue baseline instead of replaying missed
        // soon / growth transitions from the hidden interval.
        update();
      } finally {
        releaseCueSuppression();
      }
    };
    void session.whenIdle().then(applyFreshBaseline, applyFreshBaseline);
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(() => renderer.readTheme(), 50));

  /* ---------------- 顶部按钮 ---------------- */
  $('settleBtn').onclick = () => settle.open();
  $('fogGo').onclick = () => settle.open();
  $('newBtn').onclick = () => openNew(store, 'task', openProjectAfterCreate);
  $('langBtn').onclick = () => toggleLocale();
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
      // Reader tabs may refresh while the privacy confirmation is open.
      // Warn about one exact Store snapshot and only download that snapshot;
      // if reload replaced it, re-prompt against the fresh data.
      while (true) {
        const warnedData = store.data;
        const diaryCount = warnedData.diaries.length;
        const backup = exportBackup(warnedData);
        const ok = await confirmModal({
          title: t('main.exportTitle'),
          text: diaryCount
            ? t('main.exportDiaryBody', { count: diaryCount })
            : t('main.exportBody'),
          ok: t('main.exportOk'),
          readOnlySafe: true,
        });
        if (!ok) return;
        if (store.data !== warnedData) {
          toast(t('main.exportChanged'), true);
          continue;
        }
        download(`yuzhi-backup-${store.today()}.json`, backup);
        toast(t('main.exportDone'));
        break;
      }
    } else if (m === 'import') {
      const context = store.captureWriteContext();
      const revision = session.revision;
      const f = await pickFile($('fileBackup') as HTMLInputElement);
      if (!f || !context.isCurrent()) return;
      try {
        const d = parseBackup(await f.text());
        if (!context.isCurrent()) return;
        const ok = await confirmModal({ title: t('main.importTitle'), text: t('main.importBody', { projects: d.projects.length, tasks: d.tasks.length, entries: d.entries.length }), ok: t('main.importOk'), danger: true });
        if (!ok || !context.isCurrent()) return;
        await store.replaceAll(d);
        if (session.revision !== revision || store.isReadOnly) return;
        tracker.open({ kind: 'overview' }, false);
        applyTheme();
        daily();
        toast(t('main.importDone'));
      } catch (err) {
        if (session.revision !== revision || store.isReadOnly) return;
        toast(err instanceof Error ? err.message : String(err), true);
      }
    } else if (m === 'archive') tracker.open({ kind: 'archive' });
    else if (m === 'demo') seedDemo(store);
  });

  applyTheme();

  // 第一次打开
  if (
    !store.isReadOnly &&
    !store.data.projects.length &&
    !store.data.tasks.length &&
    !store.data.sources.length &&
    !store.data.events.length &&
    !store.data.diaries.length
  ) {
    openWelcome({
      project: () => openNew(store, 'project', openProjectAfterCreate),
      calendar: () => openCalendar(store, afterImport),
      demo: () => {
        seedDemo(store);
        setTimeout(maybePrompt, 1500);
      },
    });
  } else setTimeout(maybePrompt, 1200);

  // 方便调试与真实浏览器验收（生命周期、地图点击）。session 暴露的是现有应用边界，
  // 不另建测试专用权限状态；renderer / tracker 只供脚本读取坐标和当前视图。
  (window as unknown as { yuzhi: unknown }).yuzhi = { store, actions: A, session, renderer, tracker };
}

boot();
