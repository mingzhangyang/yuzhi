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
import { addDays, dateOfStamp, relDay } from '../lib/date';
import { roofOf } from './scene';
import { MAX_VILLAGES } from '../logic/config';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 新建：项目（村落）或任务 */
export function openNew(store: Store, kind: 'task' | 'project' = 'task', onProject?: (id: string) => void) {
  const today = store.today();
  const ps = store.activeProjects();
  const body = `
    <div class="seg" role="tablist"><button data-k="task" class="${kind === 'task' ? 'on' : ''}">任务</button><button data-k="project" class="${kind === 'project' ? 'on' : ''}">项目（村落）</button></div>
    <form data-f="task" ${kind === 'task' ? '' : 'hidden'}>
      <label class="field">要做的事<input name="title" placeholder="例如：写完周报" autocomplete="off" ${kind === 'task' ? 'autofocus' : ''}></label>
      <label class="field">住进哪个村落<select name="proj"><option value="">先停在码头</option>${ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field">哪天做<select name="date"><option value="${today}">今天</option><option value="${addDays(today, 1)}">明天</option><option value="${addDays(today, 2)}">后天</option><option value="">不定日期</option></select></label>
      <p class="hint">停在码头的任务不会出现在结算里，等你安排。</p>
      <div class="actions"><button type="button" class="btn" data-close>算了</button><button class="btn primary">添加</button></div>
    </form>
    <form data-f="project" ${kind === 'project' ? '' : 'hidden'}>
      <label class="field">项目名<input name="name" placeholder="例如：团队、写书、搬家" autocomplete="off" ${kind === 'project' ? 'autofocus' : ''}></label>
      <p class="hint">一个项目是岛上的一座村落。做完的事会变成砖，村落慢慢长大；很久不动，村落会安静、蒙灰。</p>
      <div class="actions"><button type="button" class="btn" data-close>算了</button><button class="btn primary">立项</button></div>
    </form>`;
  openModal({
    title: '新建',
    body,
    mount(box) {
      box.querySelectorAll<HTMLElement>('[data-k]').forEach((b) =>
        b.addEventListener('click', () => {
          box.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('on', x === b));
          box.querySelectorAll<HTMLFormElement>('form[data-f]').forEach((f) => (f.hidden = f.dataset.f !== b.dataset.k));
          box.querySelector<HTMLInputElement>(`form[data-f="${b.dataset.k}"] input`)!.focus();
        }),
      );
      box.querySelectorAll<HTMLFormElement>('form[data-f]').forEach((f) =>
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          const fd = new FormData(f);
          try {
            if (f.dataset.f === 'task') {
              const pid = String(fd.get('proj') ?? '');
              const t = A.createTask(store, { title: String(fd.get('title') ?? ''), projectId: pid || undefined, scheduledFor: String(fd.get('date') ?? '') || undefined });
              toast(t.projectId ? `「${t.title}」住进了「${store.project(t.projectId)?.name}」` : `「${t.title}」乘船停在了码头`);
            } else {
              const p = A.createProject(store, String(fd.get('name') ?? ''));
              toast(`岛上立起了新村落「${p.name}」`);
              onProject?.(p.id);
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
  const render = () => {
    const srcs = store.data.sources;
    const rules = store.data.rules;
    const srcRows = srcs
      .map((s) => {
        const n = store.data.events.filter((e) => e.sourceId === s.id).length;
        const when = s.lastFetchedAt ? new Date(s.lastFetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
        return `<div class="row static"><span class="tx"><b>${esc(s.name)}</b><span>${s.icsUrl ? '订阅链接' : '上传的文件'} · ${n} 个事件 · 更新于 ${when}</span>${s.lastError ? `<span class="err">${esc(s.lastError)}</span>` : ''}</span>${s.icsUrl ? `<button class="btn small" data-sync="${s.id}">刷新</button>` : ''}<button class="btn small danger" data-rm="${s.id}">移除</button></div>`;
      })
      .join('');
    const ruleRows = rules
      .map((r) => {
        const p = r.projectId === CHORES ? '杂务' : store.project(r.projectId)?.name ?? '已关闭的项目';
        return `<div class="task"><div class="tt"><b>标题包含「${esc(r.contains)}」→ ${esc(p)}</b></div><div class="acts"><button class="iconbtn" data-rule="${r.id}" aria-label="删除规则">✕</button></div></div>`;
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
export function openClassify(store: Store, skipped = new Set<string>()) {
  const today = store.today();
  const groups = unclassifiedGroups(store.data.events).filter((g) => !skipped.has(g.title));
  if (!groups.length) {
    closeModal(false);
    toast('日历事件都归好类了');
    return;
  }
  const g = groups[0];
  const next = g.events.find((e) => dateOfStamp(e.start) >= today) ?? g.events[g.events.length - 1];
  const ps = store.activeProjects();
  const kw = suggestKeyword(g.title);
  openModal({
    kick: `日历事件归类 · 还有 ${groups.length} 类`,
    title: `「${g.title}」属于哪里？`,
    body: `<p class="hint">${g.events.length} 次 · ${next ? `${dateOfStamp(next.start) >= today ? '下一次' : '最近一次'}在${relDay(dateOfStamp(next.start), today)}` : ''}</p>
      <div class="rows" style="margin-top:8px">${ps.map((p) => `<button class="row" data-p="${p.id}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b></span></button>`).join('')}<button class="row" data-p=""><i class="sw" style="background:#8a8578"></i><span class="tx"><b>杂务</b><span>不属于任何项目</span></span></button></div>
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
    body: `<p>每个项目是一座村落，每件没做完的事是住在里面的一个小人。新任务先停在码头，晚上结算时确认今天做了什么，小岛据此变化，编年史自动写下一行。</p>
      <p class="hint">输入不会比普通待办 App 多：你只管建项目、加任务、晚上滑一滑。</p>
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
