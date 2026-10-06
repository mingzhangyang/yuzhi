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
import { t as tr } from '../i18n';
import { addDays, dateOfStamp, diffDays, fmtDay, relDay } from '../lib/date';
import { backlog, granary } from '../logic/metrics';
import { unclassifiedGroups } from '../logic/classify';
import { summarize } from '../logic/summary';
import { compareLifeEntries, lifeEntries } from '../logic/operations';
import { buildLifeBookIndex, lifeBookEntries } from '../logic/life-book';
import { stageLifeEntries } from '../logic/decay';
import { interruptions, lastProgressAt, type TaskView } from '../logic/read-model';
import { summaryHTML } from './ceremony';
import { cultivationAreas, cultivationState } from '../logic/cultivation';
import { bindDateSelects, dateSelect, readDate, restoreDateSelectValue } from './date-select';

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

const STAGE_KEYS = ['stage.normal', 'stage.quiet', 'stage.dusty', 'stage.leaving'] as const;
const stageName = (stage: number) => tr(STAGE_KEYS[stage] ?? STAGE_KEYS[0]);

function lifeList(entries: readonly LifeEntry[], today: ISODate, limit = 60) {
  if (!entries.length) return `<p class="empty">${esc(tr('tracker.noRecords'))}</p>`;
  const rows = entries
    .slice()
    .sort((a, b) => compareLifeEntries(b, a))
    .slice(0, limit)
    .map((e) => `<li class="k-${e.kind}"><time>${e.baseline ? esc(tr('tracker.legacyRecord')) : esc(relDay(e.date, today))}</time><span>${esc(e.text)}</span></li>`)
    .join('');
  return `<ol class="life">${rows}</ol>`;
}

export interface TrackerDraftState {
  view: string;
  controls: Array<{
    key: string;
    value: string;
    checked?: boolean;
    selected?: string[];
  }>;
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

