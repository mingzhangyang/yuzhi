/**
 * 落成仪式：项目完成的那一刻小岛暂停，显示一生之书的小结，
 * 由用户选择去处——立为海岸上的地标，或收进山顶灯塔里的档案馆。
 */
import type { Store } from '../store';
import type { Project } from '../types';
import { $, esc, toast } from './dom';
import * as A from '../actions';
import { summarize, type ProjectSummary } from '../logic/summary';
import { fmtDay } from '../lib/date';
import { formatFullDate, t as tr } from '../i18n';

const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fullDate = (d: string) => formatFullDate(d);

/** 一生之书小结（落成仪式与已完成项目页共用） */
export function summaryHTML(s: ProjectSummary, compact = false): string {
  const blockers = s.blockers.length
    ? `<ul class="sum-list">${s.blockers.map((b) => `<li><span>${esc(b.text)}</span><b>${esc(tr(b.count === 1 ? 'ceremony.occurrence' : 'ceremony.occurrences', { count: b.count }))}</b></li>`).join('')}</ul>`
    : `<p class="empty">${esc(tr('ceremony.smoothBlockers'))}</p>`;
  const turns = s.turns.length
    ? `<ol class="sum-turns">${s.turns.map((t) => `<li><time>${esc(fmtDay(t.date))}</time><span>${esc(t.text)}</span></li>`).join('')}</ol>`
    : `<p class="empty">${esc(tr('ceremony.smoothTurns'))}</p>`;
  return `
    <div class="sum-nums">
      <div><b>${s.days}</b><span>${esc(tr('ceremony.days'))}</span></div>
      <div><b>${s.tasksDone}</b><span>${esc(tr('ceremony.tasksDone'))}</span></div>
      <div><b>${fmtN(s.bricks)}</b><span>${esc(tr('ceremony.bricks'))}</span></div>
      <div><b>${s.postpones}</b><span>${esc(tr('ceremony.postpones'))}</span></div>
    </div>
    <p class="hint">${esc(tr('ceremony.span', { start: fullDate(s.start), end: s.end !== s.start ? tr('ceremony.toDate', { date: fullDate(s.end) }) : '', active: s.activeDays }))}</p>
    <div class="sect">${esc(tr('ceremony.blockers'))}</div>${blockers}
    ${compact && !s.turns.length ? '' : `<div class="sect">${esc(tr('ceremony.turns'))}</div>${turns}`}`;
}

export interface CeremonyHooks {
  /** 小岛暂停 / 继续 */
  pause(on: boolean): void;
  /** 选择完成后（村落已腾空） */
  done(p: Project, where: 'landmark' | 'archive'): void;
}

export class Ceremony {
  private root = $('ceremony');
  private box = $('ceremonyBox');
  private id = '';

  constructor(private store: Store, private hooks: CeremonyHooks) {
    this.box.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  isOpen() {
    return !this.root.hidden;
  }

  open(p: Project) {
    if (p.status !== 'active') return;
    this.id = p.id;
    const s = this.store;
    const today = s.today();
    const sum = summarize(s.data, p, today);
    const open = s.tasks().filter((t) => t.projectId === p.id && t.status === 'open').length;
    this.box.innerHTML = `
      <div class="chead">
        <div class="kick"><span>${esc(tr('ceremony.kick'))}</span><button class="x" data-act="close" aria-label="${esc(tr('ceremony.deferAria'))}">×</button></div>
        <h2 id="ceremonyT">「${esc(p.name)}」</h2>
        <p class="csub">${esc(tr('ceremony.subtitle'))}</p>
      </div>
      <div class="cbody">
        ${summaryHTML(sum)}
        ${open ? `<p class="hint cnote">${esc(tr('ceremony.openTasks', { count: open }))}</p>` : ''}
        <div class="sect">${esc(tr('ceremony.destination'))}</div>
        <button class="opt" data-go="landmark"><b>${esc(tr('ceremony.landmarkTitle'))}</b><span>${esc(tr('ceremony.landmarkBody'))}</span></button>
        <button class="opt" data-go="archive"><b>${esc(tr('ceremony.archiveTitle'))}</b><span>${esc(tr('ceremony.archiveBody'))}</span></button>
        <p class="hint">${esc(tr('ceremony.reversible'))}</p>
      </div>
      <div class="cfoot"><button class="linkbtn" data-act="close">${esc(tr('ceremony.notDone'))}</button></div>`;
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    this.hooks.pause(true);
    this.box.querySelector<HTMLElement>('[data-go="landmark"]')?.focus();
  }

  close() {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    document.body.style.overflow = '';
    this.hooks.pause(false);
  }

  private onClick(e: Event) {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="close"]')) {
      this.close();
      return;
    }
    const go = t.closest<HTMLElement>('[data-go]')?.dataset.go as 'landmark' | 'archive' | undefined;
    if (!go) return;
    try {
      const where = A.completeProject(this.store, this.id, go);
      const p = this.store.project(this.id)!;
      this.close();
      if (go === 'landmark' && where === 'archive') toast(tr('ceremony.noCoast'), true);
      else toast(where === 'landmark' ? tr('ceremony.landmarkToast', { name: p.name }) : tr('ceremony.archiveToast', { name: p.name }));
      this.hooks.done(p, where);
    } catch (err) {
      if (err instanceof A.ActionError) toast(err.message, true);
      else throw err;
      this.close();
    }
  }
}
