/**
 * 晚间结算：今天（和还没结算的日子）的事件与任务排成一列，每条只需一个动作。
 * 右滑 = 做了；左滑 = 没做（可选原因）；轻点 = 做了一部分。
 */
import type { Store } from '../store';
import type { ISODate, SkipReason } from '../types';
import { CHORES } from '../types';
import { $, esc, toast } from './dom';
import { roofOf } from './scene';
import * as A from '../actions';
import { itemsForDay, pendingDays, type SettleItem } from '../logic/days';
import { fmtDay, relDay, weekday } from '../lib/date';

const REASONS: SkipReason[] = ['interrupted', 'no_energy', 'not_important', 'postponed'];
const SWIPE = 72;

export interface SettleHooks {
  /** 做了：一块砖从卡片飞进村落 */
  brick(projectId: string, from: DOMRect): void;
  onOpenChange(open: boolean): void;
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export class SettleSheet {
  private date: ISODate = '';
  /** 每一天的草稿：key → 决定 */
  private drafts = new Map<ISODate, Map<string, A.Decision>>();
  private box = $('settleBox');
  private drag: { el: HTMLElement; key: string; x: number; y: number; dx: number; moved: boolean; locked: boolean; id: number } | null = null;

  constructor(private store: Store, private hooks: SettleHooks) {
    this.box.addEventListener('click', (e) => this.onClick(e));
    this.box.addEventListener('change', (e) => this.onChange(e));
    this.box.addEventListener('pointerdown', (e) => this.onDown(e));
    this.box.addEventListener('pointermove', (e) => this.onMove(e));
    this.box.addEventListener('pointerup', (e) => this.onUp(e));
    this.box.addEventListener('pointercancel', () => this.cancelDrag());
    $('settle').addEventListener('click', (e) => {
      if (e.target === $('settle')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  isOpen() {
    return !$('settle').hidden;
  }

  /** 可以结算的日子：还没结算的过去的日子（最早的在前）+ 今天 */
  days(): ISODate[] {
    return [...pendingDays(this.store.data, this.store.today()), this.store.today()];
  }

  open(date?: ISODate) {
    const days = this.days();
    this.date = date && days.includes(date) ? date : days[0];
    $('settle').hidden = false;
    document.body.style.overflow = 'hidden';
    this.render();
    this.hooks.onOpenChange(true);
  }

  close() {
    $('settle').hidden = true;
    document.body.style.overflow = '';
    this.hooks.onOpenChange(false);
  }

  private draft(): Map<string, A.Decision> {
    let d = this.drafts.get(this.date);
    if (!d) {
      d = new Map();
      for (const it of itemsForDay(this.store.data, this.date)) if (it.entry) d.set(it.key, { outcome: it.entry.outcome, reason: it.entry.reason });
      this.drafts.set(this.date, d);
    }
    return d;
  }

  private items(): SettleItem[] {
    return itemsForDay(this.store.data, this.date);
  }

  render() {
    if (!this.isOpen()) return;
    const s = this.store;
    const today = s.today();
    const days = this.days();
    if (!days.includes(this.date)) this.date = days[0];
    const items = this.items();
    const d = this.draft();
    const settled = s.data.days.find((x) => x.date === this.date)?.status === 'settled';
    const confirmed = items.filter((it) => d.has(it.key)).length;
    const left = items.length - confirmed;

    const tabs = days.map((x) => `<button data-day="${x}" class="${x === this.date ? 'on' : ''} ${x < today ? 'fog' : ''}">${esc(relDay(x, today))}</button>`).join('');
    const cards = items.map((it) => this.card(it, d.get(it.key))).join('');
    const extra = s.data.tasks.filter((t) => t.status === 'open' && t.projectId && s.project(t.projectId)?.status === 'active' && t.scheduledFor !== this.date).slice(0, 80);
    const extraSel = extra.length
      ? `<div class="sextra"><select data-pull aria-label="还做了别的事"><option value="">${this.date === today ? '今天' : '这天'}还做了别的事…</option>${extra.map((t) => `<option value="${t.id}">${esc(t.title)} · ${esc(s.project(t.projectId)?.name ?? '')}</option>`).join('')}</select></div>`
      : '';
    this.box.innerHTML = `
      <div class="shead">
        <div class="kick"><span>${this.date < today ? '海雾里的一天 · 补上记录' : '黄昏 · 晚间结算'}</span><button class="x" data-act="close" aria-label="关闭">×</button></div>
        <h2 id="settleT">${fmtDay(this.date)} ${weekday(this.date)}${settled ? ' <small style="font-size:12px;color:var(--faint)">已结算</small>' : ''}</h2>
        ${days.length > 1 ? `<div class="daytabs">${tabs}</div>` : ''}
      </div>
      <div class="sbar"><span>${items.length} 条 · 已确认 ${confirmed}</span>${items.length ? `<button class="btn small" data-act="all">全部做了</button>` : ''}</div>
      <div class="slist">${cards || `<div class="sempty">这一天没有排上日期的任务，也没有日历事件。<br>${extra.length ? '如果做了什么，可以从下面加进来。' : '安安静静的一天。'}</div>`}${extraSel}</div>
      <div class="sfoot"><span class="grow">${items.length ? (left ? `右滑做了 · 左滑没做 · 轻点做了一部分；还有 ${left} 条没确认` : '都确认好了') : ''}</span><button class="btn dusk" data-act="commit">${settled ? '更新结算' : '完成结算'}</button></div>`;
  }

  private card(it: SettleItem, dec: A.Decision | undefined) {
    const s = this.store;
    const p = it.projectId && it.projectId !== CHORES ? s.project(it.projectId) : undefined;
    const color = p ? roofOf(p.islandSlot) : it.projectId === CHORES ? '#8a8578' : 'var(--line)';
    const where = p ? p.name : it.projectId === CHORES ? '杂务' : it.type === 'event' ? '未归类' : '';
    const meta = [it.type === 'event' && it.start ? `${timeOf(it.start)}–${timeOf(it.end!)} · 日历` : '任务', where].filter(Boolean).join(' · ');
    const o = dec?.outcome;
    const reasons =
      o === 'skipped'
        ? `<div class="reasons">${REASONS.map((r) => `<button data-reason="${r}" class="${dec?.reason === r ? 'on' : ''}">${A.REASON_TEXT[r]}</button>`).join('')}</div>`
        : '';
    return `<div class="sitem ${o ? 'o-' + o : ''}" data-key="${esc(it.key)}" data-project="${esc(p?.id ?? '')}">
      <div class="swipe"><div class="under"><span class="l">做了 ✓</span><span class="r">没做</span></div>
      <div class="scard"><i class="sw" style="background:${color}"></i><div class="tx"><b>${esc(it.title)}</b><span>${esc(meta)}${o === 'done' ? ' · 做了' : o === 'partial' ? ' · 做了一部分' : o === 'skipped' ? ' · 没做' : ''}</span></div>
      <div class="st"><button class="d ${o === 'done' ? 'on' : ''}" data-set="done" aria-label="做了" title="做了">✓</button><button class="p ${o === 'partial' ? 'on' : ''}" data-set="partial" aria-label="做了一部分" title="做了一部分">½</button><button class="s ${o === 'skipped' ? 'on' : ''}" data-set="skipped" aria-label="没做" title="没做">✕</button></div></div></div>
      ${reasons}</div>`;
  }

  /** toggle：再次选同一个结果时取消 */
  private set(key: string, outcome: A.Decision['outcome'] | null, el?: HTMLElement, toggle = false) {
    const d = this.draft();
    const prev = d.get(key);
    if (!outcome || (toggle && prev?.outcome === outcome)) d.delete(key);
    else d.set(key, { outcome, reason: outcome === 'skipped' ? prev?.reason : undefined });
    if (outcome === 'done' && prev?.outcome !== 'done' && el) {
      const pid = el.dataset.project;
      if (pid) this.hooks.brick(pid, el.querySelector('.scard')!.getBoundingClientRect());
    }
    this.render();
  }

  /* ---------------- 滑动 ---------------- */

  private onDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('button, select')) return;
    const el = t.closest<HTMLElement>('.sitem');
    if (!el || !t.closest('.scard')) return;
    this.drag = { el, key: el.dataset.key!, x: e.clientX, y: e.clientY, dx: 0, moved: false, locked: false, id: e.pointerId };
  }

  private onMove(e: PointerEvent) {
    const g = this.drag;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        // 纵向滚动列表
        this.drag = null;
        return;
      }
      if (Math.abs(dx) < 8) return;
      g.moved = true;
      g.el.classList.add('dragging');
      try {
        g.el.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    }
    g.dx = Math.max(-150, Math.min(150, dx));
    (g.el.querySelector('.scard') as HTMLElement).style.transform = `translateX(${g.dx}px)`;
    g.el.classList.toggle('drag-r', g.dx > 12);
    g.el.classList.toggle('drag-l', g.dx < -12);
  }

  private onUp(e: PointerEvent) {
    const g = this.drag;
    if (!g || e.pointerId !== g.id) return;
    this.drag = null;
    const card = g.el.querySelector('.scard') as HTMLElement;
    g.el.classList.remove('dragging', 'drag-r', 'drag-l');
    card.style.transform = '';
    if (!g.moved) {
      // 轻点 = 做了一部分（再点一次取消）
      this.set(g.key, 'partial', g.el, true);
      return;
    }
    if (g.dx > SWIPE) this.set(g.key, 'done', g.el);
    else if (g.dx < -SWIPE) this.set(g.key, 'skipped', g.el);
  }

  private cancelDrag() {
    if (!this.drag) return;
    const el = this.drag.el;
    el.classList.remove('dragging', 'drag-r', 'drag-l');
    (el.querySelector('.scard') as HTMLElement).style.transform = '';
    this.drag = null;
  }

  /* ---------------- 按钮 ---------------- */

  private onClick(e: Event) {
    const t = e.target as HTMLElement;
    const day = t.closest<HTMLElement>('[data-day]');
    if (day) {
      this.date = day.dataset.day!;
      this.render();
      return;
    }
    const setb = t.closest<HTMLElement>('[data-set]');
    if (setb) {
      const el = setb.closest<HTMLElement>('.sitem')!;
      this.set(el.dataset.key!, setb.dataset.set as A.Decision['outcome'], el, true);
      return;
    }
    const rb = t.closest<HTMLElement>('[data-reason]');
    if (rb) {
      const key = rb.closest<HTMLElement>('.sitem')!.dataset.key!;
      const d = this.draft();
      const cur = d.get(key);
      const r = rb.dataset.reason as SkipReason;
      d.set(key, { outcome: 'skipped', reason: cur?.reason === r ? undefined : r });
      this.render();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') this.close();
    else if (act === 'all') this.allDone();
    else if (act === 'commit') this.commit();
  }

  private onChange(e: Event) {
    const sel = e.target as HTMLSelectElement;
    if (!sel.matches('[data-pull]') || !sel.value) return;
    const id = sel.value;
    A.pullIntoDay(this.store, id, this.date);
    this.draft().set(`task|${id}`, { outcome: 'done' });
    this.render();
    const el = this.box.querySelector<HTMLElement>(`.sitem[data-key="task|${CSS.escape(id)}"]`);
    if (el?.dataset.project) this.hooks.brick(el.dataset.project, el.querySelector('.scard')!.getBoundingClientRect());
  }

  /** 「全部做了」：一次确认全部（已单独标过的例外保留） */
  private allDone() {
    const d = this.draft();
    const els = [...this.box.querySelectorAll<HTMLElement>('.sitem')];
    let k = 0;
    for (const el of els) {
      const key = el.dataset.key!;
      if (d.has(key)) continue;
      d.set(key, { outcome: 'done' });
      if (el.dataset.project) {
        const rect = el.querySelector('.scard')!.getBoundingClientRect();
        const pid = el.dataset.project;
        setTimeout(() => this.hooks.brick(pid, rect), 70 * k++);
      }
    }
    this.render();
  }

  private commit() {
    const date = this.date;
    const d = this.draft();
    const text = A.settleDay(this.store, date, d);
    this.drafts.delete(date);
    toast(text);
    const rest = pendingDays(this.store.data, this.store.today());
    if (rest.length) this.open(rest[0]);
    else this.close();
  }
}
