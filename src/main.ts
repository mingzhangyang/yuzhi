import './styles.css';
import { IdbPersistence, MemoryPersistence, exportBackup, parseBackup, type Persistence } from './db';
import { Store } from './store';
import type { Data } from './types';
import { IslandRenderer, type Selection } from './island/render';
import { $, download, esc, pickFile, setHTML, setText, toast } from './ui/dom';
import { confirmModal, initModal, isModalOpen } from './ui/modal';
import { buildStats, updateStats } from './ui/stats';
import { Tracker, abandonPrompt, type View } from './ui/tracker';
import { SettleSheet } from './ui/settle';
import { buildScene, lightNow, ROOFS } from './ui/scene';
import { openCalendar, openClassify, openClosed, openNew, openSettings, openWelcome, seedDemo } from './ui/forms';
import * as A from './actions';
import { autoRefresh } from './calendar';
import { pendingDays } from './logic/days';
import { SEASONS, fmtDay, relDay, seasonOf, weekday } from './lib/date';
import { unclassifiedGroups } from './logic/classify';

async function boot() {
  initModal();
  let per: Persistence = new IdbPersistence();
  let data: Data;
  try {
    data = await per.load();
  } catch {
    per = new MemoryPersistence();
    data = await per.load();
    setTimeout(() => toast('这个浏览器不允许本地存储，这次的记录不会被保存', true), 500);
  }
  const store = new Store(data, per);
  store.onError = (e) => toast('保存失败：' + (e instanceof Error ? e.message : String(e)), true);

  const applyTheme = () => {
    const t = store.data.settings.theme;
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
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
    onViewChange: () => update(),
  });
  tracker.bindChange();

  const settle = new SettleSheet(store, {
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
        return { kind: v.kind };
      default:
        return null;
    }
  };

  renderer.onTap = (hit) => {
    $('tip').style.opacity = '0';
    if (!hit) return;
    if (hit.kind === 'lighthouse') {
      toast('山顶的灯塔是档案馆。落成仪式和档案馆会在第二版开放。');
      return;
    }
    if (hit.kind === 'project' || hit.kind === 'task') tracker.open({ kind: hit.kind, id: hit.id });
    else tracker.open({ kind: hit.kind });
  };
  $('zin').onclick = () => renderer.zoomBy(1.35);
  $('zout').onclick = () => renderer.zoomBy(1 / 1.35);
  $('zfit').onclick = () => renderer.resetView();

  /* ---------------- 每次数据变化 ---------------- */
  let lastToday = store.today();
  function update() {
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
    if (isModalOpen() || settle.isOpen()) return;
    const p = A.projectsNeedingPrompt(store).find((x) => !asked.has(x.id));
    if (!p) return;
    asked.add(p.id);
    abandonPrompt(store, p, () => setTimeout(maybePrompt, 300));
  }

  /** 新的一天：归档超过 3 天的未结算日子，记下阶段变化 */
  function daily() {
    const archived = A.archiveOldDays(store);
    if (archived.length) toast(`${archived.map(fmtDay).join('、')}没有记录，已归档。不算做了，也不算没做。`);
    A.refreshStages(store);
  }

  store.subscribe(update);
  daily();
  update();
  renderer.start();

  setInterval(() => {
    const t = store.today();
    if (t !== lastToday) {
      lastToday = t;
      daily();
    }
    update();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (store.today() !== lastToday) {
        lastToday = store.today();
        daily();
      }
      update();
    }
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(() => renderer.readTheme(), 50));

  /* ---------------- 顶部按钮 ---------------- */
  $('settleBtn').onclick = () => settle.open();
  $('fogGo').onclick = () => settle.open();
  $('newBtn').onclick = () => openNew(store, 'task');
  const afterImport = () => {
    if (unclassifiedGroups(store.data.events).length) setTimeout(() => openClassify(store), 400);
  };
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
      const f = await pickFile($('fileBackup') as HTMLInputElement);
      if (!f) return;
      try {
        const d = parseBackup(await f.text());
        const ok = await confirmModal({ title: '用备份替换现在的小岛？', text: `备份里有 ${d.projects.length} 个项目、${d.tasks.length} 件任务、${d.entries.length} 条结算记录。现在这座岛上的数据会被替换。`, ok: '替换', danger: true });
        if (!ok) return;
        await store.replaceAll(d);
        tracker.open({ kind: 'overview' }, false);
        applyTheme();
        daily();
        toast('备份已导入');
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), true);
      }
    } else if (m === 'closed') openClosed(store, (id) => tracker.open({ kind: 'project', id }));
    else if (m === 'demo') seedDemo(store);
  });

  applyTheme();

  // 第一次打开
  if (!store.data.projects.length && !store.data.tasks.length && !store.data.sources.length) {
    openWelcome({
      project: () => openNew(store, 'project', (id) => tracker.open({ kind: 'project', id })),
      calendar: () => openCalendar(store, afterImport),
      demo: () => {
        seedDemo(store);
        setTimeout(maybePrompt, 1500);
      },
    });
  } else setTimeout(maybePrompt, 1200);

  // 后台刷新日历订阅
  autoRefresh(store).then((n) => {
    if (n && !isModalOpen() && !settle.isOpen()) afterImport();
  });

  // 方便调试
  (window as unknown as { yuzhi: unknown }).yuzhi = { store, actions: A };
}

boot();
