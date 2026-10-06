/**
 * 各种对话框：新建、日历、事件归类、设置、未竟之书、欢迎。
 */
import type { Store } from '../store';
import type { ISODate } from '../types';
import { CHORES } from '../types';
import { $, esc, pickFile, toast } from './dom';
import { closeModal, openModal } from './modal';
import * as A from '../actions';
import { addFileSource, addUrlSource, syncSource } from '../calendar';
import { suggestKeyword, unclassifiedGroups } from '../logic/classify';
import { addDays, dateOfStamp, fmtDay, relDay } from '../lib/date';
import { roofOf } from './scene';
import { bindDateSelects, dateSelect, readDate } from './date-select';
import { MAX_VILLAGES } from '../logic/config';
import { getLocale, t } from '../i18n';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 新建：高频捕捉保持轻量；场景内创建再继承项目等上下文。 */
export function openNew(
  store: Store,
  kind: 'task' | 'schedule' | 'diary' | 'project' = 'task',
  onProject?: (id: string) => void,
) {
  const today = store.today();
  const ps = store.activeProjects();
  const projectOptions = ps.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const titles = {
    task: t('forms.newTask'),
    schedule: t('forms.newSchedule'),
    diary: t('forms.newDiary'),
    project: t('forms.newProject'),
  } as const;
  const diaryDraftKey = 'yuzhi:capture:diary-draft';

  let diaryDraft: { date?: string; text?: string } | null = null;
  try {
    const saved = sessionStorage.getItem(diaryDraftKey);
    if (saved) diaryDraft = JSON.parse(saved) as { date?: string; text?: string };
  } catch {
    // Draft recovery is a convenience only; private browsing may reject storage.
  }

  const diaryDate = diaryDraft?.date && diaryDraft.date <= today ? diaryDraft.date : today;
  const diaryText = diaryDraft?.text ?? '';
  const body = `
    <div class="capture">
      <div class="seg capture-tabs" role="group" aria-label="${esc(t('forms.newTypeAria'))}">
        <button type="button" data-k="task" class="${kind === 'task' ? 'on' : ''}" aria-pressed="${kind === 'task'}">${esc(t('forms.taskTab'))}</button>
        <button type="button" data-k="schedule" class="${kind === 'schedule' ? 'on' : ''}" aria-pressed="${kind === 'schedule'}">${esc(t('forms.scheduleTab'))}</button>
        <button type="button" data-k="diary" class="${kind === 'diary' ? 'on' : ''}" aria-pressed="${kind === 'diary'}">${esc(t('forms.diaryTab'))}</button>
        <button type="button" data-k="project" class="${kind === 'project' ? 'on' : ''}" aria-pressed="${kind === 'project'}">${esc(t('forms.projectTab'))}</button>
      </div>

      <form class="capture-form" data-f="task" ${kind === 'task' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">${esc(t('forms.taskLabel'))}<input name="title" placeholder="${esc(t('forms.taskPlaceholder'))}" autocomplete="off" ${kind === 'task' ? 'autofocus' : ''}></label>
          <div class="capture-meta">
            <label class="field">${esc(t('forms.projectLabel'))}<select name="proj"><option value="">${esc(t('forms.projectNone'))}</option>${projectOptions}</select></label>
            <label class="field">${esc(t('forms.dateLabel'))}${dateSelect('date', today, { withNone: true, mode: 'task' })}</label>
          </div>
          <p class="hint">${esc(t('forms.taskHint'))}</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('forms.addTask'))}</button></div>
      </form>

      <form class="capture-form" data-f="schedule" ${kind === 'schedule' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">${esc(t('forms.scheduleTitle'))}<input name="title" placeholder="${esc(t('forms.schedulePlaceholder'))}" autocomplete="off" ${kind === 'schedule' ? 'autofocus' : ''}></label>
          <label class="field">${esc(t('forms.dateLabel'))}${dateSelect('date', today, { current: today, withNone: false, mode: 'schedule' })}</label>
          <div class="capture-time-grid">
            <label class="field">${esc(t('forms.start'))}<input name="start" type="time" value="09:00"></label>
            <label class="field">${esc(t('forms.end'))}<input name="end" type="time" value="10:00"></label>
          </div>
          <label class="field">${esc(t('forms.projectLabel'))}<select name="proj"><option value="${CHORES}">${esc(t('common.choresLife'))}</option>${projectOptions}</select></label>
          <p class="hint">${esc(t('forms.scheduleHint'))}</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('forms.createSchedule'))}</button></div>
      </form>

      <form class="capture-form diary-form" data-f="diary" ${kind === 'diary' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="diary-date-row"><span>${esc(t('forms.diaryDate'))}</span>${dateSelect('date', today, { current: diaryDate, withNone: false, mode: 'diary' })}</label>
          <label class="field diary-writing"><span class="sr-only">${esc(t('forms.diaryContent'))}</span><textarea name="text" placeholder="${esc(t('forms.diaryPlaceholder'))}" ${kind === 'diary' ? 'autofocus' : ''}>${esc(diaryText)}</textarea></label>
          <p class="hint" data-diary-note>${esc(t(diaryText ? 'forms.diaryRestored' : 'forms.diaryHint'))}</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>${esc(t('common.close'))}</button><button class="btn primary">${esc(t('forms.writeDiary'))}</button></div>
      </form>

      <form class="capture-form" data-f="project" ${kind === 'project' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">${esc(t('forms.projectName'))}<input name="name" placeholder="${esc(t('forms.projectPlaceholder'))}" autocomplete="off" ${kind === 'project' ? 'autofocus' : ''}></label>
          <p class="hint">${esc(t('forms.projectHint'))}</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>${esc(t('common.cancel'))}</button><button class="btn primary">${esc(t('forms.createProject'))}</button></div>
      </form>
    </div>`;

  openModal({
    title: titles[kind],
    body,
    mount(box) {
      bindDateSelects(box, today);

      const selectKind = (nextKind: keyof typeof titles) => {
        box.querySelectorAll<HTMLElement>('[data-k]').forEach((button) => {
          const selected = button.dataset.k === nextKind;
          button.classList.toggle('on', selected);
          button.setAttribute('aria-pressed', String(selected));
        });
        box.querySelectorAll<HTMLFormElement>('form[data-f]').forEach((form) => {
          form.hidden = form.dataset.f !== nextKind;
        });
        const title = box.querySelector<HTMLElement>('#mdlT');
        if (title) title.textContent = titles[nextKind];
        box.querySelector<HTMLElement>(`form[data-f="${nextKind}"] input:not([type="hidden"]), form[data-f="${nextKind}"] textarea`)?.focus();
      };

      box.querySelectorAll<HTMLElement>('[data-k]').forEach((button) =>
        button.addEventListener('click', () => selectKind(button.dataset.k as keyof typeof titles)),
      );

      const diaryForm = box.querySelector<HTMLFormElement>('form[data-f="diary"]')!;
      const diaryTextArea = diaryForm.querySelector<HTMLTextAreaElement>('textarea[name=text]')!;
      const diaryDateSelect = diaryForm.querySelector<HTMLSelectElement>('select[name=date]')!;
      const persistDiaryDraft = () => {
        const draft = { date: readDate(diaryDateSelect) ?? today, text: diaryTextArea.value };
        try {
          if (draft.text.trim()) sessionStorage.setItem(diaryDraftKey, JSON.stringify(draft));
          else sessionStorage.removeItem(diaryDraftKey);
        } catch {
          // Ignore storage failures; the form itself still works normally.
        }
      };
      diaryTextArea.addEventListener('input', persistDiaryDraft);
      diaryDateSelect.addEventListener('input', persistDiaryDraft);

      box.querySelectorAll<HTMLFormElement>('form[data-f]').forEach((form) =>
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const fd = new FormData(form);
          try {
            if (form.dataset.f === 'task') {
              const pid = String(fd.get('proj') ?? '');
              const date = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!);
              const task = A.createTask(store, {
                title: String(fd.get('title') ?? ''),
                projectId: pid || undefined,
                scheduledFor: date,
              });
              toast(task.projectId ? t('forms.taskVillageToast', { task: task.title, project: store.project(task.projectId)?.name ?? '' }) : t('forms.taskDockToast', { task: task.title }));
            } else if (form.dataset.f === 'schedule') {
              const date = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!) ?? today;
              const event = A.createSchedule(store, {
                title: String(fd.get('title') ?? ''),
                date,
                start: String(fd.get('start') ?? ''),
                end: String(fd.get('end') ?? ''),
                projectId: String(fd.get('proj') ?? CHORES),
              });
              toast(t('forms.scheduleToast', { title: event.title }));
            } else if (form.dataset.f === 'diary') {
              const date = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!) ?? today;
              const entry = A.createDiary(store, {
                date,
                text: String(fd.get('text') ?? ''),
              });
              try {
                sessionStorage.removeItem(diaryDraftKey);
              } catch {
                // Ignore storage cleanup failures after a successful save.
              }
              toast(t('forms.diaryToast', { date: fmtDay(entry.date) }));
            } else {
              const project = A.createProject(store, String(fd.get('name') ?? ''));
              toast(t('forms.projectToast', { name: project.name }));
              closeModal(false);
              onProject?.(project.id);
              return;
            }
            closeModal(false);
          } catch (err) {
            if (err instanceof A.ActionError) toast(err.message, true);
            else throw err;
          }
        }),
      );
    },
  });
}
/** 日历：订阅链接、上传文件、归类规则 */
export function openCalendar(store: Store, onImported: () => void) {
  // 日历对话框里的每个操作都会写入；只读标签页不打开半绑定的对话框
  if (store.isReadOnly) {
    toast(t('forms.readOnly'), true);
    return;
  }
  const render = () => {
    const srcs = store.data.sources;
    const rules = store.data.rules;
    const srcRows = srcs
      .map((s) => {
        const n = store.data.events.filter((e) => e.sourceId === s.id).length;
        const when = s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        return `<div class="row static"><span class="tx"><b>${esc(s.name)}</b><span>${esc(t('forms.calendarSourceMeta', { kind: t(s.icsUrl ? 'forms.calendarLink' : 'forms.calendarFile'), count: n, when }))}</span>${s.lastError ? `<span class="err">${esc(s.lastError)}</span>` : ''}</span>${s.icsUrl ? `<button class="btn small" data-sync="${esc(s.id)}">${esc(t('forms.refresh'))}</button>` : ''}<button class="btn small danger" data-rm="${esc(s.id)}">${esc(t('forms.remove'))}</button></div>`;
      })
      .join('');
    const ruleRows = rules
      .map((r) => {
        const p = r.projectId === CHORES ? t('common.chores') : store.project(r.projectId)?.name ?? t('common.closedProject');
        return `<div class="task"><div class="tt"><b>${esc(t('forms.rule', { contains: r.contains, project: p }))}</b></div><div class="acts"><button class="iconbtn" data-rule="${esc(r.id)}" aria-label="${esc(t('forms.deleteRuleAria'))}">✕</button></div></div>`;
      })
      .join('');
    const groups = unclassifiedGroups(store.data.events);
    return `
      <p>${esc(t('forms.calendarIntro'))}</p>
      <div class="srcs rows">${srcRows || `<p class="empty">${esc(t('forms.calendarEmpty'))}</p>`}</div>
      <form data-f="url">
        <label class="field">${esc(t('forms.calendarUrl'))}<input name="url" type="url" inputmode="url" placeholder="https://…/basic.ics" autocomplete="off"></label>
        <label class="field">${esc(t('forms.calendarName'))}<input name="name" placeholder="${esc(t('forms.calendarNamePlaceholder'))}" autocomplete="off"></label>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn" data-file>${esc(t('forms.uploadIcs'))}</button><button class="btn primary">${esc(t('forms.subscribe'))}</button></div>
      </form>
      <p class="hint">${esc(t('forms.calendarProxyHint'))}</p>
      ${groups.length ? `<div class="btnrow"><button class="btn small" data-classify>${esc(t('forms.unclassifiedCount', { count: groups.length }))}</button></div>` : ''}
      <div class="sect">${esc(t('forms.rules'))} <small>${esc(t('forms.rulesCount', { count: rules.length }))}</small></div>
      ${ruleRows || `<p class="empty">${esc(t('forms.rulesEmpty'))}</p>`}`;
  };
  const mount = (box: HTMLElement, signal: AbortSignal) => {
    const context = store.captureWriteContext(signal);
    const rerender = () => {
      if (!context.isCurrent()) return;
      const body = box.querySelector('[data-cal]');
      if (body) {
        body.innerHTML = render();
        bind();
      }
    };
    const bind = () => {
      const form = box.querySelector<HTMLFormElement>('form[data-f="url"]')!;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!context.isCurrent()) return;
        const fd = new FormData(form);
        const btn = form.querySelector<HTMLButtonElement>('button.primary')!;
        btn.disabled = true;
        btn.textContent = t('forms.reading');
        try {
          const n = await addUrlSource(store, String(fd.get('name') ?? ''), String(fd.get('url') ?? ''), signal);
          if (!context.isCurrent()) return;
          toast(t('forms.connectSuccess', { count: n }));
          rerender();
          onImported();
        } catch (err) {
          if (!context.isCurrent()) return;
          toast(errMsg(err), true);
          btn.disabled = false;
          btn.textContent = t('forms.subscribe');
        }
      });
      box.querySelector('[data-file]')!.addEventListener('click', async () => {
        if (!context.isCurrent()) return;
        const f = await pickFile($('fileIcs') as HTMLInputElement);
        if (!f || !context.isCurrent()) return;
        try {
          const n = await addFileSource(store, f, signal);
          if (!context.isCurrent()) return;
          toast(t('forms.importSuccess', { count: n }));
          rerender();
          onImported();
        } catch (err) {
          if (!context.isCurrent()) return;
          toast(errMsg(err), true);
        }
      });
      box.querySelectorAll<HTMLElement>('[data-sync]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!context.isCurrent()) return;
          b.textContent = '…';
          try {
            const n = await syncSource(store, b.dataset.sync!, signal);
            if (!context.isCurrent()) return;
            toast(t('forms.refreshSuccess', { count: n }));
            onImported();
          } catch (err) {
            if (!context.isCurrent()) return;
            toast(errMsg(err), true);
          }
          rerender();
        }),
      );
      box.querySelectorAll<HTMLElement>('[data-rm]').forEach((b) =>
        b.addEventListener('click', () => {
          A.removeSource(store, b.dataset.rm!);
          rerender();
        }),
      );
      box.querySelectorAll<HTMLElement>('[data-rule]').forEach((b) =>
        b.addEventListener('click', () => {
          A.deleteRule(store, b.dataset.rule!);
          rerender();
        }),
      );
      box.querySelector('[data-classify]')?.addEventListener('click', () => openClassify(store));
    };
    bind();
  };
  openModal({ title: t('forms.calendarTitle'), body: `<div data-cal>${render()}</div>`, mount });
}

