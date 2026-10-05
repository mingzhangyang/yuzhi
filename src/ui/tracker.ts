/**
 * 右侧追踪栏：点开任何项目或任务，看它的一生之书。
 * 也承载码头、粮仓、杂务这些地图上能点的地方。
 */
import type { Store } from '../store';
import type { ISODate, LifeEntry, Project } from '../types';
import { CHORES, LOCAL_CALENDAR_SOURCE_ID } from '../types';
import { $, esc, setHTML, setText, toast } from './dom';
import { closeModal, confirmModal, openModal } from './modal';
import { roofOf, houseCount } from './scene';
import * as A from '../actions';
import { STAGE_NAMES } from '../logic/config';
import { addDays, dateOfStamp, diffDays, fmtDay, relDay } from '../lib/date';
import { backlog, granary } from '../logic/metrics';
import { unclassifiedGroups } from '../logic/classify';
import { summarize } from '../logic/summary';
import { compareLifeEntries, lifeEntries } from '../logic/operations';
import { diaryLatestSnapshot, diaryVersions, lifeBookEntries, lifeBookSubjectIds, scheduleLatestSnapshot, scheduleVersions } from '../logic/life-book';
import { stageLifeEntries } from '../logic/decay';
import { interruptions, lastProgressAt, type TaskView } from '../logic/read-model';
import { summaryHTML } from './ceremony';
import { cultivationAreas, cultivationState } from '../logic/cultivation';
import { bindDateSelects, dateSelect, readDate } from './date-select';

export type View =
  | { kind: 'overview' }
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'dock' }
  | { kind: 'granary' }
  | { kind: 'chores' }
  | { kind: 'diaries' }
  | { kind: 'diary'; id: string }
  | { kind: 'schedules' }
  | { kind: 'schedule'; id: string }
  | { kind: 'archive' };

export interface TrackerHooks {
  openNew(kind: 'project' | 'diary' | 'schedule'): void;
  openClassify(): void;
  openPrompt(p: Project): void;
  openSettings(): void;
  openCeremony(p: Project): void;
  onViewChange(v: View): void;
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function emblem(color: string, stage: number) {
  const roof = stage >= 2 ? '#9a9588' : color;
  return `<svg viewBox="0 0 50 50" aria-hidden="true"><rect width="50" height="50" fill="${color}22"/><path d="M8 34 25 26l17 8-17 8z" fill="#93b65a"/><path d="M17 34v-8l8-4 8 4v8l-8 4z" fill="#efe5cf"/><path d="M15 27 25 16l10 11-10-5z" fill="${roof}"/><rect x="27" y="29" width="3" height="5" fill="#6b5240"/></svg>`;
}

function lifeList(entries: LifeEntry[], today: ISODate, limit = 60) {
  if (!entries.length) return '<p class="empty">还没有记录。</p>';
  const rows = entries
    .slice()
    .sort((a, b) => compareLifeEntries(b, a))
    .slice(0, limit)
    .map((e) => `<li class="k-${e.kind}"><time>${esc(relDay(e.date, today))}</time><span>${esc(e.text)}</span></li>`)
    .join('');
  return `<ol class="life">${rows}</ol>`;
}

export class Tracker {
  view: View = { kind: 'overview' };
  private body = $('trackerBody');
  private hist: View[] = [];

  constructor(private store: Store, private hooks: TrackerHooks) {
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('submit', (e) => this.onSubmit(e));
    $('sheetHandle').addEventListener('click', () => $('tracker').classList.toggle('open'));
  }

  open(v: View, push = true) {
    if (push && JSON.stringify(v) !== JSON.stringify(this.view)) this.hist.push(this.view);
    if (this.hist.length > 20) this.hist.shift();
    this.view = v;
    this.render();
    this.body.parentElement!.scrollTop = 0;
    $('tracker').classList.add('open');
    this.hooks.onViewChange(v);
  }

  back() {
    const v = this.hist.pop() ?? { kind: 'overview' };
    this.view = v;
    this.render();
    this.hooks.onViewChange(v);
  }

  render() {
    const s = this.store;
    let v = this.view;
    if (v.kind === 'project' && !s.project(v.id)) v = this.view = { kind: 'overview' };
    if (v.kind === 'task' && !s.task(v.id)) v = this.view = { kind: 'overview' };
    let html = '';
    let title = '';
    let sub = '';
    switch (v.kind) {
      case 'overview':
        [html, title, sub] = this.overview();
        break;
      case 'project':
        [html, title, sub] = this.project(s.project(v.id)!);
        break;
      case 'task':
        [html, title, sub] = this.task(s.task(v.id)!);
        break;
      case 'dock':
        [html, title, sub] = this.dock();
        break;
      case 'granary':
        [html, title, sub] = this.granary();
        break;
      case 'chores':
        [html, title, sub] = this.chores();
        break;
      case 'diaries':
        [html, title, sub] = this.diaries();
        break;
      case 'diary':
        [html, title, sub] = this.diary(v.id);
        break;
      case 'schedules':
        [html, title, sub] = this.schedules();
        break;
      case 'schedule':
        [html, title, sub] = this.schedule(v.id);
        break;
      case 'archive':
        [html, title, sub] = this.archive();
        break;
    }
    const focused = document.activeElement as HTMLInputElement | null;
    const keep = focused && this.body.contains(focused) && focused.name ? { name: focused.name, value: focused.value, pos: focused.selectionStart } : null;
    setHTML(this.body, html);
    if (keep) {
      const el = this.body.querySelector<HTMLInputElement>(`[name="${keep.name}"]`);
      if (el && el !== focused) {
        el.value = keep.value;
        el.focus();
        if (keep.pos != null && 'setSelectionRange' in el) el.setSelectionRange(keep.pos, keep.pos);
      }
    }
    bindDateSelects(this.body, s.today());
    setText($('sheetTitle'), title);
    setText($('sheetSub'), sub);
  }

  /* ---------------- 视图 ---------------- */

  private back$(label = '总览') {
    return `<button class="backlink" data-act="back">‹ ${esc(label)}</button>`;
  }

