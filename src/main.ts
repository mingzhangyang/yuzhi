import './styles.css';
import { exportBackup, parseBackup } from './db';
import { restoreBackupSnapshot } from './restore-backup';
import { AppSession } from './app-session';
import { IslandRenderer, type SceneryInspection, type Selection } from './island/render';
import { MARKER } from './island/render/style';
import { $, esc, pickFile, setHTML, setText, toast } from './ui/dom';
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
import { deliverBackup, markBackupExported, SafetyNoticeBar } from './ui/safety';
import { AutoBackup } from './ui/auto-backup';
import { readSettlementSnapshot, SettlementBackup, type SettlementSnapshot } from './ui/settlement-backup';
import { showStartupError } from './ui/startup-error';

// 标题衬线字体按需异步加载：不阻塞首屏，加载完成前用系统宋体 / 衬线回退（font-display: swap）。
void import('./fonts.css');

/** 还没有任何现实输入的新岛：没有项目、任务、日历、日程、日记，也没有结算 */
function isBlankIsland(data: { projects: unknown[]; tasks: unknown[]; sources: unknown[]; events: unknown[]; diaries: unknown[]; entries: unknown[] }): boolean {
  return !data.projects.length && !data.tasks.length && !data.sources.length && !data.events.length && !data.diaries.length && !data.entries.length;
}

/** Export the exact saved snapshot that the privacy confirmation describes. */
async function exportSettlementSnapshot(existing?: SettlementSnapshot) {
  let snapshot: SettlementSnapshot | undefined;
  try {
    snapshot = existing ?? await readSettlementSnapshot();
  } catch {
    toast(t('safety.snapshotUnavailable'), true);
    return;
  }
  if (!snapshot) {
    toast(t('safety.snapshotNone'), true);
    return;
  }
  const ok = await confirmModal({
    title: t('main.exportTitle'),
    text: (snapshot.diaryCount
      ? t('main.exportDiaryBody', { count: snapshot.diaryCount })
      : t('main.exportBody')) + ` ${t('safety.snapshotHistorical')}`,
    ok: t('main.exportOk'),
    readOnlySafe: true,
  });
  if (!ok) return;
  try {
    const delivery = await deliverBackup(`yuzhi-settlement-${snapshot.date}.json`, snapshot.json);
    if (delivery === 'cancelled') return;
    // This historical snapshot may not include newer data, so it must not
    // reset the reminder for exporting the current island.
    toast(t(delivery === 'saved' ? 'safety.snapshotExportDone' : 'safety.exportHandoff'));
  } catch {
    toast(t('main.exportFailed'), true);
  }
}

