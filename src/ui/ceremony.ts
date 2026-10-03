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

const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fullDate = (d: string) => `${d.slice(0, 4)}年${fmtDay(d)}`;

/** 一生之书小结（落成仪式与已完成项目页共用） */
export function summaryHTML(s: ProjectSummary, compact = false): string {
  const blockers = s.blockers.length
    ? `<ul class="sum-list">${s.blockers.map((b) => `<li><span>${esc(b.text)}</span><b>${b.count} 次</b></li>`).join('')}</ul>`
    : '<p class="empty">一路顺利，没有明显的卡点。</p>';
  const turns = s.turns.length
    ? `<ol class="sum-turns">${s.turns.map((t) => `<li><time>${esc(fmtDay(t.date))}</time><span>${esc(t.text)}</span></li>`).join('')}</ol>`
    : '<p class="empty">平平稳稳，没有大的起伏。</p>';
  return `
    <div class="sum-nums">
      <div><b>${s.days}</b><span>用时（天）</span></div>
      <div><b>${s.tasksDone}</b><span>完成的事</span></div>
      <div><b>${fmtN(s.bricks)}</b><span>砖</span></div>
      <div><b>${s.postpones}</b><span>推迟</span></div>
    </div>
    <p class="hint">${fullDate(s.start)}立项${s.end !== s.start ? `，到${fullDate(s.end)}` : ''}；其中 ${s.activeDays} 天有真实推进。</p>
    <div class="sect">主要卡点</div>${blockers}
    ${compact && !s.turns.length ? '' : `<div class="sect">关键转折</div>${turns}`}`;
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
    const open = s.data.tasks.filter((t) => t.projectId === p.id && t.status === 'open').length;
    this.box.innerHTML = `
      <div class="chead">
        <div class="kick"><span>落成仪式</span><button class="x" data-act="close" aria-label="先不完成">×</button></div>
        <h2 id="ceremonyT">「${esc(p.name)}」</h2>
        <p class="csub">小岛暂停了一下。翻开这个项目的一生之书——</p>
      </div>
      <div class="cbody">
        ${summaryHTML(sum)}
        ${open ? `<p class="hint cnote">村里还有 ${open} 件没做完的事，会随项目完成一起放下，不算没做。</p>` : ''}
        <div class="sect">它的去处</div>
        <button class="opt" data-go="landmark"><b>立为地标</b><span>村落合成一座永久建筑，沿海岸建起。地标越多，岛会向外长出新陆地。</span></button>
        <button class="opt" data-go="archive"><b>收进档案馆</b><span>村落腾空，项目放进山顶的灯塔，可以按年份翻看。</span></button>
        <p class="hint">选择以后可以反悔：地标可以收进档案馆，档案里的项目也可以重新立起。</p>
      </div>
      <div class="cfoot"><button class="linkbtn" data-act="close">还没做完，先不完成</button></div>`;
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
      if (go === 'landmark' && where === 'archive') toast('海岸上已经没有空地了，先收进了档案馆', true);
      else toast(where === 'landmark' ? `「${p.name}」落成，立在了海岸上` : `「${p.name}」收进了山顶的灯塔`);
      this.hooks.done(p, where);
    } catch (err) {
      if (err instanceof A.ActionError) toast(err.message, true);
      else throw err;
      this.close();
    }
  }
}