  private overview(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const ps = s.activeProjects();
    const vs = s.villages();
    const b = backlog(s.data, today);
    const projOpts = ps.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const rows = ps
      .map((p) => {
        const v = vs.get(p.id)!;
        const open = s.tasks().filter((t) => t.projectId === p.id && t.status === 'open').length;
        const progressAt = lastProgressAt(s.data, p.id);
        const since = progressAt ? `距上次推进 ${diffDays(progressAt, today)} 天` : `立项 ${diffDays(p.createdAt, today)} 天，还没推进`;
        return `<button class="row" data-act="project" data-id="${esc(p.id)}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b><span>${open} 件未完成 · ${since}</span></span><span class="chip ${v.stage ? 'warn' : 'ok'}">${STAGE_NAMES[v.stage]}</span></button>`;
      })
      .join('');
    const groups = unclassifiedGroups(s.data.events);
    const cultivated = cultivationAreas(cultivationState(s.data, today));
    const cultivationRows = cultivated
      .map((area) => `<div class="row static"><span class="tx"><b>${esc(area.name)} · 长势 ${area.level}/4</b><span>${esc(area.summary)}</span></span></div>`)
      .join('');
    const diaries = s.data.diaries
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const localSchedules = s.data.events
      .filter((event) => event.sourceId === LOCAL_CALENDAR_SOURCE_ID)
      .slice()
      .sort((a, b) => b.start.localeCompare(a.start));
    const latestDiary = diaries[0];
    const nextSchedule = localSchedules
      .filter((event) => dateOfStamp(event.start) >= today)
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? localSchedules[0];
    const html = `
      <div class="ptitle">小岛总览 <small>${ps.length} 个村落</small></div>
      <form class="add" data-form="quick"><input name="quick" placeholder="添加一件事…" autocomplete="off" aria-label="新任务"><select name="qproj" aria-label="住进哪个村落"><option value="">停在码头</option>${projOpts}</select><button class="btn primary">添加</button></form>
      <p class="hint">不选村落的任务会先乘船停在码头，等你安排。</p>
      <div class="sect">村落 <button class="linkbtn" data-act="new-project">＋ 新村落</button></div>
      <div class="rows">${rows || '<p class="empty">岛上还没有村落。建一个项目，它就是第一座村落；也可以在「⋯」里放几个示例村落。</p>'}</div>
      <div class="sect">培育区 <small>现实生活自动映射</small></div>
      <div class="rows">${cultivationRows}</div>
      <div class="sect">现实输入 <small>可回看与管理</small></div>
      <button class="row" data-act="diaries"><i class="sw" style="background:#9b78a8"></i><span class="tx"><b>日记 · ${diaries.length} 篇</b><span>${latestDiary ? `${fmtDay(latestDiary.date)} · ${esc(latestDiary.text.length > 46 ? latestDiary.text.slice(0, 45) + '…' : latestDiary.text)}` : '把经历、感受和线索写下来'}</span></span><span class="end">›</span></button>
      <button class="row" data-act="schedules"><i class="sw" style="background:#7397a7"></i><span class="tx"><b>本地日程 · ${localSchedules.length} 条</b><span>${nextSchedule ? `${relDay(dateOfStamp(nextSchedule.start), today)} ${timeOf(nextSchedule.start)} · ${esc(nextSchedule.title)}` : '自己创建的日程会进入日历与结算'}</span></span><span class="end">›</span></button>
      <div class="sect">码头 <small>${b.dock} 船待安排 · ${b.overdue} 件过期</small></div>
      <button class="row" data-act="dock"><i class="sw" style="background:#a8794a"></i><span class="tx"><b>${b.dock ? `${b.dock} 条船停在码头` : '码头空着'}</b><span>${b.dock ? '决定它们住进哪个村落、排在哪天，或者婉拒' : '新任务会先停在这里'}</span></span><span class="end">›</span></button>
      ${this.coastRow()}
      ${groups.length ? `<div class="sect">日历 <small>${groups.length} 类事件待归类</small></div><button class="row" data-act="classify"><i class="sw" style="background:var(--dusk)"></i><span class="tx"><b>有新的日历事件不知道归哪</b><span>指定一次，以后同类自动归位</span></span><span class="end">›</span></button>` : ''}
    `;
    return [html, '小岛总览', `${ps.length} 个村落 · 码头 ${b.dock} 船`];
  }

  private diaries(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const entries = s.data.diaries
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const currentIds = new Set(entries.map((entry) => entry.id));
    const deletedIds = lifeBookSubjectIds(s.data, 'diary').filter((id) => !currentIds.has(id));
    const rows = entries
      .map((entry) => `<div class="task"><div class="tt" data-act="diary" data-id="${esc(entry.id)}"><b>${esc(relDay(entry.date, today))} · ${esc(fmtDay(entry.date))}</b><span>${esc(entry.text.length > 100 ? entry.text.slice(0, 99) + '…' : entry.text)}</span></div><div class="acts"><span class="chip">${diaryVersions(s.data, entry.id).length} 版</span><button class="iconbtn" data-act="delete-diary" data-id="${esc(entry.id)}" title="删除日记" aria-label="删除 ${esc(fmtDay(entry.date))} 的日记">✕</button></div></div>`)
      .join('');
    const deletedRows = deletedIds
      .map((id) => {
        const snapshot = diaryLatestSnapshot(s.data, id);
        if (!snapshot) return '';
        return `<div class="task history-record"><div class="tt" data-act="diary" data-id="${esc(id)}"><b>${esc(fmtDay(snapshot.date))}</b><span>${esc(snapshot.text.length > 100 ? snapshot.text.slice(0, 99) + '…' : snapshot.text)}</span></div><div class="acts"><span class="chip">已删除 · 历史保留</span></div></div>`;
      })
      .join('');
    return [
      `${this.back$()}<div class="ptitle">日记 <button class="linkbtn" data-act="new-diary">＋ 写日记</button></div><p class="hint">每篇日记都有自己的一生之书和版本历史。删除正文后，历史仍会留在这里。</p><div class="rows">${rows || '<p class="empty">还没有日记。写下今天发生的事，花园就会记住它。</p>'}</div>${deletedRows ? `<div class="sect">已删除的日记 <small>${deletedIds.length}</small></div><div class="rows">${deletedRows}</div>` : ''}`,
      '日记',
      `${entries.length} 篇 · ${deletedIds.length} 篇历史归档`,
    ];
  }