  captureDraftState(): TrackerDraftState {
    const seen = new Map<string, number>();
    const controls = [...this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name], textarea[name], select[name]')]
      .map((control) => {
        const base = `${control.tagName}:${control instanceof HTMLInputElement ? control.type : ''}:${control.name}`;
        const index = seen.get(base) ?? 0;
        seen.set(base, index + 1);
        const key = `${base}:${index}`;
        if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
          return { key, value: control.value, checked: control.checked };
        }
        if (control instanceof HTMLSelectElement && control.multiple) {
          return { key, value: control.value, selected: [...control.options].filter((option) => option.selected).map((option) => option.value) };
        }
        return { key, value: control.value };
      });
    return { view: JSON.stringify(this.view), controls };
  }

  restoreDraftState(state: TrackerDraftState): void {
    if (state.view !== JSON.stringify(this.view)) return;
    const saved = new Map(state.controls.map((control) => [control.key, control]));
    const seen = new Map<string, number>();
    for (const control of this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name], textarea[name], select[name]')) {
      const base = `${control.tagName}:${control instanceof HTMLInputElement ? control.type : ''}:${control.name}`;
      const index = seen.get(base) ?? 0;
      seen.set(base, index + 1);
      const draft = saved.get(`${base}:${index}`);
      if (!draft) continue;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        control.checked = Boolean(draft.checked);
      } else if (control instanceof HTMLSelectElement && control.multiple && draft.selected) {
        const selected = new Set(draft.selected);
        for (const option of control.options) option.selected = selected.has(option.value);
      } else if (control instanceof HTMLSelectElement && control.hasAttribute('data-date-select')) {
        restoreDateSelectValue(control, draft.value);
      } else {
        control.value = draft.value;
      }
    }
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

  private back$(label = tr('tracker.overview')) {
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
        const since = progressAt ? tr('tracker.progressSince', { days: diffDays(progressAt, today) }) : tr('tracker.noProgress', { days: diffDays(p.createdAt, today) });
        return `<button class="row" data-act="project" data-id="${esc(p.id)}"><i class="sw" style="background:${roofOf(p.islandSlot)}"></i><span class="tx"><b>${esc(p.name)}</b><span>${esc(tr('tracker.openTasks', { count: open.length }))} · ${esc(since)}</span></span><span class="chip ${v.stage ? 'warn' : 'ok'}">${esc(stageName(v.stage))}</span></button>`;
      })
      .join('');
    const groups = unclassifiedGroups(s.data.events);
    const cultivated = cultivationAreas(cultivationState(s.data, today));
    const cultivationRows = cultivated
      .map((area) => `<div class="row static"><span class="tx"><b>${esc(area.name)} · ${esc(tr('tracker.growth', { level: area.level }))}</b><span>${esc(area.summary)}</span></span></div>`)
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
      <div class="ptitle">${esc(tr('tracker.islandOverview'))} <small>${esc(tr('tracker.villagesCount', { count: ps.length }))}</small></div>
      <form class="add" data-form="quick"><input name="quick" placeholder="${esc(tr('tracker.quickPlaceholder'))}" autocomplete="off" aria-label="${esc(tr('tracker.newTaskAria'))}"><select name="qproj" aria-label="${esc(tr('tracker.villageAria'))}"><option value="">${esc(tr('tracker.dockOption'))}</option>${projOpts}</select><button class="btn primary">${esc(tr('common.add'))}</button></form>
      <p class="hint">${esc(tr('tracker.quickHint'))}</p>
      <div class="sect">${esc(tr('tracker.villages'))} <button class="linkbtn" data-act="new-project">${esc(tr('tracker.newVillage'))}</button></div>
      <div class="rows">${rows || `<p class="empty">${esc(tr('tracker.noVillages'))}</p>`}</div>
      <div class="sect">${esc(tr('tracker.cultivation'))} <small>${esc(tr('tracker.cultivationSub'))}</small></div>
      <div class="rows">${cultivationRows}</div>
      <div class="sect">${esc(tr('tracker.realInput'))} <small>${esc(tr('tracker.realInputSub'))}</small></div>
      <button class="row" data-act="diaries"><i class="sw" style="background:#9b78a8"></i><span class="tx"><b>${esc(tr('tracker.diariesCount', { count: diaries.length }))}</b><span>${latestDiary ? `${fmtDay(latestDiary.date)} · ${esc(latestDiary.text.length > 46 ? latestDiary.text.slice(0, 45) + '…' : latestDiary.text)}` : esc(tr('tracker.diaryEmptyPreview'))}</span></span><span class="end">›</span></button>
      <button class="row" data-act="schedules"><i class="sw" style="background:#7397a7"></i><span class="tx"><b>${esc(tr('tracker.schedulesCount', { count: localSchedules.length }))}</b><span>${nextSchedule ? `${relDay(dateOfStamp(nextSchedule.start), today)} ${timeOf(nextSchedule.start)} · ${esc(nextSchedule.title)}` : esc(tr('tracker.scheduleEmptyPreview'))}</span></span><span class="end">›</span></button>
      <div class="sect">${esc(tr('tracker.dock'))} <small>${esc(tr('tracker.dockMeta', { ships: b.dock, overdue: b.overdue }))}</small></div>
      <button class="row" data-act="dock"><i class="sw" style="background:#a8794a"></i><span class="tx"><b>${esc(b.dock ? tr('tracker.shipsAtDock', { count: b.dock }) : tr('tracker.dockEmpty'))}</b><span>${esc(tr(b.dock ? 'tracker.dockBusyHint' : 'tracker.dockEmptyHint'))}</span></span><span class="end">›</span></button>
      ${this.coastRow()}
      ${groups.length ? `<div class="sect">${esc(tr('tracker.calendar'))} <small>${esc(tr('tracker.unclassifiedCount', { count: groups.length }))}</small></div><button class="row" data-act="classify"><i class="sw" style="background:var(--dusk)"></i><span class="tx"><b>${esc(tr('tracker.unclassifiedTitle'))}</b><span>${esc(tr('tracker.unclassifiedHint'))}</span></span><span class="end">›</span></button>` : ''}
    `;
    return [html, tr('tracker.islandOverview'), tr('tracker.overviewSub', { villages: ps.length, ships: b.dock })];
  }

  private diaries(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const entries = s.data.diaries
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const history = buildLifeBookIndex(s.data);
    const currentIds = new Set(entries.map((entry) => entry.id));
    const deletedIds = history.subjectIds('diary').filter((id) => !currentIds.has(id));
    const rows = entries
      .map((entry) => `<div class="task"><button type="button" class="tt history-link" data-act="diary" data-id="${esc(entry.id)}"><b>${esc(relDay(entry.date, today))} · ${esc(fmtDay(entry.date))}</b><span>${esc(entry.text.length > 100 ? entry.text.slice(0, 99) + '…' : entry.text)}</span></button><div class="acts"><span class="chip">${esc(tr('common.version', { count: history.diaryVersions(entry.id).length }))}</span><button class="iconbtn" data-act="delete-diary" data-id="${esc(entry.id)}" title="${esc(tr('common.delete'))}" aria-label="${esc(tr('tracker.deleteDiaryAria', { date: fmtDay(entry.date) }))}">✕</button></div></div>`)
      .join('');
    const deletedRows = deletedIds
      .map((id) => {
        const snapshot = history.diaryLatest(id);
        if (!snapshot) return '';
        return `<div class="task history-record"><button type="button" class="tt history-link" data-act="diary" data-id="${esc(id)}"><b>${esc(fmtDay(snapshot.date))}</b><span>${esc(snapshot.text.length > 100 ? snapshot.text.slice(0, 99) + '…' : snapshot.text)}</span></button><div class="acts"><span class="chip">${esc(tr('tracker.deletedHistory'))}</span></div></div>`;
      })
      .join('');
    return [
      `${this.back$()}<div class="ptitle">${esc(tr('tracker.diaries'))} <button class="linkbtn" data-act="new-diary">${esc(tr('tracker.writeDiary'))}</button></div><p class="hint">${esc(tr('tracker.diariesHint'))}</p><div class="rows">${rows || `<p class="empty">${esc(tr('tracker.noDiaries'))}</p>`}</div>${deletedRows ? `<div class="sect">${esc(tr('tracker.deletedDiaries'))} <small>${deletedIds.length}</small></div><div class="rows">${deletedRows}</div>` : ''}`,
      tr('tracker.diaries'),
      tr('tracker.diariesSub', { count: entries.length, archived: deletedIds.length }),
    ];
  }

  private diary(id: string): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const current = s.data.diaries.find((entry) => entry.id === id);
    const history = buildLifeBookIndex(s.data);
    const snapshot = history.diaryLatest(id);
    if (!snapshot) return [`${this.back$(tr('tracker.diaries'))}<p class="empty">${esc(tr('tracker.diaryUnavailable'))}</p>`, tr('tracker.diaries'), tr('tracker.historyUnavailable')];
    const versions = history.diaryVersions(id);
    const life = history.entries({ type: 'diary', id });
    const versionRows = versions
      .slice()
      .reverse()
      .map((version, index) => {
        const label = version.kind === 'created' ? tr('tracker.firstVersion') : tr('tracker.revision', { count: versions.length - index - 1 });
        return `<details class="revision"><summary>${label} · ${esc(fmtDay(version.recordedOn))}<span>${esc(tr('tracker.recordOf', { date: fmtDay(version.snapshot.date) }))}</span></summary><div class="revision-body">${esc(version.snapshot.text).replace(/\n/g, '<br>')}</div></details>`;
      })
      .join('');
    const html = `
      ${this.back$(tr('tracker.diaries'))}
      <div class="who"><div class="emblem" style="background:#9b78a822">✎</div><div><div class="fname">${esc(tr('tracker.diaryOf', { date: fmtDay(snapshot.date) }))}</div><div class="fmeta">${esc(tr(current ? 'tracker.diaryAlive' : 'tracker.diaryDeletedHistory'))} · ${esc(tr('common.versions', { count: versions.length }))}</div></div></div>
      <div class="chips"><span class="chip ${current ? 'ok' : 'warn'}">${esc(tr(current ? 'tracker.currentDiary' : 'tracker.deleted'))}</span><span class="chip">${esc(tr('tracker.historyCount', { count: life.length }))}</span></div>
      <div class="journal-body">${esc(snapshot.text).replace(/\n/g, '<br>')}</div>
      ${current ? `<div class="btnrow"><button class="btn small primary" data-act="edit-diary" data-id="${esc(id)}">${esc(tr('common.edit'))}</button><button class="btn small danger" data-act="delete-diary" data-id="${esc(id)}">${esc(tr('tracker.deleteBody'))}</button></div>` : ''}
      <div class="sect">${esc(tr('common.versionHistory'))} <small>${versions.length}</small></div>
      ${versionRows || `<p class="empty">${esc(tr('tracker.noVersionSnapshots'))}</p>`}
      <div class="sect">${esc(tr('common.history'))} <small>${life.length}</small></div>
      ${lifeList(life, today)}`;
    return [html, tr('tracker.diaryLifeBook'), current ? fmtDay(snapshot.date) : tr('tracker.deletedHistory')];
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
    const historyIndex = buildLifeBookIndex(s.data);
    const currentIds = new Set(events.map((event) => event.id));
    const deletedIds = historyIndex.subjectIds('schedule').filter((id) => !currentIds.has(id));
    const rows = events
      .map((event) => {
        const date = dateOfStamp(event.start);
        const settled = settledIds.has(event.id);
        const where = event.projectId === CHORES
          ? tr('common.choresLife')
          : event.projectId
            ? s.project(event.projectId)?.name ?? tr('common.closedProject')
            : tr('common.unclassified');
        const history = settled
          ? `<span class="chip">${esc(tr('tracker.keptInHistory'))}</span>`
          : `<button class="iconbtn" data-act="delete-schedule" data-id="${esc(event.id)}" title="${esc(tr('tracker.deleteSchedule'))}" aria-label="${esc(tr('tracker.deleteScheduleAria', { title: event.title }))}">✕</button>`;
        return `<div class="task"><button type="button" class="tt history-link" data-act="schedule" data-id="${esc(event.id)}"><b>${esc(event.title)}</b><span>${esc(relDay(date, today))} · ${timeOf(event.start)}–${timeOf(event.end)} · ${esc(where)}</span></button><div class="acts"><span class="chip">${esc(tr('common.version', { count: historyIndex.scheduleVersions(event.id).length }))}</span>${history}</div></div>`;
      })
      .join('');
    const deletedRows = deletedIds
      .map((id) => {
        const snapshot = historyIndex.scheduleLatest(id);
        if (!snapshot) return '';
        return `<div class="task history-record"><button type="button" class="tt history-link" data-act="schedule" data-id="${esc(id)}"><b>${esc(snapshot.title)}</b><span>${esc(fmtDay(snapshot.date))} · ${esc(snapshot.start)}–${esc(snapshot.end)}</span></button><div class="acts"><span class="chip">${esc(tr('tracker.deletedHistory'))}</span></div></div>`;
      })
      .join('');
    return [
      `${this.back$()}<div class="ptitle">${esc(tr('tracker.localSchedules'))} <button class="linkbtn" data-act="new-schedule">${esc(tr('tracker.addSchedule'))}</button></div><p class="hint">${esc(tr('tracker.schedulesHint'))}</p><div class="rows">${rows || `<p class="empty">${esc(tr('tracker.noSchedules'))}</p>`}</div>${deletedRows ? `<div class="sect">${esc(tr('tracker.deletedSchedules'))} <small>${deletedIds.length}</small></div><div class="rows">${deletedRows}</div>` : ''}`,
      tr('tracker.localSchedules'),
      tr('tracker.schedulesSub', { count: events.length, archived: deletedIds.length }),
    ];
  }

  private schedule(id: string): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const current = s.data.events.find((event) => event.id === id && event.sourceId === LOCAL_CALENDAR_SOURCE_ID);
    const history = buildLifeBookIndex(s.data);
    const snapshot = history.scheduleLatest(id);
    if (!snapshot) return [`${this.back$(tr('tracker.localSchedules'))}<p class="empty">${esc(tr('tracker.scheduleUnavailable'))}</p>`, tr('tracker.schedule'), tr('tracker.historyUnavailable')];
    const versions = history.scheduleVersions(id);
    const life = history.entries({ type: 'schedule', id });
    const settled = s.data.entries.some((entry) => entry.itemType === 'event' && entry.itemId === id);
    const where = snapshot.projectId === CHORES
      ? tr('common.choresLife')
      : snapshot.projectId
        ? s.project(snapshot.projectId)?.name ?? tr('common.closedProject')
        : tr('common.unclassified');
    const versionRows = versions
      .slice()
      .reverse()
      .map((version, index) => {
        const label = version.kind === 'created' ? tr('tracker.firstVersion') : tr('tracker.revision', { count: versions.length - index - 1 });
        const v = version.snapshot;
        return `<details class="revision"><summary>${label} · ${esc(fmtDay(version.recordedOn))}<span>${esc(fmtDay(v.date))} ${esc(v.start)}–${esc(v.end)}</span></summary><div class="revision-body"><b>${esc(v.title)}</b><br>${esc(v.projectId === CHORES ? tr('common.choresLife') : s.project(v.projectId)?.name ?? tr('common.unclassified'))}</div></details>`;
      })
      .join('');
    const html = `
      ${this.back$(tr('tracker.localSchedules'))}
      <div class="who"><div class="emblem" style="background:#7397a722">◷</div><div><div class="fname">${esc(snapshot.title)}</div><div class="fmeta">${esc(fmtDay(snapshot.date))} · ${esc(snapshot.start)}–${esc(snapshot.end)} · ${esc(where)}</div></div></div>
      <div class="chips"><span class="chip ${current ? 'ok' : 'warn'}">${esc(tr(current ? 'tracker.currentSchedule' : 'tracker.deleted'))}</span>${settled ? `<span class="chip">${esc(tr('tracker.settledFact'))}</span>` : ''}<span class="chip">${esc(tr('common.versions', { count: versions.length }))}</span></div>
      ${current && !settled ? `<div class="btnrow"><button class="btn small primary" data-act="edit-schedule" data-id="${esc(id)}">${esc(tr('common.edit'))}</button><button class="btn small danger" data-act="delete-schedule" data-id="${esc(id)}">${esc(tr('tracker.deleteSchedule'))}</button></div>` : ''}
      <div class="sect">${esc(tr('common.versionHistory'))} <small>${versions.length}</small></div>
      ${versionRows || `<p class="empty">${esc(tr('tracker.noVersionSnapshots'))}</p>`}
      <div class="sect">${esc(tr('common.history'))} <small>${life.length}</small></div>
      ${lifeList(life, today)}`;
    return [html, snapshot.title, current ? tr('tracker.scheduleLifeBook') : tr('tracker.deletedHistory')];
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
        ? `<span class="chip ${stage ? 'warn' : 'ok'}">${esc(stageName(stage))}</span>`
        : p.status === 'closed'
          ? `<span class="chip warn">${esc(tr('tracker.closedUnfinished'))}</span>`
          : `<span class="chip ok">${esc(tr(p.resting === 'landmark' ? 'tracker.completedLandmark' : 'tracker.completedArchive'))}</span>`,
      v?.postponePenalty ? `<span class="chip warn">${esc(tr('tracker.postponePenalty'))}</span>` : '',
      active && stage === 3 ? `<span class="chip warn">${esc(tr('tracker.mayAbandon'))}</span>` : '',
      `<span class="chip">${esc(tr('tracker.houses', { count: houseCount(s, p.id) }))}</span>`,
    ].join('');
    const progressAt = lastProgressAt(s.data, p.id);
    const since = progressAt ? diffDays(progressAt, today) : null;
    const taskRows = open
      .map((t) => {
        const late = t.scheduledFor && t.scheduledFor < today;
        const meta = [t.scheduledFor ? relDay(t.scheduledFor, today) + (late ? ' · ' + tr('tracker.overdue') : '') : tr('tracker.noDate'), t.postponeCount ? tr('tracker.postponedCount', { count: t.postponeCount }) : '', stage === 3 ? tr('tracker.mayAbandon') : ''].filter(Boolean).join(' · ');
        return `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span class="${late ? 'late' : ''}">${esc(meta)}</span></div>${active ? `<div class="acts"><button class="iconbtn" data-act="done" data-id="${esc(t.id)}" title="${esc(tr('tracker.doneToday'))}" aria-label="${esc(tr('tracker.doneToday'))}">✓</button><button class="iconbtn" data-act="resched" data-id="${esc(t.id)}" title="${esc(tr('tracker.reschedule'))}" aria-label="${esc(tr('tracker.reschedule'))}">📅</button><button class="iconbtn" data-act="drop" data-id="${esc(t.id)}" title="${esc(tr('tracker.notImportant'))}" aria-label="${esc(tr('tracker.notImportant'))}">✕</button></div>` : ''}</div>`;
      })
      .join('');
    const life = lifeBookEntries(s.data, { type: 'project', id: p.id }, stageLifeEntries(s.data, today));
    const html = `
      ${this.back$()}
      <div class="who"><div class="emblem">${emblem(roofOf(p.islandSlot), active ? stage : 2)}</div><div><div class="fname">${esc(p.name)}</div><div class="fmeta">${esc(tr('tracker.projectStarted', { date: fmtDay(p.createdAt), days: diffDays(p.createdAt, today), closed: p.closedAt ? tr('tracker.projectClosedAt', { date: fmtDay(p.closedAt) }) : '', done: p.doneAt ? tr('tracker.projectDoneAt', { date: fmtDay(p.doneAt) }) : '' }))}</div></div></div>
      <div class="chips">${chips}</div>
      ${
        p.status === 'done'
          ? `<div class="sect">${esc(tr('tracker.lifeSummary'))}</div>${summaryHTML(summarize(s.data, p, p.doneAt ?? today), true)}`
          : `<div class="nums"><div><b>${open.length}</b><span>${esc(tr('tracker.incomplete'))}</span></div><div><b>${done.length}</b><span>${esc(tr('tracker.completed'))}</span></div><div><b>${since ?? '—'}</b><span>${esc(tr('tracker.sinceProgressDays'))}</span></div></div>`
      }
      ${p.closeReason ? `<p class="hint">${esc(tr('tracker.stopReason', { reason: p.closeReason }))}</p>` : ''}
      ${active && !open.length && done.length ? `<div class="ready"><span>${esc(tr('tracker.readyCeremony'))}</span><button class="btn small primary" data-act="complete" data-id="${esc(p.id)}">${esc(tr('tracker.ceremony'))}</button></div>` : ''}
      ${p.status === 'done' ? '' : `<div class="sect">${esc(tr('tracker.tasksHere'))} <small>${open.length}</small></div>`}
      ${active ? `<form class="add" data-form="ptask" data-id="${esc(p.id)}"><input name="ptask" placeholder="${esc(tr('tracker.addTaskPlaceholder'))}" autocomplete="off" aria-label="${esc(tr('tracker.newTaskAria'))}">${dateSelect('pdate', today, { current: today, withNone: true, mode: 'task' })}<button class="btn primary">${esc(tr('common.add'))}</button></form>` : ''}
      ${p.status === 'done' ? '' : `<div>${taskRows || (active ? `<p class="empty">${esc(tr('tracker.villageEmpty'))}</p>` : '')}</div>`}
      ${done.length ? `<details class="hint"><summary>${esc(tr('tracker.completedTasks', { count: done.length }))}</summary>${done.map((t) => `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span>${t.closedAt ? fmtDay(t.closedAt) : ''}</span></div></div>`).join('')}</details>` : ''}
      <div class="sect">${esc(tr('common.history'))} <small>${life.length}</small></div>
      ${lifeList(life, today)}
      <div class="btnrow">
        ${active ? `<button class="btn small primary" data-act="complete" data-id="${esc(p.id)}">${esc(tr('tracker.completeProject'))}</button>` : ''}
        ${active ? `<button class="btn small" data-act="rename" data-id="${esc(p.id)}">${esc(tr('tracker.rename'))}</button>` : ''}
        ${active && stage >= 1 ? `<button class="btn small" data-act="prompt" data-id="${esc(p.id)}">${esc(tr('tracker.restartTrim'))}</button>` : ''}
        ${active ? `<button class="btn small danger" data-act="close" data-id="${esc(p.id)}">${esc(tr('tracker.closeProject'))}</button>` : ''}
        ${p.status === 'closed' ? `<button class="btn small" data-act="reopen" data-id="${esc(p.id)}">${esc(tr('tracker.reopen'))}</button>` : ''}
        ${p.status === 'done' && p.resting === 'landmark' ? `<button class="btn small" data-act="rest" data-to="archive" data-id="${esc(p.id)}">${esc(tr('tracker.moveArchive'))}</button>` : ''}
        ${p.status === 'done' && p.resting !== 'landmark' ? `<button class="btn small primary" data-act="rest" data-to="landmark" data-id="${esc(p.id)}">${esc(tr('tracker.makeLandmarkAgain'))}</button>` : ''}
      </div>`;
    return [html, p.name, active ? stageName(stage) + ` · ${tr('tracker.openTasks', { count: open })}` : p.status === 'done' ? tr(p.resting === 'landmark' ? 'tracker.landmark' : 'tracker.archiveRecord') : tr('tracker.closed')];
  }

  private task(t: TaskView): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const p = s.project(t.projectId);
    const late = t.status === 'open' && t.scheduledFor && t.scheduledFor < today;
    const statusChip = t.status === 'open' ? `<span class="chip ok">${esc(tr('tracker.inProgress'))}</span>` : t.status === 'done' ? `<span class="chip ok">${esc(tr('tracker.completed'))}</span>` : `<span class="chip">${esc(tr('tracker.dropped'))}</span>`;
    const entries = s.data.entries.filter((e) => e.itemType === 'task' && e.itemId === t.id);
    const life = lifeBookEntries(s.data, { type: 'task', id: t.id }, stageLifeEntries(s.data, today));
    const projOpts = s.activeProjects().map((x) => `<option value="${esc(x.id)}"${x.id === t.projectId ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const html = `
      ${this.back$(p ? p.name : tr('tracker.dock'))}
      <div class="who"><div class="emblem" style="background:${p ? roofOf(p.islandSlot) + '22' : 'var(--chip)'}">${p ? '🧑‍🌾' : '⛵'}</div><div><div class="fname">${esc(t.title)}</div><div class="fmeta">${p ? esc(tr('tracker.livesIn', { name: p.name })) : esc(tr('tracker.waitingDock'))} · ${esc(tr('tracker.arrivedAt', { date: fmtDay(t.createdAt) }))}</div></div></div>
      <div class="chips">${statusChip}${t.scheduledFor ? `<span class="chip ${late ? 'warn' : ''}">${relDay(t.scheduledFor, today)}${late ? ' · ' + esc(tr('tracker.overdue')) : ''}</span>` : `<span class="chip">${esc(tr('tracker.noDate'))}</span>`}${t.postponeCount ? `<span class="chip warn">${esc(tr('tracker.postponedCount', { count: t.postponeCount }))}</span>` : ''}</div>
      <div class="nums"><div><b>${entries.filter((e) => e.outcome !== 'skipped').length}</b><span>${esc(tr('tracker.did'))}</span></div><div><b>${entries.filter((e) => e.outcome === 'skipped').length}</b><span>${esc(tr('tracker.didNot'))}</span></div><div><b>${diffDays(t.createdAt, today)}</b><span>${esc(tr('tracker.daysOnIsland'))}</span></div></div>
      ${
        t.status === 'open'
          ? `<form class="add" data-form="tedit" data-id="${esc(t.id)}"><select name="tproj" aria-label="${esc(tr('tracker.projectVillageAria'))}"><option value="">${esc(tr('tracker.dockOption'))}</option>${projOpts}</select>${dateSelect('tdate', today, { current: t.scheduledFor, withNone: true, mode: 'task' })}<button class="btn small">${esc(tr('common.save'))}</button></form>
             <div class="btnrow">${p ? `<button class="btn small primary" data-act="done" data-id="${esc(t.id)}">${esc(tr('tracker.doneToday'))}</button>` : ''}<button class="btn small" data-act="trename" data-id="${esc(t.id)}">${esc(tr('tracker.rename'))}</button><button class="btn small" data-act="drop" data-id="${esc(t.id)}">${esc(tr('tracker.notImportant'))}</button></div>`
          : ''
      }
      <div class="sect">${esc(tr('common.history'))}</div>
      ${lifeList(life, today)}`;
    return [html, t.title, p ? p.name : tr('tracker.dock')];
  }

  private dock(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const ships = s.tasks().filter((t) => t.status === 'open' && !t.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const overdue = s.tasks().filter((t) => t.status === 'open' && t.projectId && t.scheduledFor && t.scheduledFor < today).sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));
    const projOpts = s.activeProjects().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const shipRows = ships
      .map(
        (t) => `<form class="ship" data-form="arrange" data-id="${esc(t.id)}"><b>⛵ ${esc(t.title)}</b><div class="ctl"><select name="aproj" aria-label="${esc(tr('tracker.villageAria'))}">${projOpts || `<option value="">${esc(tr('tracker.buildVillageFirst'))}</option>`}</select>${dateSelect('adate', today, { current: t.scheduledFor, withNone: true, mode: 'task' })}<button class="btn small primary"${projOpts ? '' : ' disabled'}>${esc(tr('tracker.arrange'))}</button><button type="button" class="btn small" data-act="decline" data-id="${esc(t.id)}">${esc(tr('tracker.decline'))}</button></div></form>`,
      )
      .join('');
    const ints = interruptions(s.data).sort((a, b) => b.date.localeCompare(a.date));
    const week = ints.filter((i) => i.date > addDays(today, -7));
    const byProj = new Map<string, number>();
    for (const i of week) byProj.set(i.projectId ?? '', (byProj.get(i.projectId ?? '') ?? 0) + 1);
    const topP = [...byProj.entries()].sort((a, b) => b[1] - a[1])[0];
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">${esc(tr('tracker.dock'))} <small>${esc(tr('tracker.dockShips', { count: ships.length }))}</small></div>
      <p class="pdesc">${esc(tr('tracker.dockDesc'))}</p>
      <form class="add" data-form="quick"><input name="quick" placeholder="${esc(tr('tracker.anotherThing'))}" autocomplete="off" aria-label="${esc(tr('tracker.newTaskAria'))}"><input type="hidden" name="qproj" value=""><button class="btn primary">${esc(tr('tracker.land'))}</button></form>
      ${shipRows || `<p class="empty">${esc(tr('tracker.noShips'))}</p>`}
      <div class="sect">${esc(tr('tracker.overdueIncomplete'))} <small>${overdue.length}</small></div>
      ${
        overdue
          .map((t) => {
            const p = s.project(t.projectId);
            return `<div class="task"><div class="tt" data-act="task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><span class="late">${esc(p?.name ?? '')} · ${esc(tr('tracker.originally', { date: relDay(t.scheduledFor!, today) }))}</span></div><div class="acts"><button class="btn small" data-act="to-today" data-id="${esc(t.id)}">${esc(tr('tracker.toToday'))}</button><button class="iconbtn" data-act="resched" data-id="${esc(t.id)}" aria-label="${esc(tr('tracker.reschedule'))}" title="${esc(tr('tracker.reschedule'))}">📅</button><button class="iconbtn" data-act="drop" data-id="${esc(t.id)}" aria-label="${esc(tr('tracker.notImportant'))}" title="${esc(tr('tracker.notImportant'))}">✕</button></div></div>`;
          })
          .join('') || `<p class="empty">${esc(tr('tracker.noOverdue'))}</p>`
      }
      <div class="sect">${esc(tr('tracker.interruptions'))} <small>${esc(tr('tracker.last7Days', { count: week.length }))}</small></div>
      ${week.length && topP ? `<p class="hint">${esc(topP[0] ? tr('tracker.interruptionHintProject', { name: s.project(topP[0])?.name ?? tr('common.closedProject'), count: topP[1] }) : tr('tracker.interruptionHintChores', { count: topP[1] }))}</p>` : ''}
      ${ints.length ? `<ol class="life">${ints.slice(0, 30).map((i) => `<li><time>${esc(relDay(i.date, today))}</time><span>${esc(i.title)}${i.projectId ? ` · ${esc(s.project(i.projectId)?.name ?? '')}` : ''}</span></li>`).join('')}</ol>` : `<p class="empty">${esc(tr('tracker.noInterruptions'))}</p>`}`;
    return [html, tr('tracker.dock'), tr('tracker.dockSub', { count: ships.length })];
  }

  private granary(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const g = granary(s.data, today);
    const evs = s.data.events.filter((e) => !e.allDay && dateOfStamp(e.start) === today).sort((a, b) => a.start.localeCompare(b.start));
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">${esc(tr('tracker.granary'))} <small>${esc(tr('tracker.granarySubhead'))}</small></div>
      <div class="nums"><div><b>${g.available.toFixed(1)}</b><span>${esc(tr('tracker.availableHours'))}</span></div><div><b>${g.scheduledHours.toFixed(1)}</b><span>${esc(tr('tracker.scheduledHours'))}</span></div><div><b>${Math.round(g.factor * 100)}%</b><span>${esc(tr('tracker.energy'))}</span></div></div>
      <p class="hint">${esc(tr('tracker.granaryHint', { start: s.data.settings.workStart, end: s.data.settings.workEnd, extra: g.noEnergy ? tr('tracker.granaryHintExtra', { count: g.noEnergy }) : '' }))}</p>
      <div class="sect">${esc(tr('tracker.todayCalendar'))} <small>${evs.length}</small></div>
      ${evs.map((e) => `<div class="task"><div class="tt"><b>${esc(e.title)}</b><span>${timeOf(e.start)}–${timeOf(e.end)} · ${esc(e.projectId === CHORES ? tr('common.chores') : s.project(e.projectId)?.name ?? tr('common.unclassified'))}</span></div></div>`).join('') || `<p class="empty">${esc(tr('tracker.noCalendarToday'))}</p>`}
      <div class="btnrow"><button class="btn small" data-act="settings">${esc(tr('tracker.adjustHours'))}</button></div>`;
    return [html, tr('tracker.granary'), tr('tracker.availableSub', { hours: g.available.toFixed(1) })];
  }

  private coastRow(): string {
    const s = this.store;
    const marks = s.data.projects.filter((p) => p.status === 'done' && p.resting === 'landmark').length;
    const books = s.data.projects.filter((p) => (p.status === 'done' && p.resting !== 'landmark') || p.status === 'closed').length;
    if (!marks && !books) return '';
    return `<div class="sect">${esc(tr('tracker.coastLighthouse'))}</div><button class="row" data-act="archive"><i class="sw" style="background:#c8473a"></i><span class="tx"><b>${esc(tr('tracker.coastMeta', { marks, books }))}</b><span>${esc(tr('tracker.coastHint'))}</span></span><span class="end">›</span></button>`;
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
        .map(([y, list]) => `<div class="year">${esc(tr('tracker.yearBooks', { year: y, count: list.length }))}</div><div class="rows">${list.sort((a, b) => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? '')).map((p) => row(p, meta(p))).join('')}</div>`)
        .join('');
    };
    const span = (p: Project, end?: string) => (end ? tr('tracker.projectSpan', { start: fmtDay(p.createdAt), end: fmtDay(end), days: diffDays(p.createdAt, end) + 1 }) : tr('tracker.projectStartOnly', { date: fmtDay(p.createdAt) }));
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">${esc(tr('tracker.lighthouse'))} <small>${esc(tr('tracker.archive'))}</small></div>
      <p class="pdesc">${esc(tr('tracker.archiveDesc'))}</p>
      <div class="sect">${esc(tr('tracker.landmarks'))} <small>${marks.length}</small></div>
      <div class="rows">${marks.map((p) => row(p, span(p, p.doneAt))).join('') || `<p class="empty">${esc(tr('tracker.noLandmarks'))}</p>`}</div>
      <div class="sect">${esc(tr('tracker.completedBooks'))} <small>${books.length}</small></div>
      ${byYear(books, (p) => p.doneAt, (p) => span(p, p.doneAt)) || `<p class="empty">${esc(tr('tracker.emptyShelf'))}</p>`}
      <div class="sect">${esc(tr('tracker.unfinishedBooks'))} <small>${closed.length}</small></div>
      ${byYear(closed, (p) => p.closedAt, (p) => span(p, p.closedAt) + (p.closeReason ? ' · ' + p.closeReason : '')) || `<p class="empty">${esc(tr('tracker.noUnfinished'))}</p>`}`;
    return [html, tr('tracker.archive'), tr('tracker.archiveSub', { marks: marks.length, books: books.length + closed.length })];
  }

  private chores(): [string, string, string] {
    const s = this.store;
    const today = s.today();
    const evs = s.data.events.filter((e) => e.projectId === CHORES && !e.allDay && dateOfStamp(e.start) > addDays(today, -7) && dateOfStamp(e.start) <= addDays(today, 7)).sort((a, b) => a.start.localeCompare(b.start));
    const projOpts = s.activeProjects().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const html = `
      ${this.back$()}
      <div class="ptitle" style="margin-top:8px">${esc(tr('tracker.choresArea'))} <small>${esc(tr('tracker.choresSubhead'))}</small></div>
      <p class="pdesc">${esc(tr('tracker.choresDesc'))}</p>
      ${evs.map((e) => `<div class="task"><div class="tt"><b>${esc(e.title)}</b><span>${relDay(dateOfStamp(e.start), today)} ${timeOf(e.start)}</span></div><div class="acts"><select data-act-change="evproj" data-id="${esc(e.id)}" aria-label="${esc(tr('tracker.changeOwnershipAria'))}"><option value="">${esc(tr('common.chores'))}</option>${projOpts}</select></div></div>`).join('') || `<p class="empty">${esc(tr('tracker.noRecentChores'))}</p>`}`;
    return [html, tr('tracker.choresArea'), tr('tracker.eventsCount', { count: evs.length })];
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
          toast(t.projectId ? tr('forms.taskVillageToast', { task: t.title, project: s.project(t.projectId)?.name ?? '' }) : tr('forms.taskDockToast', { task: t.title }));
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
          toast(tr('forms.taskVillageToast', { task: t?.title ?? '', project: s.project(pid)?.name ?? '' }));
          break;
        }
        case 'tedit': {
          const id = f.dataset.id!;
          const pid = String(fd.get('tproj') ?? '') || undefined;
          const sel = f.querySelector<HTMLSelectElement>('select[name=tdate]')!;
          A.editTaskPlan(s, id, pid, readDate(sel));
          toast(tr('tracker.saved'));
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
      case 'diary':
        this.open({ kind: 'diary', id });
        break;
      case 'schedules':
        this.open({ kind: 'schedules' });
        break;
      case 'schedule':
        this.open({ kind: 'schedule', id });
        break;
      case 'edit-diary':
        this.editDiary(id);
        break;
      case 'edit-schedule':
        this.editSchedule(id);
        break;
      case 'delete-diary': {
        const entry = s.data.diaries.find((item) => item.id === id);
        if (!entry) break;
        const context = s.captureWriteContext();
        const ok = await confirmModal({
          title: tr('tracker.deleteDiaryTitle'),
          text: tr('tracker.deleteDiaryText', { preview: `${fmtDay(entry.date)} · ${entry.text.length > 80 ? entry.text.slice(0, 79) + '…' : entry.text}` }),
          ok: tr('common.delete'),
          danger: true,
        });
        if (!ok || !context.isCurrent()) break;
        A.deleteDiary(s, id);
        toast(tr('tracker.diaryDeleted'));
        break;
      }
      case 'delete-schedule': {
        const event = s.data.events.find((item) => item.id === id && item.sourceId === LOCAL_CALENDAR_SOURCE_ID);
        if (!event) break;
        if (s.data.entries.some((entry) => entry.itemType === 'event' && entry.itemId === id)) {
          toast(tr('tracker.scheduleSettledDeleteError'), true);
          break;
        }
        const context = s.captureWriteContext();
        const ok = await confirmModal({
          title: tr('tracker.deleteScheduleTitle', { title: event.title }),
          text: tr('tracker.deleteScheduleText', { date: fmtDay(dateOfStamp(event.start)), start: timeOf(event.start), end: timeOf(event.end) }),
          ok: tr('common.delete'),
          danger: true,
        });
        if (!ok || !context.isCurrent()) break;
        try {
          A.deleteSchedule(s, id);
          toast(tr('tracker.scheduleDeleted'));
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
        if (t) toast(tr('tracker.taskDoneToast', { title: t.title }));
        break;
      }
      case 'drop': {
        const t = s.task(id);
        A.dropTask(s, id);
        if (t) toast(tr('tracker.taskDroppedToast', { title: t.title }));
        break;
      }
      case 'decline': {
        const t = s.task(id);
        A.declineTask(s, id);
        if (t) toast(tr('tracker.taskDeclinedToast', { title: t.title }));
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
        if (p) this.renameDialog(tr('tracker.renameVillageTitle'), p.name, (n) => A.renameProject(s, id, n));
        break;
      }
      case 'trename': {
        const t = s.task(id);
        if (t) this.renameDialog(tr('tracker.renameTaskTitle'), t.title, (n) => A.renameTask(s, id, n));
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
          toast(tr(el.dataset.to === 'landmark' ? 'tracker.landmarkAgainToast' : 'tracker.archiveToast'));
        } catch (err) {
          if (err instanceof A.ActionError) toast(err.message, true);
        }
        break;
      case 'reopen':
        try {
          A.reopenProject(s, id);
          toast(tr('tracker.reopenToast'));
        } catch (err) {
          if (err instanceof A.ActionError) toast(err.message, true);
        }
        break;
    }
  }

  bindChange() {
    this.body.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.dataset.actChange !== 'evproj') return;
      try {
        A.setEventProject(this.store, el.dataset.id!, el.value || undefined);
      } catch (err) {
        if (err instanceof A.ActionError) {
          toast(err.message, true);
          this.render();
        } else {
          throw err;
        }
      }
    });
  }

  private editDiary(id: string) {
    const s = this.store;
    const entry = s.data.diaries.find((item) => item.id === id);
    if (!entry) return;
    const today = s.today();
    openModal({
      title: tr('tracker.editDiary'),
      body: `<form data-f="edit-diary"><label class="field">${esc(tr('tracker.recordDate'))}${dateSelect('date', today, { current: entry.date, withNone: false, mode: 'diary' })}</label><label class="field">${esc(tr('tracker.body'))}<textarea name="text" class="history-editor" autofocus>${esc(entry.text)}</textarea></label><p class="hint">${esc(tr('tracker.newVersionHint'))}</p><div class="actions"><button type="button" class="btn" data-close>${esc(tr('common.cancel'))}</button><button class="btn primary">${esc(tr('tracker.saveNewVersion'))}</button></div></form>`,
      mount(box) {
        bindDateSelects(box, today);
        box.querySelector<HTMLFormElement>('form')!.addEventListener('submit', (event) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const fd = new FormData(form);
          const date = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!) ?? entry.date;
          try {
            A.editDiary(s, id, { date, text: String(fd.get('text') ?? '') });
            closeModal(false);
            toast(tr('tracker.diaryNewVersionToast'));
          } catch (err) {
            if (err instanceof A.ActionError) toast(err.message, true);
            else throw err;
          }
        });
      },
    });
  }

  private editSchedule(id: string) {
    const s = this.store;
    const event = s.data.events.find((item) => item.id === id && item.sourceId === LOCAL_CALENDAR_SOURCE_ID);
    if (!event) return;
    const today = s.today();
    const date = dateOfStamp(event.start);
    const activeProjects = s.activeProjects();
    const currentProject = event.projectId && event.projectId !== CHORES ? s.project(event.projectId) : undefined;
    const projects = currentProject && !activeProjects.some((project) => project.id === currentProject.id)
      ? [currentProject, ...activeProjects]
      : activeProjects;
    const projectOptions = projects
      .map((project) => `<option value="${esc(project.id)}"${project.id === event.projectId ? ' selected' : ''}>${esc(project.name)}${project.status === 'active' ? '' : tr('tracker.closedSuffix')}</option>`)
      .join('');
    openModal({
      title: tr('tracker.editSchedule'),
      body: `<form data-f="edit-schedule"><label class="field">${esc(tr('tracker.scheduleTitle'))}<input name="title" value="${esc(event.title)}" autocomplete="off" autofocus></label><label class="field">${esc(tr('tracker.date'))}${dateSelect('date', today, { current: date, withNone: false, mode: 'schedule' })}</label><div class="capture-time-grid"><label class="field">${esc(tr('tracker.start'))}<input name="start" type="time" value="${timeOf(event.start)}"></label><label class="field">${esc(tr('tracker.end'))}<input name="end" type="time" value="${timeOf(event.end)}"></label></div><label class="field">${esc(tr('tracker.project'))}<select name="proj"><option value="${CHORES}"${event.projectId === CHORES ? ' selected' : ''}>${esc(tr('common.choresLife'))}</option>${projectOptions}</select></label><p class="hint">${esc(tr('tracker.scheduleVersionHint'))}</p><div class="actions"><button type="button" class="btn" data-close>${esc(tr('common.cancel'))}</button><button class="btn primary">${esc(tr('tracker.saveNewVersion'))}</button></div></form>`,
      mount(box) {
        bindDateSelects(box, today);
        box.querySelector<HTMLFormElement>('form')!.addEventListener('submit', (submitEvent) => {
          submitEvent.preventDefault();
          const form = submitEvent.currentTarget as HTMLFormElement;
          const fd = new FormData(form);
          const nextDate = readDate(form.querySelector<HTMLSelectElement>('select[name=date]')!) ?? date;
          try {
            A.editSchedule(s, id, {
              title: String(fd.get('title') ?? ''),
              date: nextDate,
              start: String(fd.get('start') ?? ''),
              end: String(fd.get('end') ?? ''),
              projectId: String(fd.get('proj') ?? CHORES),
            });
            closeModal(false);
            toast(tr('tracker.scheduleNewVersionToast'));
          } catch (err) {
            if (err instanceof A.ActionError) toast(err.message, true);
            else throw err;
          }
        });
      },
    });
  }

  private renameDialog(title: string, cur: string, save: (n: string) => void) {
    openModal({
      title,
      body: `<form data-f><label class="field">${esc(tr('tracker.renameName'))}<input name="n" value="${esc(cur)}" autofocus autocomplete="off"></label><div class="actions"><button type="button" class="btn" data-close>${esc(tr('forms.nevermind'))}</button><button class="btn primary">${esc(tr('common.save'))}</button></div></form>`,
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
      [today, tr('date.today')],
      [addDays(today, 1), tr('date.tomorrow')],
      [addDays(today, 2), tr('date.dayAfterTomorrow')],
      [addDays(today, 7), tr('dateSelect.weekLater')],
      ['', tr('dateSelect.none')],
    ];
    openModal({
      title: tr('tracker.rescheduleTitle', { title: t.title }),
      body: `<p class="hint">${esc(tr('tracker.rescheduleHint'))}</p><div class="btnrow">${quick.map(([d, l]) => `<button class="btn small" data-d="${d}">${l}</button>`).join('')}</div><label class="field">${esc(tr('dateSelect.orPick'))}<input type="date" name="d" min="${addDays(today, -30)}" value="${t.scheduledFor ?? ''}"></label><div class="actions"><button class="btn" data-close>${esc(tr('forms.nevermind'))}</button><button class="btn primary" data-ok>${esc(tr('tracker.ok'))}</button></div>`,
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
      kick: tr('tracker.finalDecision'),
      title: tr('tracker.closeTitle', { name: p.name }),
      body: `<p>${esc(tr('tracker.closeBody', { open: open ? tr('tracker.closeOpenTasks', { count: open }) : '' }))}</p><label class="field">${esc(tr('tracker.closeReasonLabel'))}<textarea name="r" placeholder="${esc(tr('tracker.closeReasonPlaceholder'))}"></textarea></label><div class="actions"><button class="btn" data-close>${esc(tr('tracker.keepOpen'))}</button><button class="btn danger" data-ok>${esc(tr('tracker.closeProject'))}</button></div>`,
      mount: (box) => {
        box.querySelector('[data-ok]')!.addEventListener('click', () => {
          A.closeProject(s, id, box.querySelector<HTMLTextAreaElement>('textarea')!.value);
          closeModal(false);
          toast(tr('tracker.unfinishedToast', { name: p.name }));
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
  const reasonKeys = {
    interrupted: 'reason.interrupted',
    no_energy: 'reason.noEnergy',
    not_important: 'reason.notImportant',
    postponed: 'reason.postponed',
  } as const;
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const label = r.reason ? tr(reasonKeys[r.reason]) : '';
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const why = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => tr('tracker.reasonCount', { reason, count }))
    .join(' · ');
  let chosen = false;
  openModal({
    kick: tr(v?.stage === 3 ? 'tracker.leavingKick' : 'tracker.needsYouKick'),
    title: tr('tracker.nextTitle', { name: p.name }),
    body: `<p>${v ? esc(tr('tracker.stalledDays', { days: v.daysSinceProgress })) : ''}${why ? esc(tr('tracker.pastReasons', { reasons: why })) : ''}${esc(tr('tracker.projectPersists'))}</p>
      <button class="opt" data-c="restart"><b>${esc(tr('tracker.restart'))}</b><span>${esc(tr('tracker.restartDesc'))}</span></button>
      <button class="opt" data-c="trim"><b>${esc(tr('tracker.trim'))}</b><span>${esc(tr('tracker.trimDesc'))}</span></button>
      <button class="opt" data-c="close"><b>${esc(tr('tracker.closeProject'))}</b><span>${esc(tr('tracker.closeDesc'))}</span></button>
      <button class="linkbtn" data-c="later">${esc(tr('tracker.later'))}</button>`,
    mount(box) {
      box.querySelectorAll<HTMLElement>('[data-c]').forEach((b) =>
        b.addEventListener('click', async () => {
          chosen = true;
          const c = b.dataset.c;
          if (c === 'restart') {
            A.restartProject(store, p.id);
            closeModal(false);
            toast(tr('tracker.restartToast', { name: p.name }));
            onDone();
          } else if (c === 'later') {
            A.snoozePrompt(store, p.id);
            closeModal(false);
            onDone();
          } else if (c === 'trim') {
            openModal({
              title: tr('tracker.trimTitle', { name: p.name }),
              body: `<p>${esc(tr('tracker.trimBody'))}</p><div class="checklist">${open.map((t) => `<label><input type="checkbox" value="${esc(t.id)}" checked> ${esc(t.title)}</label>`).join('') || `<p class="empty">${esc(tr('tracker.noOpenTasks'))}</p>`}</div><div class="actions"><button class="btn" data-close>${esc(tr('forms.nevermind'))}</button><button class="btn primary" data-ok>${esc(tr('tracker.justSo'))}</button></div>`,
              mount(b2) {
                b2.querySelector('[data-ok]')!.addEventListener('click', () => {
                  const drop = [...b2.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((x) => !x.checked).map((x) => x.value);
                  A.trimProject(store, p.id, drop);
                  closeModal(false);
                  toast(tr('tracker.trimToast', { name: p.name }));
                  onDone();
                });
              },
              onClose: onDone,
            });
          } else if (c === 'close') {
            const context = store.captureWriteContext();
            const ok = await confirmModal({ kick: tr('tracker.finalDecision'), title: tr('tracker.closeTitle', { name: p.name }), text: tr('tracker.closeConfirmText'), ok: tr('tracker.closeProject'), danger: true });
            if (!context.isCurrent()) return;
            if (ok) {
              A.closeProject(store, p.id, why ? tr('tracker.longStallReason', { reason: why }) : tr('tracker.longStall'));
              toast(tr('tracker.unfinishedToast', { name: p.name }));
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
