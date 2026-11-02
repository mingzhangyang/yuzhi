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
import { t, type MessageKey } from '../i18n';
import { isTopLayer, popLayer, pushLayer } from './layer';
import { ICON } from './icons';
import { MARKER } from '../island/render/style';

const REASONS: SkipReason[] = ['interrupted', 'no_energy', 'not_important', 'postponed'];
const REASON_KEYS: Record<SkipReason, MessageKey> = {
  interrupted: 'reason.interrupted',
  no_energy: 'reason.noEnergy',
  not_important: 'reason.notImportant',
  postponed: 'reason.postponed',
};
const SWIPE = 72;

export interface SettleHooks {
  /** 做了：一块砖从卡片飞进村落 */
  brick(projectId: string, from: DOMRect): void;
  onOpenChange(open: boolean): void;
  /** 一天结算完成并已交给持久层（例如触发自动备份） */
  settled?(date: ISODate): void;
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export class SettleSheet {
  private date: ISODate = '';
  /** 每一天的草稿：key → 决定 */
  private drafts = new Map<ISODate, Map<string, A.Decision>>();
  /** 草稿里用「还做了别的事…」拉进来的任务：提交前不改动任务本身 */
  private pulled = new Map<ISODate, Set<string>>();
  private box = $('settleBox');
  /** 上一次画的是哪一天：换天时滚动回到顶部 */
  private renderedDate: ISODate | '' = '';
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
      if (e.key === 'Escape' && this.isOpen() && isTopLayer($('settle'))) this.close();
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
    const opening = !this.isOpen();
    $('settle').hidden = false;
    pushLayer($('settle'));
    this.render();
    // 打开时焦点进入面板（标题所在的对话框本身），读屏先读到日期；再次 open（换到下一天）不抢焦点。
    if (opening) this.box.focus?.({ preventScroll: true });
    this.hooks.onOpenChange(true);
  }

  close() {
    $('settle').hidden = true;
    popLayer($('settle'));
    this.hooks.onOpenChange(false);
  }