  private diary(id: string): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const current = s.data.diaries.find((entry) => entry.id === id);
    const snapshot = diaryLatestSnapshot(s.data, id);
    if (!snapshot) return [`${this.back$('日记')}<p class="empty">这篇日记没有可读的历史。</p>`, '日记', '历史不可用'];
    const versions = diaryVersions(s.data, id);
    const life = lifeBookEntries(s.data, { type: 'diary', id });
    const versionRows = versions
      .slice()
      .reverse()
      .map((version, index) => {
        const label = version.kind === 'created' ? '初版' : `修订 ${versions.length - index - 1}`;
        return `<details class="revision"><summary>${label} · ${esc(fmtDay(version.recordedOn))}<span>${esc(fmtDay(version.snapshot.date))} 的记录</span></summary><div class="revision-body">${esc(version.snapshot.text).replace(/\n/g, '<br>')}</div></details>`;
      })
      .join('');
    const html = `
      ${this.back$('日记')}
      <div class="who"><div class="emblem" style="background:#9b78a822">✎</div><div><div class="fname">${esc(fmtDay(snapshot.date))} 的日记</div><div class="fmeta">${current ? '正文仍在花园里' : '正文已删除 · 一生之书保留'} · ${versions.length} 个版本</div></div></div>
      <div class="chips"><span class="chip ${current ? 'ok' : 'warn'}">${current ? '当前日记' : '已删除'}</span><span class="chip">${life.length} 条历史</span></div>
      <div class="journal-body">${esc(snapshot.text).replace(/\n/g, '<br>')}</div>
      ${current ? `<div class="btnrow"><button class="btn small primary" data-act="edit-diary" data-id="${esc(id)}">编辑</button><button class="btn small danger" data-act="delete-diary" data-id="${esc(id)}">删除正文</button></div>` : ''}
      <div class="sect">版本历史 <small>${versions.length}</small></div>
      ${versionRows || '<p class="empty">还没有版本快照。</p>'}
      <div class="sect">一生之书 <small>${life.length}</small></div>
      ${lifeList(life, today)}`;
    return [html, '日记的一生之书', current ? fmtDay(snapshot.date) : '已删除 · 历史保留'];
  }

  private schedules(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const settledIds = new Set(
      s.data.entries.filter((entry) => entry.itemType === 'event').map((entry) => entry.itemId),
    );
    const events = s.data.events
      .filter((event) => event.sourceId === LOCAL_CALENDAR_SOURCE_ID)
      .slice()
      .sort((a, b) => b.start.localeCompare(a.start));
    const currentIds = new Set(events.map((event) => event.id));
    const deletedIds = lifeBookSubjectIds(s.data, 'schedule').filter((id) => !currentIds.has(id));
    const rows = events
      .map((event) => {
        const date = dateOfStamp(event.start);
        const settled = settledIds.has(event.id);
        const where = event.projectId === CHORES
          ? '杂务 / 生活'
          : event.projectId
            ? s.project(event.projectId)?.name ?? '已关闭的项目'
            : '未归类';
        const history = settled
          ? '<span class="chip">已留入历史</span>'
          : `<button class="iconbtn" data-act="delete-schedule" data-id="${esc(event.id)}" title="删除日程" aria-label="删除日程 ${esc(event.title)}">✕</button>`;
        return `<div class="task"><div class="tt" data-act="schedule" data-id="${esc(event.id)}"><b>${esc(event.title)}</b><span>${esc(relDay(date, today))} · ${timeOf(event.start)}–${timeOf(event.end)} · ${esc(where)}</span></div><div class="acts"><span class="chip">${scheduleVersions(s.data, event.id).length} 版</span>${history}</div></div>`;
      })
      .join('');
    const deletedRows = deletedIds
      .map((id) => {
        const snapshot = scheduleLatestSnapshot(s.data, id);
        if (!snapshot) return '';
        return `<div class="task history-record"><div class="tt" data-act="schedule" data-id="${esc(id)}"><b>${esc(snapshot.title)}</b><span>${esc(fmtDay(snapshot.date))} · ${esc(snapshot.start)}–${esc(snapshot.end)}</span></div><div class="acts"><span class="chip">已删除 · 历史保留</span></div></div>`;
      })
      .join('');
    return [
      `${this.back$()}<div class="ptitle">本地日程 <button class="linkbtn" data-act="new-schedule">＋ 日程</button></div><p class="hint">本地日程的创建、修改、结算和删除都进入同一本一生之书。</p><div class="rows">${rows || '<p class="empty">还没有自己创建的日程。添加一个安排，它会进入日历与结算。</p>'}</div>${deletedRows ? `<div class="sect">已删除的日程 <small>${deletedIds.length}</small></div><div class="rows">${deletedRows}</div>` : ''}`,
      '本地日程',
      `${events.length} 条 · ${deletedIds.length} 条历史归档`,
    ];
  }