/** 事件归类：一次问一类，记下规则，以后同类自动归位 */
export function openClassify(store: Store, skipped = new Set<string>(), preferredTitle?: string) {
  const today = store.today();
  const groups = unclassifiedGroups(store.data.events).filter((g) => !skipped.has(g.title));
  if (!groups.length) {
    closeModal(false);
    toast(t('forms.classified'));
    return;
  }
  const preferredIndex = preferredTitle !== undefined ? groups.findIndex((group) => group.title === preferredTitle) : -1;
  // A card action names one concrete drift group. If a calendar refresh removed
  // it, do not silently classify an unrelated first group.
  if (preferredTitle !== undefined && preferredIndex < 0) return;
  const g = groups[preferredIndex >= 0 ? preferredIndex : 0];
  const next = g.events.find((e) => dateOfStamp(e.start) >= today) ?? g.events[g.events.length - 1];
  const ps = store.activeProjects();
  const kw = suggestKeyword(g.title);
  openModal({
    kick: t('forms.classifyKick', { count: groups.length }),
    title: t('forms.classifyTitle', { title: g.title }),
    body: `<p class="hint">${esc(t('forms.classifyMeta', { count: g.events.length, when: next ? `${t(dateOfStamp(next.start) >= today ? 'forms.nextTime' : 'forms.recentTime')} ${relDay(dateOfStamp(next.start), today)}` : '' }))}</p>
      <div class="rows" style="margin-top:8px">${ps.map((p) => `<button class="row" data-p="${esc(p.id)}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b></span></button>`).join('')}<button class="row" data-p=""><i class="sw" style="background:#8a8578"></i><span class="tx"><b>${esc(t('common.chores'))}</b><span>${esc(t('forms.choresDesc'))}</span></span></button></div>
      <label class="field inline"><input type="checkbox" name="rem" checked> ${esc(t('forms.rulePrefix'))}</label>
      <label class="field" style="margin-top:4px"><input name="kw" value="${esc(kw)}" autocomplete="off" aria-label="${esc(t('forms.ruleKeywordAria'))}"></label>
      <p class="hint">${esc(t('forms.ruleSuffix'))}</p>
      <div class="actions"><button class="btn" data-skip>${esc(t('forms.skip'))}</button></div>`,
    mount(box) {
      box.querySelectorAll<HTMLElement>('[data-p]').forEach((b) =>
        b.addEventListener('click', () => {
          const rem = box.querySelector<HTMLInputElement>('input[name=rem]')!.checked;
          const kwv = box.querySelector<HTMLInputElement>('input[name=kw]')!.value;
          A.classifyEvents(store, g.title, b.dataset.p ?? '', rem ? kwv : undefined);
          openClassify(store, skipped);
        }),
      );
      box.querySelector('[data-skip]')!.addEventListener('click', () => {
        skipped.add(g.title);
        openClassify(store, skipped);
      });
    },
  });
}

/** 设置：工作时段与外观 */
export function openSettings(store: Store, applyTheme: () => void) {
  const s = store.data.settings;
  openModal({
    title: t('forms.settingsTitle'),
    body: `<p class="hint">${esc(t('forms.granaryEquation'))}</p>
      <div style="display:flex;gap:10px"><label class="field" style="flex:1">${esc(t('forms.start'))}<input type="time" name="ws" value="${esc(s.workStart)}"></label><label class="field" style="flex:1">${esc(t('forms.end'))}<input type="time" name="we" value="${esc(s.workEnd)}"></label></div>
      <label class="field">${esc(t('forms.appearance'))}<select name="theme"><option value="auto"${s.theme === 'auto' ? ' selected' : ''}>${esc(t('forms.themeAuto'))}</option><option value="light"${s.theme === 'light' ? ' selected' : ''}>${esc(t('forms.themeLight'))}</option><option value="dark"${s.theme === 'dark' ? ' selected' : ''}>${esc(t('forms.themeDark'))}</option></select></label>
      <div class="actions"><button class="btn" data-close>${esc(t('forms.nevermind'))}</button><button class="btn primary" data-ok>${esc(t('common.save'))}</button></div>`,
    mount(box) {
      box.querySelector('[data-ok]')!.addEventListener('click', () => {
        const ws = box.querySelector<HTMLInputElement>('input[name=ws]')!.value || '09:00';
        const we = box.querySelector<HTMLInputElement>('input[name=we]')!.value || '18:00';
        if (we <= ws) {
          toast(t('forms.invalidHours'), true);
          return;
        }
        store.saveSettings({ workStart: ws, workEnd: we, theme: box.querySelector<HTMLSelectElement>('select[name=theme]')!.value as 'auto' | 'light' | 'dark' });
        applyTheme();
        closeModal(false);
      });
    },
  });
}

/** 第一次打开 */
export function openWelcome(handlers: { project(): void; demo(): void; calendar(): void }) {
  openModal({
    kick: t('forms.welcomeKick'),
    title: t('forms.welcomeTitle'),
    body: `<p>${esc(t('forms.welcomeBody'))}</p>
      <p class="hint">${esc(t('forms.welcomeHint'))}</p>
      <button class="opt" data-w="project"><b>${esc(t('forms.welcomeProject'))}</b><span>${esc(t('forms.welcomeProjectDesc'))}</span></button>
      <button class="opt" data-w="calendar"><b>${esc(t('forms.welcomeCalendar'))}</b><span>${esc(t('forms.welcomeCalendarDesc'))}</span></button>
      <button class="opt" data-w="demo"><b>${esc(t('forms.welcomeDemo'))}</b><span>${esc(t('forms.welcomeDemoDesc'))}</span></button>`,
    mount(box) {
      box.querySelectorAll<HTMLElement>('[data-w]').forEach((b) =>
        b.addEventListener('click', () => {
          closeModal(false);
          const w = b.dataset.w as 'project' | 'demo' | 'calendar';
          handlers[w]();
        }),
      );
    },
  });
}

/** 示例数据：几座处在不同阶段的村落。要么全部放好，要么一点不动 */
export function seedDemo(store: Store) {
  // 四座活跃村落，加上一座随后落成为地标的，同时最多占 5 个位置
  const free = MAX_VILLAGES - store.activeProjects().length;
  if (free < 5) {
    toast(t('forms.demoNoSpace', { count: Math.max(0, free) }), true);
    return;
  }
  try {
    store.batch(() => {
      const today = store.today();
      const back = (pid: string, days: number) => {
        const p = store.project(pid)!;
        const date = addDays(today, -days);
        store.put('projects', { ...p, createdAt: date });
        for (const op of store.data.operations) if (op.projectId === pid && op.kind === 'project-created') store.put('operations', { ...op, date });
        for (const c of store.data.chronicle) if (c.text === `岛上立起了新村落「${p.name}」。`) store.put('chronicle', { ...c, date });
      };
      const doneOn = (pid: string, title: string, date: ISODate) => {
        const t = A.createTask(store, { title, projectId: pid, scheduledFor: date });
        store.put('tasks', { ...store.taskRecord(t.id)!, createdAt: date });
        for (const op of store.data.operations) if (op.taskId === t.id && op.kind === 'task-created') store.put('operations', { ...op, date });
        return t;
      };

      const write = A.createProject(store, t('forms.demoBook'));
      back(write.id, 24);
      const team = A.createProject(store, t('forms.demoTeam'));
      back(team.id, 12);
      const move = A.createProject(store, t('forms.demoMove'));
      back(move.id, 34);
      const gym = A.createProject(store, t('forms.demoFitness'));
      back(gym.id, 10);

      const settled = new Map<ISODate, Map<string, A.Decision>>();
      const mark = (date: ISODate, id: string, d: A.Decision) => {
        if (!settled.has(date)) settled.set(date, new Map());
        settled.get(date)!.set(`task|${id}`, d);
      };
      // 写书：荒了两周多，最近四天认真推进
      for (let k = 4; k >= 1; k--) mark(addDays(today, -k), doneOn(write.id, t('forms.demoChapterDraft', { chapter: 5 - k }), addDays(today, -k)).id, { outcome: k === 2 ? 'partial' : 'done' });
      // 团队：前几天很忙，之后安静了几天
      for (let k = 11; k >= 9; k--) mark(addDays(today, -k), doneOn(team.id, [t('forms.demoRequirements'), t('forms.demoDesignSync'), t('forms.demoWeeklyReport')][11 - k], addDays(today, -k)).id, { outcome: 'done' });
      const tPost = doneOn(team.id, t('forms.demoQuarterReview'), addDays(today, -2));
      mark(addDays(today, -2), tPost.id, { outcome: 'skipped', reason: 'interrupted' });
      // 健身：没精力的几天不伤害村落
      mark(addDays(today, -3), doneOn(gym.id, t('forms.demoJog'), addDays(today, -3)).id, { outcome: 'skipped', reason: 'no_energy' });
      for (const [date, m] of [...settled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) A.settleDay(store, date, m);

    // 一个已经落成的项目：立在海岸上
      const photo = A.createProject(store, t('forms.demoPhotos'));
      back(photo.id, 40);
      for (let k = 0; k < 7; k++) {
        const d = addDays(today, -38 + k * 4);
        const t = doneOn(photo.id, [t('forms.demoScanAlbums'), t('forms.demoDeduplicate'), t('forms.demoSortByYear'), t('forms.demoAddNotes'), t('forms.demoPhotoBook'), t('forms.demoBackupDrive'), t('forms.demoShareFamily')][k], d);
        A.settleDay(store, d, new Map([[`task|${t.id}`, { outcome: 'done' }]]));
      }
      A.completeProject(store, photo.id, 'landmark');
      store.put('projects', { ...store.project(photo.id)!, doneAt: addDays(today, -10) });
      for (const op of store.data.operations) if (op.projectId === photo.id && op.kind === 'project-completed') store.put('operations', { ...op, date: addDays(today, -10) });
      for (const c of store.data.chronicle) if (c.kind === 'landmark' && c.text.includes(photo.name)) store.put('chronicle', { ...c, date: addDays(today, -10) });

      A.createTask(store, { title: t('forms.demoChapterDraft', { chapter: 5 }), projectId: write.id, scheduledFor: today });
      A.createTask(store, { title: t('forms.demoPublisherChat'), projectId: write.id });
      A.createTask(store, { title: t('forms.demoTeamMeeting'), projectId: team.id, scheduledFor: today });
      A.createTask(store, { title: t('forms.demoClientReply'), projectId: team.id, scheduledFor: today });
      A.rescheduleTask(store, tPost.id, today);
      A.createTask(store, { title: t('forms.demoMovingQuotes'), projectId: move.id, scheduledFor: addDays(today, -6) });
      A.createTask(store, { title: t('forms.demoPackShelf'), projectId: move.id });
      A.createTask(store, { title: t('forms.demoStrength'), projectId: gym.id, scheduledFor: today });
      A.createTask(store, { title: t('forms.demoDentist') });
      A.createTask(store, { title: t('forms.demoWeddingGift') });
      A.refreshStages(store);
    });
    toast(t('forms.demoDone'));
  } catch (e) {
    // Store.batch 已恢复数据和缓存；这里只显示业务错误。
    if (e instanceof A.ActionError) toast(e.message, true);
    else throw e;
  }
}