  /**
   * 失去写权限时调用：草稿和拉进来的任务属于旧的写者快照，
   * 接管后重新加载的数据上不能再提交它们。普通关闭仍保留草稿。
   */
  discard() {
    this.cancelDrag();
    this.drafts.clear();
    this.pulled.clear();
    if (this.isOpen()) this.close();
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
    const base = itemsForDay(this.store.data, this.date);
    const have = new Set(base.map((it) => it.key));
    for (const id of this.pulled.get(this.date) ?? []) {
      const t = this.store.task(id);
      const key = `task|${id}`;
      if (!t || t.status !== 'open' || !t.projectId || have.has(key)) continue;
      base.push({ key, type: 'task', id, title: t.title, projectId: t.projectId });
    }
    return base;
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

    const tabs = days.map((x) => `<button type="button" data-day="${x}" class="${x === this.date ? 'on' : ''}" aria-pressed="${x === this.date}">${esc(relDay(x, today))}${x < today ? `<small class="fog-tag">${esc(t('settle.fogTag'))}</small>` : ''}</button>`).join('');
    const cards = items.map((it) => this.card(it, d.get(it.key))).join('');
    const extra = s.tasks().filter((t) => t.status === 'open' && t.projectId && s.project(t.projectId)?.status === 'active' && t.scheduledFor !== this.date && !this.pulled.get(this.date)?.has(t.id)).slice(0, 80);
    // Tasks planned for a later day stay available (doing one early is a real
    // thing to record) but are grouped apart and labelled with their planned
    // day, so tomorrow's work is not counted for this day by accident (YZ-F5).
    const due = extra
      .filter((task) => !task.scheduledFor || task.scheduledFor < this.date)
      .sort((a, b) => (a.scheduledFor ?? '9999').localeCompare(b.scheduledFor ?? '9999'));
    const ahead = extra
      .filter((task) => task.scheduledFor && task.scheduledFor > this.date)
      .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));
    const option = (task: (typeof extra)[number]) => {
      const planned = task.scheduledFor ? t('settle.extraPlanned', { date: relDay(task.scheduledFor, today) }) : t('settle.extraUndated');
      return `<option value="${task.id}">${esc(task.title)} · ${esc(s.project(task.projectId)?.name ?? '')} · ${esc(planned)}</option>`;
    };
    const group = (label: MessageKey, tasks: typeof extra) =>
      tasks.length ? `<optgroup label="${esc(t(label))}">${tasks.map(option).join('')}</optgroup>` : '';
    const extraSel = extra.length
      ? `<div class="sextra"><select data-pull aria-label="${esc(t('settle.extraAria'))}"><option value="">${esc(t(this.date === today ? 'settle.extraToday' : 'settle.extraDay'))}</option>${group('settle.extraDue', due)}${group('settle.extraAhead', ahead)}</select></div>`
      : '';
    // 整块重写会换掉滚动容器和按钮：同一天里保留列表滚动位置和键盘焦点，
    // 否则在长列表底部每标一条都会跳回顶部。
    const sameDay = this.renderedDate === this.date;
    const scroll = sameDay ? this.box.querySelector?.<HTMLElement>('.slist')?.scrollTop ?? 0 : 0;
    const focus = this.focusSelector();
    this.renderedDate = this.date;
    this.box.innerHTML = `
      <div class="shead">
        <div class="kick"><span>${esc(t(this.date < today ? 'settle.catchUpKick' : 'settle.eveningKick'))}</span><button class="x" data-act="close" aria-label="${esc(t('common.close'))}">×</button></div>
        <h2 id="settleT">${fmtDay(this.date)} ${weekday(this.date)}${settled ? ` <small style="font-size:12px;color:var(--faint)">${esc(t('settle.reviewed'))}</small>` : ''}</h2>
        ${days.length > 1 ? `<div class="daytabs">${tabs}</div>` : ''}
      </div>
      <div class="sbar"><span>${esc(t('settle.progress', { count: items.length, confirmed }))}</span>${items.length ? `<button class="btn small" data-act="all">${esc(t('settle.allDone'))}</button>` : ''}</div>
      <div class="slist">${cards || `<div class="sempty">${esc(t('settle.empty'))}<br>${esc(t(extra.length ? 'settle.emptyExtra' : 'settle.emptyQuiet'))}</div>`}${extraSel}</div>
      <div class="sfoot"><span class="grow">${items.length ? (left ? esc(t('settle.gestureLeft', { count: left })) : esc(t('settle.allConfirmed'))) : ''}</span><button class="btn dusk" data-act="commit">${esc(t(settled ? 'settle.update' : 'settle.complete'))}</button></div>`;
    const list = this.box.querySelector?.<HTMLElement>('.slist');
    if (list && scroll) list.scrollTop = scroll;
    if (focus) this.box.querySelector?.<HTMLElement>(focus)?.focus({ preventScroll: true });
  }

  /** 当前焦点在面板里的哪个控件：重绘后按同样的条目和动作找回来 */
  private focusSelector(): string | null {
    if (typeof HTMLElement === 'undefined') return null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.box.contains(active)) return null;
    const attr = ['data-set', 'data-reason', 'data-day', 'data-act', 'data-pull'].find((name) => active.hasAttribute(name));
    if (!attr) return null;
    const own = `[${attr}="${CSS.escape(active.getAttribute(attr) ?? '')}"]`;
    const item = active.closest<HTMLElement>('.sitem');
    return item?.dataset.key ? `.sitem[data-key="${CSS.escape(item.dataset.key)}"] ${own}` : own;
  }

  private card(it: SettleItem, dec: A.Decision | undefined) {
    const s = this.store;
    const p = it.projectId && it.projectId !== CHORES ? s.project(it.projectId) : undefined;
    const color = p ? roofOf(p.islandSlot) : it.projectId === CHORES ? MARKER.chores : 'var(--line)';
    const where = p ? p.name : it.projectId === CHORES ? t('common.chores') : it.type === 'event' ? t('common.unclassified') : '';
    const meta = [it.type === 'event' && it.start ? `${timeOf(it.start)}–${timeOf(it.end!)} · ${t('settle.calendar')}` : t('settle.task'), where].filter(Boolean).join(' · ');
    const o = dec?.outcome;
    const reasons =
      o === 'skipped'
        ? `<div class="reasons">${REASONS.map((r) => `<button data-reason="${r}" class="${dec?.reason === r ? 'on' : ''}">${esc(t(REASON_KEYS[r]))}</button>`).join('')}</div>`
        : '';
    return `<div class="sitem ${o ? 'o-' + o : ''}" data-key="${esc(it.key)}" data-project="${esc(p?.id ?? '')}">
      <div class="swipe"><div class="under"><span class="l">${esc(t('settle.done'))} ✓</span><span class="r">${esc(t('settle.skipped'))}</span></div>
      <div class="scard"><i class="sw" style="background:${color}"></i><div class="tx"><b>${esc(it.title)}</b><span>${esc(meta)}${o === 'done' ? ' · ' + t('settle.done') : o === 'partial' ? ' · ' + t('settle.partial') : o === 'skipped' ? ' · ' + t('settle.skipped') : ''}</span></div>
      <div class="st"><button class="d ${o === 'done' ? 'on' : ''}" data-set="done" aria-label="${esc(t('settle.done'))}" title="${esc(t('settle.done'))}">${ICON.check}</button><button class="p ${o === 'partial' ? 'on' : ''}" data-set="partial" aria-label="${esc(t('settle.partial'))}" title="${esc(t('settle.partial'))}">½</button><button class="s ${o === 'skipped' ? 'on' : ''}" data-set="skipped" aria-label="${esc(t('settle.skipped'))}" title="${esc(t('settle.skipped'))}">${ICON.cross}</button></div></div></div>
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
    if (!this.pulled.has(this.date)) this.pulled.set(this.date, new Set());
    this.pulled.get(this.date)!.add(id);
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
    // Preserve the rendered pulled items before pullIntoDay writes a
    // today-dated reschedule. Historical itemsForDay(date) intentionally
    // cannot see that future-semantic operation.
    const pulledItems = this.items().filter((item) => this.pulled.get(date)?.has(item.id) && d.has(item.key));
    const text = this.store.batch(() => {
      for (const id of this.pulled.get(date) ?? []) if (d.has(`task|${id}`)) A.pullIntoDay(this.store, id, date);
      return A.settleDay(this.store, date, d, pulledItems);
    });
    this.drafts.delete(date);
    this.pulled.delete(date);
    toast(text);
    this.hooks.settled?.(date);
    const rest = pendingDays(this.store.data, this.store.today());
    if (rest.length) this.open(rest[0]);
    else this.close();
  }
}