  private schedule(id: string): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const current = s.data.events.find((event) => event.id === id && event.sourceId === LOCAL_CALENDAR_SOURCE_ID);
    const snapshot = scheduleLatestSnapshot(s.data, id);
    if (!snapshot) return [`${this.back$('本地日程')}<p class="empty">这条日程没有可读的历史。</p>`, '日程', '历史不可用'];
    const versions = scheduleVersions(s.data, id);
    const life = lifeBookEntries(s.data, { type: 'schedule', id });
    const settled = s.data.entries.some((entry) => entry.itemType === 'event' && entry.itemId === id);
    const where = snapshot.projectId === CHORES
      ? '杂务 / 生活'
      : snapshot.projectId
        ? s.project(snapshot.projectId)?.name ?? '已关闭的项目'
        : '未归类';
    const versionRows = versions
      .slice()
      .reverse()
      .map((version, index) => {
        const label = version.kind === 'created' ? '初版' : `修订 ${versions.length - index - 1}`;
        const v = version.snapshot;
        return `<details class="revision"><summary>${label} · ${esc(fmtDay(version.recordedOn))}<span>${esc(fmtDay(v.date))} ${esc(v.start)}–${esc(v.end)}</span></summary><div class="revision-body"><b>${esc(v.title)}</b><br>${esc(v.projectId === CHORES ? '杂务 / 生活' : s.project(v.projectId)?.name ?? '未归类')}</div></details>`;
      })
      .join('');
    const html = `
      ${this.back$('本地日程')}
      <div class="who"><div class="emblem" style="background:#7397a722">◷</div><div><div class="fname">${esc(snapshot.title)}</div><div class="fmeta">${esc(fmtDay(snapshot.date))} · ${esc(snapshot.start)}–${esc(snapshot.end)} · ${esc(where)}</div></div></div>
      <div class="chips"><span class="chip ${current ? 'ok' : 'warn'}">${current ? '当前日程' : '已删除'}</span>${settled ? '<span class="chip">已有结算事实</span>' : ''}<span class="chip">${versions.length} 个版本</span></div>
      ${current && !settled ? `<div class="btnrow"><button class="btn small primary" data-act="edit-schedule" data-id="${esc(id)}">编辑</button><button class="btn small danger" data-act="delete-schedule" data-id="${esc(id)}">删除日程</button></div>` : ''}
      <div class="sect">版本历史 <small>${versions.length}</small></div>
      ${versionRows || '<p class="empty">还没有版本快照。</p>'}
      <div class="sect">一生之书 <small>${life.length}</small></div>
      ${lifeList(life, today)}`;
    return [html, snapshot.title, current ? '日程的一生之书' : '已删除 · 历史保留'];
  }

  private project(p: Project): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const v = s.villages().get(p.id);
    const tasks = s.tasks().filter((t) => t.projectId === p.id);
    const open = tasks.filter((t) => t.status === 'open').sort((a, b) => (a.scheduledFor ?? '9999').localeCompare(b.scheduledFor ?? '9999'));
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    const active = p.status === 'active';
    const stage = v?.stage ?? 0;
    const chips = [
      active
        ? `<span class="chip ${stage ? 'warn' : 'ok'}">${STAGE_NAMES[stage]}</span>`
        : p.status === 'closed'
          ? '<span class="chip warn">已关闭 · 未竟之书</span>'
          : `<span class="chip ok">已落成 · ${p.resting === 'landmark' ? '海岸上的地标' : '灯塔里的档案'}</span>`,
      v?.postponePenalty ? '<span class="chip warn">有事连续推迟 3 次以上</span>' : '',
      active && stage === 3 ? '<span class="chip warn">任务可能放弃</span>' : '',
      `<span class="chip">${houseCount(s, p.id)} 间房</span>`,
    ].join('');
    const progressAt = lastProgressAt(s.data, p.id);
    const since = progressAt ? diffDays(progressAt, today) : null;
    const taskRows = open
      .map((t) => {
        const late = t.scheduledFor && t.scheduledFor < today;
        const meta = [t.scheduledFor ? relDay(t.scheduledFor, today) + (late ? ' · 过期' : '') : '无日期', t.postponeCount ? `推迟 ${t.postponeCount} 次` : '', stage === 3 ? '可能放弃' : ''].filter(Boolean).join(' · ');
        return `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span class="${late ? 'late' : ''}">${esc(meta)}</span></div>${active ? `<div class="acts"><button class="iconbtn" data-act="done" data-id="${esc(t.id)}" title="今天做完了" aria-label="今天做完了">✓</button><button class="iconbtn" data-act="resched" data-id="${esc(t.id)}" title="改日期" aria-label="改日期">📅</button><button class="iconbtn" data-act="drop" data-id="${esc(t.id)}" title="不重要了" aria-label="不重要了">✕</button></div>` : ''}</div>`;
      })
      .join('');
    const life = lifeBookEntries(s.data, { type: 'project', id: p.id }, stageLifeEntries(s.data, today));
    const html = `
      ${this.back$()}
      <div class="who"><div class="emblem">${emblem(roofOf(p.islandSlot), active ? stage : 2)}</div><div><div class="fname">${esc(p.name)}</div><div class="fmeta">${fmtDay(p.createdAt)}立项 · 已 ${diffDays(p.createdAt, today)} 天${p.closedAt ? ` · ${fmtDay(p.closedAt)}关闭` : ''}${p.doneAt ? ` · ${fmtDay(p.doneAt)}落成` : ''}</div></div></div>
      <div class="chips">${chips}</div>
      ${
        p.status === 'done'
          ? `<div class="sect">一生之书小结</div>${summaryHTML(summarize(s.data, p, p.doneAt ?? today), true)}`
          : `<div class="nums"><div><b>${open.length}</b><span>未完成</span></div><div><b>${done.length}</b><span>已完成</span></div><div><b>${since ?? '—'}</b><span>距上次推进（天）</span></div></div>`
      }
      ${p.closeReason ? `<p class="hint">停下的原因：${esc(p.closeReason)}</p>` : ''}
      ${active && !open.length && done.length ? `<div class="ready"><span>村里的事都做完了。要举行落成仪式吗？</span><button class="btn small primary" data-act="complete" data-id="${esc(p.id)}">落成仪式</button></div>` : ''}
      ${p.status === 'done' ? '' : `<div class="sect">住在这里的任务 <small>${open.length}</small></div>`}
      ${active ? `<form class="add" data-form="ptask" data-id="${esc(p.id)}"><input name="ptask" placeholder="添加任务…" autocomplete="off" aria-label="新任务">${dateSelect('pdate', today, { current: today, withNone: true, mode: 'task' })}<button class="btn primary">添加</button></form>` : ''}
      ${p.status === 'done' ? '' : `<div>${taskRows || (active ? '<p class="empty">村里还没有人。添加一件要做的事吧。</p>' : '')}</div>`}
      ${done.length ? `<details class="hint"><summary>已完成 ${done.length} 件</summary>${done.map((t) => `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span>${t.closedAt ? fmtDay(t.closedAt) : ''}</span></div></div>`).join('')}</details>` : ''}
      <div class="sect">一生之书 <small>${life.length} 条</small></div>
      ${lifeList(life, today)}
      <div class="btnrow">
        ${active ? `<button class="btn small primary" data-act="complete" data-id="${esc(p.id)}">完成项目 · 落成仪式</button>` : ''}
        ${active ? `<button class="btn small" data-act="rename" data-id="${esc(p.id)}">改名</button>` : ''}
        ${active && stage >= 1 ? `<button class="btn small" data-act="prompt" data-id="${esc(p.id)}">重新启动 / 缩小规模</button>` : ''}
        ${active ? `<button class="btn small danger" data-act="close" data-id="${esc(p.id)}">正式关闭</button>` : ''}
        ${p.status === 'closed' ? `<button class="btn small" data-act="reopen" data-id="${esc(p.id)}">重新立起</button>` : ''}
        ${p.status === 'done' && p.resting === 'landmark' ? `<button class="btn small" data-act="rest" data-to="archive" data-id="${esc(p.id)}">收进档案馆</button>` : ''}
        ${p.status === 'done' && p.resting !== 'landmark' ? `<button class="btn small primary" data-act="rest" data-to="landmark" data-id="${esc(p.id)}">重新立为地标</button>` : ''}
      </div>`;
    return [html, p.name, active ? STAGE_NAMES[stage] + ` · ${open.length} 件未完成` : p.status === 'done' ? (p.resting === 'landmark' ? '海岸上的地标' : '灯塔里的档案') : '已关闭'];
  }

  private task(t: TaskView): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const p = s.project(t.projectId);
    const late = t.status === 'open' && t.scheduledFor && t.scheduledFor < today;
    const statusChip = t.status === 'open' ? `<span class="chip ok">进行中</span>` : t.status === 'done' ? `<span class="chip ok">已完成</span>` : `<span class="chip">已放下</span>`;
    const entries = s.data.entries.filter((e) => e.itemType === 'task' && e.itemId === t.id);
    const life = lifeBookEntries(s.data, { type: 'task', id: t.id }, stageLifeEntries(s.data, today));
    const projOpts = s.activeProjects().map((x) => `<option value="${esc(x.id)}"${x.id === t.projectId ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const html = `
      ${this.back$(p ? p.name : '码头')}
      <div class="who"><div class="emblem" style="background:${p ? roofOf(p.islandSlot) + '22' : 'var(--chip)'}">${p ? '🧑‍🌾' : '⛵'}</div><div><div class="fname">${esc(t.title)}</div><div class="fmeta">${p ? `住在「${esc(p.name)}」` : '停在码头，等你安排'} · ${fmtDay(t.createdAt)}来到岛上</div></div></div>
      <div class="chips">${statusChip}${t.scheduledFor ? `<span class="chip ${late ? 'warn' : ''}">${relDay(t.scheduledFor, today)}${late ? ' · 过期' : ''}</span>` : '<span class="chip">无日期</span>'}${t.postponeCount ? `<span class="chip warn">推迟 ${t.postponeCount} 次</span>` : ''}</div>
      <div class="nums"><div><b>${entries.filter((e) => e.outcome !== 'skipped').length}</b><span>做过</span></div><div><b>${entries.filter((e) => e.outcome === 'skipped').length}</b><span>没做</span></div><div><b>${diffDays(t.createdAt, today)}</b><span>来岛天数</span></div></div>
      ${
        t.status === 'open'
          ? `<form class="add" data-form="tedit" data-id="${esc(t.id)}"><select name="tproj" aria-label="所属村落"><option value="">停在码头</option>${projOpts}</select>${dateSelect('tdate', today, { current: t.scheduledFor, withNone: true, mode: 'task' })}<button class="btn small">保存</button></form>
             <div class="btnrow">${p ? `<button class="btn small primary" data-act="done" data-id="${esc(t.id)}">今天做完了</button>` : ''}<button class="btn small" data-act="trename" data-id="${esc(t.id)}">改名</button><button class="btn small" data-act="drop" data-id="${esc(t.id)}">不重要了</button></div>`
          : ''
      }
      <div class="sect">一生之书</div>
      ${lifeList(life, today)}`;
    return [html, t.title, p ? p.name : '码头'];
  }

  private dock(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const ships = s.tasks().filter((t) => t.status === 'open' && !t.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const overdue = s.tasks().filter((t) => t.status === 'open' && t.projectId && t.scheduledFor && t.scheduledFor < today).sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));
    const projOpts = s.activeProjects().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const shipRows = ships
      .map(
        (t) => `<form class="ship" data-form="arrange" data-id="${esc(t.id)}"><b>⛵ ${esc(t.title)}</b><div class="ctl"><select name="aproj" aria-label="住进哪个村落">${projOpts || '<option value="">（先建一个村落）</option>'}</select>${dateSelect('adate', today, { current: t.scheduledFor, withNone: true, mode: 'task' })}<button class="btn small primary"${projOpts ? '' : ' disabled'}>安排</button><button type="button" class="btn small" data-act="decline" data-id="${esc(t.id)}">婉拒</button></div></form>`,
      )
      .join('');
    const ints = interruptions(s.data).sort((a, b) => b.date.localeCompare(a.date));
    const week = ints.filter((i) => i.date > addDays(today, -7));
    const byProj = new Map<string, number>();
    for (const i of week) byProj.set(i.projectId ?? '', (byProj.get(i.projectId ?? '') ?? 0) + 1);
    const topP = [...byProj.entries()].sort((a, b) => b[1] - a[1])[0];
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">码头 <small>${ships.length} 船</small></div>
      <p class="pdesc">新任务乘船停在这里。决定它住进哪个村落、排在什么时候，或者婉拒。</p>
      <form class="add" data-form="quick"><input name="quick" placeholder="又来了一件事…" autocomplete="off" aria-label="新任务"><input type="hidden" name="qproj" value=""><button class="btn primary">靠岸</button></form>
      ${shipRows || '<p class="empty">码头空着，没有待安排的船。</p>'}
      <div class="sect">过期未完成 <small>${overdue.length}</small></div>
      ${
        overdue
          .map((t) => {
            const p = s.project(t.projectId);
            return `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span class="late">${esc(p?.name ?? '')} · 原定${relDay(t.scheduledFor!, today)}</span></div><div class="acts"><button class="btn small" data-act="to-today" data-id="${esc(t.id)}">排到今天</button><button class="iconbtn" data-act="resched" data-id="${esc(t.id)}" aria-label="改日期" title="改日期">📅</button><button class="iconbtn" data-act="drop" data-id="${esc(t.id)}" aria-label="不重要了" title="不重要了">✕</button></div></div>`;
          })
          .join('') || '<p class="empty">没有过期的事。</p>'
      }
      <div class="sect">打断记录 <small>近 7 天 ${week.length} 次</small></div>
      ${week.length && topP ? `<p class="hint">最近的打断多落在${topP[0] ? `「${esc(s.project(topP[0])?.name ?? '已关闭的项目')}」` : '杂务'}（${topP[1]} 次）。</p>` : ''}
      ${ints.length ? `<ol class="life">${ints.slice(0, 30).map((i) => `<li><time>${esc(relDay(i.date, today))}</time><span>${esc(i.title)}${i.projectId ? ` · ${esc(s.project(i.projectId)?.name ?? '')}` : ''}</span></li>`).join('')}</ol>` : '<p class="empty">还没有被打断的记录。</p>'}`;
    return [html, '码头', `${ships.length} 船待安排`];
  }

  private granary(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const g = granary(s.data, today);
    const evs = s.data.events.filter((e) => !e.allDay && dateOfStamp(e.start) === today).sort((a, b) => a.start.localeCompare(b.start));
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">粮仓 <small>今天的精力和时间</small></div>
      <div class="nums"><div><b>${g.available.toFixed(1)}</b><span>可用（小时）</span></div><div><b>${g.scheduledHours.toFixed(1)}</b><span>日历已排</span></div><div><b>${Math.round(g.factor * 100)}%</b><span>精力</span></div></div>
      <p class="hint">可用时间 = 工作时段（${esc(s.data.settings.workStart)}–${esc(s.data.settings.workEnd)}）− 日历上已排的时间。近 7 天每有一次「没精力」，建议容量下调一成${g.noEnergy ? `，现在是 ${g.noEnergy} 次` : ''}。</p>
      <div class="sect">今天的日历 <small>${evs.length}</small></div>
      ${evs.map((e) => `<div class="task"><div class="tt"><b>${esc(e.title)}</b><span>${timeOf(e.start)}–${timeOf(e.end)} · ${esc(e.projectId === CHORES ? '杂务' : s.project(e.projectId)?.name ?? '未归类')}</span></div></div>`).join('') || '<p class="empty">今天日历上没有安排。</p>'}
      <div class="btnrow"><button class="btn small" data-act="settings">调整工作时段</button></div>`;
    return [html, '粮仓', `可用 ${g.available.toFixed(1)} 小时`];
  }

  private coastRow(): string {
    const s = this.store;
    const marks = s.data.projects.filter((p) => p.status === 'done' && p.resting === 'landmark').length;
    const books = s.data.projects.filter((p) => (p.status === 'done' && p.resting !== 'landmark') || p.status === 'closed').length;
    if (!marks && !books) return '';
    return `<div class="sect">海岸与灯塔</div><button class="row" data-act="archive"><i class="sw" style="background:#c8473a"></i><span class="tx"><b>${marks} 座地标 · 灯塔里 ${books} 本书</b><span>完成和关闭的项目都在这里，可以按年份翻看</span></span><span class="end">›</span></button>`;
  }

  /** 档案馆：山顶的灯塔。地标、落成之书（按年份）、未竟之书 */
  private archive(): [string, string, string] {
    const s = this.store;
    const done = s.data.projects.filter((p) => p.status === 'done');
    const marks = done.filter((p) => p.resting === 'landmark').sort((a, b) => (a.landmarkIndex ?? 0) - (b.landmarkIndex ?? 0));
    const books = done.filter((p) => p.resting !== 'landmark');
    const closed = s.data.projects.filter((p) => p.status === 'closed');
    const row = (p: Project, meta: string) =>
      `<button class="row" data-act="project" data-id="${esc(p.id)}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b><span>${esc(meta)}</span></span><span class="end">›</span></button>`;
    const byYear = (ps: Project[], dateOf: (p: Project) => string | undefined, meta: (p: Project) => string) => {
      const years = new Map<string, Project[]>();
      for (const p of ps) {
        const y = (dateOf(p) ?? p.createdAt).slice(0, 4);
        if (!years.has(y)) years.set(y, []);
        years.get(y)!.push(p);
      }
      return [...years.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([y, list]) => `<div class="year">${y} 年 <small>${list.length} 本</small></div><div class="rows">${list.sort((a, b) => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? '')).map((p) => row(p, meta(p))).join('')}</div>`)
        .join('');
    };
    const span = (p: Project, end?: string) => (end ? `${fmtDay(p.createdAt)}–${fmtDay(end)} · 用时 ${diffDays(p.createdAt, end) + 1} 天` : fmtDay(p.createdAt) + ' 立项');
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">山顶的灯塔 <small>档案馆</small></div>
      <p class="pdesc">完成的项目立在海岸上，或收在这里；正式关闭的项目放在「未竟之书」，记着它为什么停下。</p>
      <div class="sect">海岸上的地标 <small>${marks.length}</small></div>
      <div class="rows">${marks.map((p) => row(p, span(p, p.doneAt))).join('') || '<p class="empty">还没有地标。完成一个项目时可以把它立在海岸上。</p>'}</div>
      <div class="sect">落成之书 <small>${books.length}</small></div>
      ${byYear(books, (p) => p.doneAt, (p) => span(p, p.doneAt)) || '<p class="empty">书架还空着。</p>'}
      <div class="sect">未竟之书 <small>${closed.length}</small></div>
      ${byYear(closed, (p) => p.closedAt, (p) => span(p, p.closedAt) + (p.closeReason ? ' · ' + p.closeReason : '')) || '<p class="empty">没有中途停下的项目。</p>'}`;
    return [html, '档案馆', `${marks.length} 座地标 · ${books.length + closed.length} 本书`];
  }

  private chores(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const evs = s.data.events.filter((e) => e.projectId === CHORES && !e.allDay && dateOfStamp(e.start) > addDays(today, -7) && dateOfStamp(e.start) <= addDays(today, 7)).sort((a, b) => a.start.localeCompare(b.start));
    const projOpts = s.activeProjects().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">杂务区 <small>没有归属的日历事件</small></div>
      <p class="pdesc">这些事件不属于任何项目。如果其实属于某个村落，可以改过去。</p>
      ${evs.map((e) => `<div class="task"><div class="tt"><b>${esc(e.title)}</b><span>${relDay(dateOfStamp(e.start), today)} ${timeOf(e.start)}</span></div><div class="acts"><select data-act-change="evproj" data-id="${esc(e.id)}" aria-label="改归属"><option value="">杂务</option>${projOpts}</select></div></div>`).join('') || '<p class="empty">最近一周没有杂务。</p>'}`;
    return [html, '杂务区', `${evs.length} 个事件`];
  }

  /* ---------------- 交互 ---------------- */

  private onSubmit(e: Event) {
    const f = e.target as HTMLFormElement;
    e.preventDefault();
    const s = this.store;
    const fd = new FormData(f);
    try {
      switch (f.dataset.form) {
        case 'quick': {
          const title = String(fd.get('quick') ?? '');
          const pid = String(fd.get('qproj') ?? '');
          const t = A.createTask(s, { title, projectId: pid || undefined });
          toast(t.projectId ? `「${t.title}」住进了「${s.project(t.projectId)?.name}」` : `「${t.title}」乘船停在了码头`);
          break;
        }
        case 'ptask': {
          const sel = f.querySelector<HTMLSelectElement>('select[name=pdate]')!;
          A.createTask(s, { title: String(fd.get('ptask') ?? ''), projectId: f.dataset.id, scheduledFor: readDate(sel) });
          break;
        }
        case 'arrange': {
          const pid = String(fd.get('aproj') ?? '');
          if (!pid) return;
          const sel = f.querySelector<HTMLSelectElement>('select[name=adate]')!;
          const t = s.task(f.dataset.id);
          A.arrangeTask(s, f.dataset.id!, pid, readDate(sel));
          toast(`「${t?.title}」上岸，住进了「${s.project(pid)?.name}」`);
          break;
        }
        case 'tedit': {
          const id = f.dataset.id!;
          const pid = String(fd.get('tproj') ?? '') || undefined;
          const sel = f.querySelector<HTMLSelectElement>('select[name=tdate]')!;
          A.editTaskPlan(s, id, pid, readDate(sel));
          toast('已保存');
          break;
        }
      }
    } catch (err) {
      if (err instanceof A.ActionError) toast(err.message, true);
      else throw err;
    }
  }

  private async onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const s = this.store;
    const id = el.dataset.id ?? '';
    const today = s.today();
    switch (el.dataset.act) {
      case 'back':
        this.back();
        break;
      case 'project':
        this.open({ kind: 'project', id });
        break;
      case 'task':
        this.open({ kind: 'task', id });
        break;
      case 'dock':
        this.open({ kind: 'dock' });
        break;
      case 'diaries':
        this.open({ kind: 'diaries' });
        break;
      case 'schedules':
        this.open({ kind: 'schedules' });
        break;
      case 'delete-diary': {
        const entry = s.data.diaries.find((item) => item.id === id);
        if (!entry) break;
        const context = s.captureWriteContext();
        const ok = await confirmModal({
          title: '删除这篇日记？',
          text: `${fmtDay(entry.date)} · ${entry.text.length > 80 ? entry.text.slice(0, 79) + '…' : entry.text}\n\n删除后，花园长势会按剩余日记重新计算。`,
          ok: '删除',
          danger: true,
        });
        if (!ok || !context.isCurrent()) break;
        A.deleteDiary(s, id);
        toast('日记已删除');
        break;
      }
      case 'delete-schedule': {
        const event = s.data.events.find((item) => item.id === id && item.sourceId === LOCAL_CALENDAR_SOURCE_ID);
        if (!event) break;
        if (s.data.entries.some((entry) => entry.itemType === 'event' && entry.itemId === id)) {
          toast('这个日程已经留下结算记录，不能直接删除', true);
          break;
        }
        const context = s.captureWriteContext();
        const ok = await confirmModal({
          title: `删除日程「${event.title}」？`,
          text: `${fmtDay(dateOfStamp(event.start))} ${timeOf(event.start)}–${timeOf(event.end)}。删除后，它会从日程层移除，也不会进入后续结算。`,
          ok: '删除',
          danger: true,
        });
        if (!ok || !context.isCurrent()) break;
        try {
          A.deleteSchedule(s, id);
          toast('日程已删除');
        } catch (err) {
          if (err instanceof A.ActionError) toast(err.message, true);
          else throw err;
        }
        break;
      }
      case 'classify':
        this.hooks.openClassify();
        break;
      case 'new-project':
        this.hooks.openNew('project');
        break;
      case 'new-diary':
        this.hooks.openNew('diary');
        break;
      case 'new-schedule':
        this.hooks.openNew('schedule');
        break;
      case 'settings':
        this.hooks.openSettings();
        break;
      case 'done': {
        const t = s.task(id);
        A.markTaskDone(s, id);
        if (t) toast(`「${t.title}」做完了，一块砖飞进了村落`);
        break;
      }
      case 'drop': {
        const t = s.task(id);
        A.dropTask(s, id);
        if (t) toast(`放下了「${t.title}」。这是好的取舍。`);
        break;
      }
      case 'decline': {
        const t = s.task(id);
        A.declineTask(s, id);
        if (t) toast(`婉拒了「${t.title}」，船开走了`);
        break;
      }
      case 'to-today':
        A.rescheduleTask(s, id, today);
        break;
      case 'resched':
        this.reschedule(id);
        break;
      case 'rename': {
        const p = s.project(id);
        if (p) this.renameDialog('给村落改个名字', p.name, (n) => A.renameProject(s, id, n));
        break;
      }
      case 'trename': {
        const t = s.task(id);
        if (t) this.renameDialog('改一下这件事的说法', t.title, (n) => A.renameTask(s, id, n));
        break;
      }
      case 'prompt': {
        const p = s.project(id);
        if (p) this.hooks.openPrompt(p);
        break;
      }
      case 'close':
        this.closeDialog(id);
        break;
      case 'archive':
        this.open({ kind: 'archive' });
        break;
      case 'complete': {
        const p = s.project(id);
        if (p) this.hooks.openCeremony(p);
        break;
      }
      case 'rest':
        try {
          A.setResting(s, id, el.dataset.to as 'landmark' | 'archive');
          toast(el.dataset.to === 'landmark' ? '重新立在了海岸上' : '收进了山顶的灯塔');
        } catch (err) {
          if (err instanceof A.ActionError) toast(err.message, true);
        }
        break;
      case 'reopen':
        try {
          A.reopenProject(s, id);
          toast('村落重新立起来了');
        } catch (err) {
          if (err instanceof A.ActionError) toast(err.message, true);
        }
        break;
    }
  }

  bindChange() {
    this.body.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.dataset.actChange === 'evproj') A.setEventProject(this.store, el.dataset.id!, el.value || undefined);
    });
  }

  private renameDialog(title: string, cur: string, save: (n: string) => void) {
    openModal({
      title,
      body: `<form data-f><label class="field">名字<input name="n" value="${esc(cur)}" autofocus autocomplete="off"></label><div class="actions"><button type="button" class="btn" data-close>算了</button><button class="btn primary">保存</button></div></form>`,
      mount(box) {
        box.querySelector('form')!.addEventListener('submit', (e) => {
          e.preventDefault();
          save(String(new FormData(e.target as HTMLFormElement).get('n') ?? ''));
          closeModal(false);
        });
      },
    });
  }

  private reschedule(id: string) {
    const s = this.store;
    const t = s.task(id);
    if (!t) return;
    const today = s.today();
    const quick: [string, string][] = [
      [today, '今天'],
      [addDays(today, 1), '明天'],
      [addDays(today, 2), '后天'],
      [addDays(today, 7), '一周后'],
      ['', '不定日期'],
    ];
    openModal({
      title: `「${t.title}」改到哪天？`,
      body: `<p class="hint">手动改期不算「推迟」，不会让村落加重。</p><div class="btnrow">${quick.map(([d, l]) => `<button class="btn small" data-d="${d}">${l}</button>`).join('')}</div><label class="field">或者选一天<input type="date" name="d" min="${addDays(today, -30)}" value="${t.scheduledFor ?? ''}"></label><div class="actions"><button class="btn" data-close>算了</button><button class="btn primary" data-ok>好</button></div>`,
      mount(box) {
        const go = (d: string) => {
          A.rescheduleTask(s, id, d || undefined);
          closeModal(false);
        };
        box.querySelectorAll<HTMLElement>('[data-d]').forEach((b) => b.addEventListener('click', () => go(b.dataset.d!)));
        box.querySelector('[data-ok]')!.addEventListener('click', () => go(box.querySelector<HTMLInputElement>('input[name=d]')!.value));
      },
    });
  }

  private closeDialog(id: string) {
    const s = this.store;
    const p = s.project(id);
    if (!p) return;
    const open = s.tasks().filter((t) => t.projectId === id && t.status === 'open').length;
    openModal({
      kick: '最后一步由你决定',
      title: `正式关闭「${p.name}」？`,
      body: `<p>关闭后村落会腾空，项目放进「未竟之书」，记下它为什么停下。${open ? `村里还有 ${open} 件没做完的事，会一起放下。` : ''}以后可以重新立起。</p><label class="field">为什么停下（可不填）<textarea name="r" placeholder="例如：方向变了 / 已经不需要了"></textarea></label><div class="actions"><button class="btn" data-close>先不关</button><button class="btn danger" data-ok>正式关闭</button></div>`,
      mount: (box) => {
        box.querySelector('[data-ok]')!.addEventListener('click', () => {
          A.closeProject(s, id, box.querySelector<HTMLTextAreaElement>('textarea')!.value);
          closeModal(false);
          toast(`「${p.name}」放进了未竟之书`);
          this.open({ kind: 'overview' });
        });
      },
    });
  }
}

