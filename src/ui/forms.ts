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
    task: '新建 Todo',
    schedule: '新建日程',
    diary: '写日记',
    project: '新建项目',
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
      <div class="seg capture-tabs" role="group" aria-label="新建类型">
        <button type="button" data-k="task" class="${kind === 'task' ? 'on' : ''}" aria-pressed="${kind === 'task'}">Todo</button>
        <button type="button" data-k="schedule" class="${kind === 'schedule' ? 'on' : ''}" aria-pressed="${kind === 'schedule'}">日程</button>
        <button type="button" data-k="diary" class="${kind === 'diary' ? 'on' : ''}" aria-pressed="${kind === 'diary'}">日记</button>
        <button type="button" data-k="project" class="${kind === 'project' ? 'on' : ''}" aria-pressed="${kind === 'project'}">项目</button>
      </div>

      <form class="capture-form" data-f="task" ${kind === 'task' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">要做的事<input name="title" placeholder="例如：写完周报" autocomplete="off" ${kind === 'task' ? 'autofocus' : ''}></label>
          <div class="capture-meta">
            <label class="field">所属项目<select name="proj"><option value="">未指定 · 先停在码头</option>${projectOptions}</select></label>
            <label class="field">日期${dateSelect('date', today, { withNone: true, mode: 'task' })}</label>
          </div>
          <p class="hint">先记下来就好。未指定项目的 Todo 会乘船停在码头；真实推进并结算后，农田才会生长。</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">添加 Todo</button></div>
      </form>

      <form class="capture-form" data-f="schedule" ${kind === 'schedule' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">日程标题<input name="title" placeholder="例如：和设计对齐" autocomplete="off" ${kind === 'schedule' ? 'autofocus' : ''}></label>
          <label class="field">日期${dateSelect('date', today, { current: today, withNone: false, mode: 'schedule' })}</label>
          <div class="capture-time-grid">
            <label class="field">开始<input name="start" type="time" value="09:00"></label>
            <label class="field">结束<input name="end" type="time" value="10:00"></label>
          </div>
          <label class="field">所属项目<select name="proj"><option value="${CHORES}">杂务 / 生活</option>${projectOptions}</select></label>
          <p class="hint">计划本身不会让果园生长；日程真正经过现实并结算后，才会成为培育事实。</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">创建日程</button></div>
      </form>

      <form class="capture-form diary-form" data-f="diary" ${kind === 'diary' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="diary-date-row"><span>记录日期</span>${dateSelect('date', today, { current: diaryDate, withNone: false, mode: 'diary' })}</label>
          <label class="field diary-writing"><span class="sr-only">日记内容</span><textarea name="text" placeholder="发生了什么、想到什么、想记住什么……" ${kind === 'diary' ? 'autofocus' : ''}>${esc(diaryText)}</textarea></label>
          <p class="hint" data-diary-note>${diaryText ? '已恢复上次没有写完的内容。' : '日记不需要结算；写过日记的日子会让花园慢慢繁盛。'}</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>关闭</button><button class="btn primary">写下日记</button></div>
      </form>

      <form class="capture-form" data-f="project" ${kind === 'project' ? '' : 'hidden'}>
        <div class="capture-fields">
          <label class="field capture-primary">项目名<input name="name" placeholder="例如：团队、写书、搬家" autocomplete="off" ${kind === 'project' ? 'autofocus' : ''}></label>
          <p class="hint">项目会成为岛上的一座村落。立项后直接添加第一件要做的事，不需要额外经营村落。</p>
        </div>
        <div class="actions capture-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">立项并进入</button></div>
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
              toast(task.projectId ? `「${task.title}」住进了「${store.project(task.projectId)?.name}」` : `「${task.title}」乘船停在了码头`);
            } else if (form.dataset.f === 'schedule') {
              const date = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!) ?? today;
              const event = A.createSchedule(store, {
                title: String(fd.get('title') ?? ''),
                date,
                start: String(fd.get('start') ?? ''),
                end: String(fd.get('end') ?? ''),
                projectId: String(fd.get('proj') ?? CHORES),
              });
              toast(`日程「${event.title}」已经放进小岛的时间里`);
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
              toast(`${fmtDay(entry.date)}的日记写下来了，花园会记住它`);
            } else {
              const project = A.createProject(store, String(fd.get('name') ?? ''));
              toast(`岛上立起了新村落「${project.name}」`);
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
    toast('此页当前只读。请先接管写权限，再修改小岛。', true);
    return;
  }
  const render = () => {
    const srcs = store.data.sources;
    const rules = store.data.rules;
    const srcRows = srcs
      .map((s) => {
        const n = store.data.events.filter((e) => e.sourceId === s.id).length;
        const when = s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        return `<div class="row static"><span class="tx"><b>${esc(s.name)}</b><span>${s.icsUrl ? '订阅链接' : '上传的文件'} · ${n} 个事件 · 更新于 ${when}</span>${s.lastError ? `<span class="err">${esc(s.lastError)}</span>` : ''}</span>${s.icsUrl ? `<button class="btn small" data-sync="${esc(s.id)}">刷新</button>` : ''}<button class="btn small danger" data-rm="${esc(s.id)}">移除</button></div>`;
      })
      .join('');
    const ruleRows = rules
      .map((r) => {
        const p = r.projectId === CHORES ? '杂务' : store.project(r.projectId)?.name ?? '已关闭的项目';
        return `<div class="task"><div class="tt"><b>标题包含「${esc(r.contains)}」→ ${esc(p)}</b></div><div class="acts"><button class="iconbtn" data-rule="${esc(r.id)}" aria-label="删除规则">✕</button></div></div>`;
      })
      .join('');
    const groups = unclassifiedGroups(store.data.events);
    return `
      <p>日历告诉小岛时间花在了哪里，决定村落热闹还是冷清。Apple、Google、Outlook 都能导出 .ics 订阅链接。只读，不会改动你的日历。</p>
      <div class="srcs rows">${srcRows || '<p class="empty">还没有接入日历。</p>'}</div>
      <form data-f="url">
        <label class="field">订阅链接（.ics / webcal://）<input name="url" type="url" inputmode="url" placeholder="https://…/basic.ics" autocomplete="off"></label>
        <label class="field">名字（可不填）<input name="name" placeholder="例如：工作日历" autocomplete="off"></label>
        <div class="actions" style="justify-content:space-between"><button type="button" class="btn" data-file>上传 .ics 文件</button><button class="btn primary">订阅</button></div>
      </form>
      <p class="hint">浏览器不能直接读取别人的 .ics 链接，小岛会通过一个只做转发的 Cloudflare Worker 去取，Worker 不保存任何数据。</p>
      ${groups.length ? `<div class="btnrow"><button class="btn small" data-classify>${groups.length} 类事件待归类 ›</button></div>` : ''}
      <div class="sect">归类规则 <small>${rules.length} 条</small></div>
      ${ruleRows || '<p class="empty">第一次遇到一类事件时，你指定一次归属，这里就会多一条规则。</p>'}`;
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
        btn.textContent = '正在读取…';
        try {
          const n = await addUrlSource(store, String(fd.get('name') ?? ''), String(fd.get('url') ?? ''), signal);
          if (!context.isCurrent()) return;
          toast(`接入成功，读到 ${n} 个事件`);
          rerender();
          onImported();
        } catch (err) {
          if (!context.isCurrent()) return;
          toast(errMsg(err), true);
          btn.disabled = false;
          btn.textContent = '订阅';
        }
      });
      box.querySelector('[data-file]')!.addEventListener('click', async () => {
        if (!context.isCurrent()) return;
        const f = await pickFile($('fileIcs') as HTMLInputElement);
        if (!f || !context.isCurrent()) return;
        try {
          const n = await addFileSource(store, f, signal);
          if (!context.isCurrent()) return;
          toast(`导入了 ${n} 个事件`);
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
            toast(`刷新完成，${n} 个事件`);
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
  openModal({ title: '日历', body: `<div data-cal>${render()}</div>`, mount });
}

/** 事件归类：一次问一类，记下规则，以后同类自动归位 */
export function openClassify(store: Store, skipped = new Set<string>(), preferredTitle?: string) {
  const today = store.today();
  const groups = unclassifiedGroups(store.data.events).filter((g) => !skipped.has(g.title));
  if (!groups.length) {
    closeModal(false);
    toast('日历事件都归好类了');
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
    kick: `日历事件归类 · 还有 ${groups.length} 类`,
    title: `「${g.title}」属于哪里？`,
    body: `<p class="hint">${g.events.length} 次 · ${next ? `${dateOfStamp(next.start) >= today ? '下一次' : '最近一次'}在${relDay(dateOfStamp(next.start), today)}` : ''}</p>
      <div class="rows" style="margin-top:8px">${ps.map((p) => `<button class="row" data-p="${esc(p.id)}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b></span></button>`).join('')}<button class="row" data-p=""><i class="sw" style="background:#8a8578"></i><span class="tx"><b>杂务</b><span>不属于任何项目</span></span></button></div>
      <label class="field inline"><input type="checkbox" name="rem" checked> 以后标题包含</label>
      <label class="field" style="margin-top:4px"><input name="kw" value="${esc(kw)}" autocomplete="off" aria-label="规则关键词"></label>
      <p class="hint">的事件都自动归到这里。</p>
      <div class="actions"><button class="btn" data-skip>先跳过</button></div>`,
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
    title: '工作时段与外观',
    body: `<p class="hint">粮仓 = 工作时段 − 日历上已排的时间。</p>
      <div style="display:flex;gap:10px"><label class="field" style="flex:1">开始<input type="time" name="ws" value="${esc(s.workStart)}"></label><label class="field" style="flex:1">结束<input type="time" name="we" value="${esc(s.workEnd)}"></label></div>
      <label class="field">外观<select name="theme"><option value="auto"${s.theme === 'auto' ? ' selected' : ''}>跟随系统</option><option value="light"${s.theme === 'light' ? ' selected' : ''}>亮色</option><option value="dark"${s.theme === 'dark' ? ' selected' : ''}>暗色</option></select></label>
      <div class="actions"><button class="btn" data-close>算了</button><button class="btn primary" data-ok>保存</button></div>`,
    mount(box) {
      box.querySelector('[data-ok]')!.addEventListener('click', () => {
        const ws = box.querySelector<HTMLInputElement>('input[name=ws]')!.value || '09:00';
        const we = box.querySelector<HTMLInputElement>('input[name=we]')!.value || '18:00';
        if (we <= ws) {
          toast('结束时间要晚于开始时间', true);
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
    kick: '欢迎',
    title: '这是一座由你的日子长成的岛',
    body: `<p>每个项目是一座村落；Todo、日程、日记和真实结算会继续长成岛上的村落、农田、果园、鱼塘和花园。</p>
      <p class="hint">你不需要浇水、喂鱼或施肥。只记录本来就在发生的生活，小岛负责把它映射成生长。</p>
      <button class="opt" data-w="project"><b>建第一座村落</b><span>从一个正在做的项目开始</span></button>
      <button class="opt" data-w="calendar"><b>接入日历</b><span>粘贴 .ics 订阅链接，或上传 .ics 文件</span></button>
      <button class="opt" data-w="demo"><b>先看看示例</b><span>放几个示例村落，感受一下衰败和恢复（之后可以关闭它们）</span></button>`,
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
    toast(`放示例需要 5 个空位，岛上现在只空着 ${Math.max(0, free)} 个。先关闭几个村落吧。`, true);
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

      const write = A.createProject(store, '写一本小书');
      back(write.id, 24);
      const team = A.createProject(store, '团队');
      back(team.id, 12);
      const move = A.createProject(store, '搬家');
      back(move.id, 34);
      const gym = A.createProject(store, '健身');
      back(gym.id, 10);

      const settled = new Map<ISODate, Map<string, A.Decision>>();
      const mark = (date: ISODate, id: string, d: A.Decision) => {
        if (!settled.has(date)) settled.set(date, new Map());
        settled.get(date)!.set(`task|${id}`, d);
      };
      // 写书：荒了两周多，最近四天认真推进
      for (let k = 4; k >= 1; k--) mark(addDays(today, -k), doneOn(write.id, `第 ${5 - k} 章初稿`, addDays(today, -k)).id, { outcome: k === 2 ? 'partial' : 'done' });
      // 团队：前几天很忙，之后安静了几天
      for (let k = 11; k >= 9; k--) mark(addDays(today, -k), doneOn(team.id, ['整理需求', '和设计对齐', '写周报'][11 - k], addDays(today, -k)).id, { outcome: 'done' });
      const tPost = doneOn(team.id, '季度复盘', addDays(today, -2));
      mark(addDays(today, -2), tPost.id, { outcome: 'skipped', reason: 'interrupted' });
      // 健身：没精力的几天不伤害村落
      mark(addDays(today, -3), doneOn(gym.id, '慢跑 3 公里', addDays(today, -3)).id, { outcome: 'skipped', reason: 'no_energy' });
      for (const [date, m] of [...settled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) A.settleDay(store, date, m);

    // 一个已经落成的项目：立在海岸上
      const photo = A.createProject(store, '整理旧照片');
      back(photo.id, 40);
      for (let k = 0; k < 7; k++) {
        const d = addDays(today, -38 + k * 4);
        const t = doneOn(photo.id, ['扫描相册', '去重', '按年份归档', '补写说明', '做一本电子相册', '备份到硬盘', '分享给家人'][k], d);
        A.settleDay(store, d, new Map([[`task|${t.id}`, { outcome: 'done' }]]));
      }
      A.completeProject(store, photo.id, 'landmark');
      store.put('projects', { ...store.project(photo.id)!, doneAt: addDays(today, -10) });
      for (const op of store.data.operations) if (op.projectId === photo.id && op.kind === 'project-completed') store.put('operations', { ...op, date: addDays(today, -10) });
      for (const c of store.data.chronicle) if (c.kind === 'landmark' && c.text.includes('整理旧照片')) store.put('chronicle', { ...c, date: addDays(today, -10) });

      A.createTask(store, { title: '第 5 章初稿', projectId: write.id, scheduledFor: today });
      A.createTask(store, { title: '找出版社聊聊', projectId: write.id });
      A.createTask(store, { title: '准备周会', projectId: team.id, scheduledFor: today });
      A.createTask(store, { title: '回复客户邮件', projectId: team.id, scheduledFor: today });
      A.rescheduleTask(store, tPost.id, today);
      A.createTask(store, { title: '比价搬家公司', projectId: move.id, scheduledFor: addDays(today, -6) });
      A.createTask(store, { title: '打包书架', projectId: move.id });
      A.createTask(store, { title: '力量训练', projectId: gym.id, scheduledFor: today });
      A.createTask(store, { title: '预约牙医' });
      A.createTask(store, { title: '朋友婚礼的礼物' });
      A.refreshStages(store);
    });
    toast('放好了四座示例村落');
  } catch (e) {
    // Store.batch 已恢复数据和缓存；这里只显示业务错误。
    if (e instanceof A.ActionError) toast(e.message, true);
    else throw e;
  }
}