async function boot() {
  initI18n({ detectBrowser: true });
  initModal();
  let settle!: SettleSheet;
  let ceremony!: Ceremony;
  let session: AppSession;
  try {
    const started = await AppSession.start();
    session = started.session;
  } catch (error) {
    console.error('无法打开屿志本地数据', error);
    showStartupError(error, {
      retry: () => window.location.reload(),
      exportSnapshot: (snapshot) => { void exportSettlementSnapshot(snapshot); },
    });
    return;
  }
  const store = session.store;
  let renderer!: IslandRenderer;
  let releasePreparingCueBaseline: (() => void) | undefined;
  // Map inspections capture the permission state used to build their actions.
  // A session generation change invalidates that UI snapshot.
  let clearSessionSensitiveMapInfo: () => void = () => {};
  let syncSettlementBackupNotice: () => void = () => {};

  const syncReadOnlyUi = (readOnly: boolean) => {
    for (const id of ['newBtn', 'settleBtn', 'fogGo', 'calBtn']) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (button) button.disabled = readOnly;
    }
    document.querySelectorAll<HTMLButtonElement>('#menu [data-m="settings"], #menu [data-m="import"], #menu [data-m="demo"], #menu [data-m="calendar"]')
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
    syncSettlementBackupNotice();
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
      `<span><i style="background:${ROOFS[0]}"></i>${t('legend.project')}</span><span>${t('legend.todo')}</span><span><i style="background:${MARKER.dock}"></i>${t('legend.dock')}</span><span><i style="background:${MARKER.granary}"></i>${t('legend.granary')}</span><span><i style="background:${MARKER.fog}"></i>${t('legend.fog')}</span><span>${t('legend.cultivation')}</span><span>${t('legend.agenda')}</span><span>${t('legend.drift')}</span>`;
  };
  const syncLanguageButton = () => {
    const button = $('langBtn');
    setText(button, t('language.switch'));
    button.setAttribute('aria-label', t('language.switchAria'));
    button.hidden = false;
    // 菜单里的同一项（窄屏用）：文字是目标语言，lang 也跟着目标语言走，读屏才会用对发音。
    const item = document.querySelector<HTMLElement>('#menu [data-m="language"]');
    if (item) item.lang = getLocale() === 'zh-CN' ? 'en' : 'zh-CN';
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
    openSettings: () => openSettings(store, applyTheme, { exportBackup: () => void exportFlow(), exportSnapshot: () => void exportSettlementSnapshot(), autoBackup }),
    openCeremony: (p) => ceremony.open(p),
    onViewChange: () => update(),
  });
  tracker.bindChange();
  // The partly exposed map remains interactive while the tracker is open;
  // only real viewport occlusion may suspend animation.

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
    // An evening review is the day's real change: refresh today's backup file.
    settled: (date) => {
      void settlementBackup.run(date);
      void autoBackup.run('settled');
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
  // 捏合 / Ctrl+滚轮缩放后，说明卡片的位置已经不对了。
  mapCanvas.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) hideInfo(); }, { passive: true });
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
  // The mobile bottom sheet consumes Escape in its own keydown handler.
  // Clear the scenery card first, or it can cover the next tap on the map.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideInfo();
  }, true);

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

  // 数据只在这个浏览器里：申请持久存储、提醒备份、自动备份到文件夹、说明「添加到主屏幕」。
  const autoBackup = new AutoBackup(store);
  const settlementBackup = new SettlementBackup(store);
  const safetyBar = new SafetyNoticeBar(store, () => void exportFlow(), autoBackup);
  autoBackup.onChange = () => safetyBar.sync();
  syncSettlementBackupNotice = () => {
    $('settlementBackupNotice').hidden = !settlementBackup.failed;
    $<HTMLButtonElement>('settlementBackupRetry').disabled = store.isReadOnly;
  };
  settlementBackup.onChange = syncSettlementBackupNotice;
  $('settlementBackupRetry').addEventListener('click', () => { void settlementBackup.retry(); });
  $('settlementBackupExport').addEventListener('click', () => { void exportFlow(); });

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

  /** 上一次算指标 / 编年史时的输入；buildStats() 重建了指标卡之后要清空它 */
  let derivedFor: { data: unknown; version: number; today: string; locale: string } = { data: null, version: -1, today: '', locale: '' };
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
    // 指标和编年史只取决于数据、日期和语言：只是换视图或到点刷新时不重算。
    const derivedChanged = store.data !== derivedFor.data || store.dataVersion !== derivedFor.version
      || today !== derivedFor.today || getLocale() !== derivedFor.locale;
    if (derivedChanged) {
      derivedFor = { data: store.data, version: store.dataVersion, today, locale: getLocale() };
      // 一片空白的新岛上，「粮仓 9 小时、推进 0、状态 —」只是噪音：有了第一条记录再显示指标。
      $('stats').hidden = isBlankIsland(store.data);
      updateStats(store);
    }
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

    if (derivedChanged) {
      const lines = store.data.chronicle.map((c, i) => [c, i] as const).sort((a, b) => b[0].date.localeCompare(a[0].date) || b[1] - a[1]);
      setHTML($('chron'), lines.length ? lines.slice(0, 80).map(([c]) => `<li class="k-${c.kind}"><time>${esc(relDay(c.date, today))}</time><span>${esc(formatChronicleLine(c))}</span></li>`).join('') : `<li class="empty">${esc(t('chron.empty'))}</li>`);
      setText($('chronCount'), t('chron.count', { count: store.data.chronicle.length }));
    }
    safetyBar.sync();
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
    const { archived, repaired } = store.batch(() => {
      const repaired = A.repairTruncatedYearDates(store);
      A.refreshStages(store);
      return { archived: A.archiveOldDays(store), repaired };
    });
    if (archived.length) toast(t('daily.archived', { days: archived.map(fmtDay).join(getLocale() === 'zh-CN' ? '、' : ', ') }));
    else if (repaired.length) toast(t('daily.repairedDates', { count: repaired.length }));
    // First chance each day (startup, takeover, date change, import).
    void autoBackup.run('daily');
  }

  function resumeWriterDuties() {
    if (store.isReadOnly) return;
    daily();
    // Backfill an absent snapshot without replacing an existing recovery point.
    const latest = store.data.days.filter((day) => day.status === 'settled').map((day) => day.date).sort().at(-1);
    if (latest) void settlementBackup.ensure(latest);
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
    derivedFor = { data: null, version: -1, today: '', locale: '' };
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

  /* ---------------- 导出备份 ---------------- */
  async function exportFlow() {
    // Warn about one exact saved snapshot. A reader refresh or an in-place
    // edit while waiting or confirming must restart the confirmation.
    while (true) {
      const warnedData = store.data;
      const warnedVersion = store.dataVersion;
      let snapshot;
      let lastSavedOnly = false;
      try {
        snapshot = await store.committedSnapshot();
      } catch {
        snapshot = await store.lastSavedSnapshot();
        lastSavedOnly = true;
      }
      if (store.data !== warnedData || store.dataVersion !== warnedVersion) continue;
      const diaryCount = snapshot.diaries.length;
      const backup = exportBackup(snapshot);
      const ok = await confirmModal({
        title: t('main.exportTitle'),
        text: (diaryCount
          ? t('main.exportDiaryBody', { count: diaryCount })
          : t('main.exportBody')) + (lastSavedOnly ? ` ${t('main.exportLastSaved')}` : ''),
        ok: t('main.exportOk'),
        readOnlySafe: true,
      });
      if (!ok) return;
      if (store.data !== warnedData || store.dataVersion !== warnedVersion) {
        toast(t('main.exportChanged'), true);
        continue;
      }
      const today = store.today();
      let delivery;
      try {
        delivery = await deliverBackup(`yuzhi-backup-${today}.json`, backup);
        if (delivery === 'cancelled') return;
      } catch {
        toast(t('main.exportFailed'), true);
        return;
      }
      if (delivery !== 'saved') {
        // Download/share APIs only confirm handoff, never that a file landed.
        // Ask the user to check the destination before clearing reminders.
        const confirmed = await confirmModal({
          title: t('safety.verifyTitle'),
          text: t('safety.verifyBody'),
          ok: t('safety.verifyOk'),
          readOnlySafe: true,
        });
        if (!confirmed) {
          toast(t('safety.exportHandoff'));
          return;
        }
      }
      markBackupExported(today);
      safetyBar.sync();
      toast(t('main.exportDone'));
      break;
    }
  }

  /* ---------------- 导入备份 ---------------- */
  async function importFlow() {
    const context = store.captureWriteContext();
    const revision = session.revision;
    const f = await pickFile($('fileBackup') as HTMLInputElement);
    if (!f || !context.isCurrent()) return;
    try {
      const d = parseBackup(await f.text());
      if (!context.isCurrent()) return;
      const ok = await confirmModal({ title: t('main.importTitle'), text: t('main.importBody', { projects: d.projects.length, tasks: d.tasks.length, entries: d.entries.length }), ok: t('main.importOk'), danger: true });
      if (!ok || !context.isCurrent()) return;
      await restoreBackupSnapshot(store, d);
      if (session.revision !== revision || store.isReadOnly) return;
      tracker.open({ kind: 'overview' }, false);
      applyTheme();
      // Restoring a snapshot is not a time-passage event. Running daily() here
      // would append stage and archive chronicle entries to the imported history.
      // Ordinary writer activation and subsequent day changes still reconcile
      // elapsed time, independently of the restore transaction.
      toast(t('main.importDone'));
    } catch (err) {
      if (session.revision !== revision || store.isReadOnly) return;
      toast(err instanceof Error ? err.message : String(err), true);
    }
  }

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
  const moreBtn = $('moreBtn');
  const setMenuOpen = (open: boolean) => {
    menu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
  };
  /** 菜单里此刻能用的项：窄屏才显示的项、只读时禁用的项都跳过 */
  const menuItems = () => [...menu.querySelectorAll<HTMLButtonElement>('button[data-m]')]
    .filter((b) => !b.disabled && b.offsetParent !== null);
  const focusMenuItem = (index: number) => {
    const items = menuItems();
    if (!items.length) return;
    items[(index + items.length) % items.length].focus();
  };
  moreBtn.onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) {
      setMenuOpen(false);
      return;
    }
    const r = moreBtn.getBoundingClientRect();
    setMenuOpen(true);
    menu.style.top = `${r.bottom + window.scrollY + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
    // 键盘打开（Enter / 空格，detail 为 0）时焦点进入第一项；鼠标点开不抢焦点。
    if (e.detail === 0) focusMenuItem(0);
  };
  moreBtn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (menu.hidden) moreBtn.click();
    focusMenuItem(e.key === 'ArrowDown' ? 0 : -1);
  });
  menu.addEventListener('keydown', (e) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusMenuItem(at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusMenuItem(e.key === 'Home' ? 0 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMenuOpen(false);
      moreBtn.focus();
      e.stopPropagation();
    } else if (e.key === 'Tab') {
      // 菜单节点在 body 末尾：放任 Tab 会跳到页面最后。收起菜单，焦点回到 ⋯。
      e.preventDefault();
      setMenuOpen(false);
      moreBtn.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) setMenuOpen(false);
  });
  menu.addEventListener('click', async (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m;
    if (!m) return;
    setMenuOpen(false);
    // The keyboard-selected menu item is hidden now; dialogs must restore
    // focus to the visible menu trigger rather than that hidden item.
    moreBtn.focus({ preventScroll: true });
    if (m === 'settings') openSettings(store, applyTheme, { exportBackup: () => void exportFlow(), exportSnapshot: () => void exportSettlementSnapshot(), autoBackup });
    else if (m === 'export') await exportFlow();
    else if (m === 'import') await importFlow();
    else if (m === 'archive') tracker.open({ kind: 'archive' });
    else if (m === 'demo') seedDemo(store);
    else if (m === 'calendar') openCalendar(store, afterImport);
    else if (m === 'language') toggleLocale();
  });

  applyTheme();

  // 第一次打开
  if (!store.isReadOnly && isBlankIsland(store.data)) {
    openWelcome({
      project: () => openNew(store, 'project', openProjectAfterCreate),
      calendar: () => openCalendar(store, afterImport),
      demo: () => {
        seedDemo(store);
        setTimeout(maybePrompt, 1500);
      },
      // Moving into the installed Home Screen / Dock app starts from an empty
      // island; restoring is how the browser's island comes along.
      restore: () => { void importFlow(); },
    });
  } else setTimeout(maybePrompt, 1200);

  // 方便调试与真实浏览器验收（生命周期、地图点击）。session 暴露的是现有应用边界，
  // 不另建测试专用权限状态；renderer / tracker 只供脚本读取坐标和当前视图。
  (window as unknown as { yuzhi: unknown }).yuzhi = { store, actions: A, session, renderer, tracker };
}

boot();