/** 搬离阶段的询问：重新启动 / 缩小规模 / 正式关闭 */
export function abandonPrompt(store: Store, p: Project, onDone: () => void) {
  const v = store.villages().get(p.id);
  const open = store.tasks().filter((t) => t.projectId === p.id && t.status === 'open');
  const reasons = lifeEntries(store.data, stageLifeEntries(store.data, store.today())).filter((l) => l.projectId === p.id && l.kind === 'skip' && l.reason);
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(A.REASON_TEXT[r.reason!], (counts.get(A.REASON_TEXT[r.reason!]) ?? 0) + 1);
  const why = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} 次`).join('、');
  let chosen = false;
  openModal({
    kick: v?.stage === 3 ? '有居民开始搬离' : '村落需要你',
    title: `「${p.name}」接下来怎么办？`,
    body: `<p>${v ? `这个村落已经 ${v.daysSinceProgress} 天没有真实推进了。` : ''}${why ? `过去没做的原因：${esc(why)}。` : ''}项目不会自己消失，由你来决定。</p>
      <button class="opt" data-c="restart"><b>重新启动</b><span>清空推迟记录，村落从「正常」重新开始。</span></button>
      <button class="opt" data-c="trim"><b>缩小规模</b><span>放下一部分任务，村落回到「安静」，轻装继续。</span></button>
      <button class="opt" data-c="close"><b>正式关闭</b><span>放进「未竟之书」，记下它为什么停下。以后还能重新立起。</span></button>
      <button class="linkbtn" data-c="later">过几天再说</button>`,
    mount(box) {
      box.querySelectorAll<HTMLElement>('[data-c]').forEach((b) =>
        b.addEventListener('click', async () => {
          chosen = true;
          const c = b.dataset.c;
          if (c === 'restart') {
            A.restartProject(store, p.id);
            closeModal(false);
            toast(`「${p.name}」重新启动了`);
            onDone();
          } else if (c === 'later') {
            A.snoozePrompt(store, p.id);
            closeModal(false);
            onDone();
          } else if (c === 'trim') {
            openModal({
              title: `缩小「${p.name}」的规模`,
              body: `<p>勾选的任务留下；取消勾选的任务会被放下（不算惩罚）。</p><div class="checklist">${open.map((t) => `<label><input type="checkbox" value="${esc(t.id)}" checked> ${esc(t.title)}</label>`).join('') || '<p class="empty">村里没有未完成的任务。</p>'}</div><div class="actions"><button class="btn" data-close>算了</button><button class="btn primary" data-ok>就这样</button></div>`,
              mount(b2) {
                b2.querySelector('[data-ok]')!.addEventListener('click', () => {
                  const drop = [...b2.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((x) => !x.checked).map((x) => x.value);
                  A.trimProject(store, p.id, drop);
                  closeModal(false);
                  toast(`「${p.name}」轻装继续`);
                  onDone();
                });
              },
              onClose: onDone,
            });
          } else if (c === 'close') {
            const context = store.captureWriteContext();
            const ok = await confirmModal({ kick: '最后一步由你决定', title: `正式关闭「${p.name}」？`, text: '村落会腾空，项目放进「未竟之书」。以后可以重新立起。', ok: '正式关闭', danger: true });
            if (!context.isCurrent()) return;
            if (ok) {
              A.closeProject(store, p.id, why ? `长期停滞（${why}）` : '长期停滞');
              toast(`「${p.name}」放进了未竟之书`);
            }
            onDone();
          }
        }),
      );
    },
    onClose: () => {
      // The tab may have lost writer ownership while this modal was open.
      if (!chosen && !store.isReadOnly) A.snoozePrompt(store, p.id);
      onDone();
    },
  });
}
