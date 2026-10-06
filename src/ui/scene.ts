import type { Store } from '../store';
import type { AgendaView, ChoresView, Light, Scene, Selection, VillageView } from '../island/render';
import { CHORES } from '../types';
import { BRICKS_PER_HOUSE, DRIFT_BOTTLES_MAX, MAX_WALKERS } from '../logic/config';
import { granary, progressWeight } from '../logic/metrics';
import { pendingDays, settlementProjectId } from '../logic/days';
import { agendaAt, woodpileStep, type Agenda, type AgendaSlot } from '../logic/agenda';
import { islandRings } from '../actions';
import { addDays, localDate, seasonOf } from '../lib/date';
import { readSeenDrifts } from './drift';
import { cultivationAreas, cultivationState } from '../logic/cultivation';
import { t } from '../i18n';

/** 村落的屋顶颜色，按槽位固定 */
export const ROOFS = ['#b5553d', '#4c6a84', '#3f7a86', '#8656a6', '#c08a2a', '#5d8a4a', '#a8622a', '#6b5ca5'];
export const roofOf = (slot: number) => ROOFS[slot % ROOFS.length];

const WALK_SHARE = [1, 0.6, 0.35, 0.25];

export function lightNow(now: Date, dusk: boolean): Light {
  const h = now.getHours() + now.getMinutes() / 60;
  if (h >= 20.5 || h < 5.5) return 'night';
  if (dusk || h >= 17.5) return 'dusk';
  return 'day';
}

export function houseCount(store: Store, projectId: string): number {
  let bricks = 0;
  for (const e of store.data.entries) if (e.projectId === projectId) bricks += progressWeight(e);
  return Math.min(10, 1 + Math.floor(bricks / BRICKS_PER_HOUSE));
}

function phaseOf(slot: AgendaSlot): AgendaView['phase'] | null {
  if (slot.live.length) return 'live';
  if (slot.soon.length) return 'soon';
  if (slot.ended) return 'ended';
  if (slot.later) return 'later';
  return slot.banners.length ? 'allday' : null;
}

function agendaViewOf(slot: AgendaSlot | undefined): AgendaView | undefined {
  if (!slot) return undefined;
  const phase = phaseOf(slot);
  if (!phase) return undefined;
  const live = slot.live[0];
  const soon = slot.soon[0];
  return {
    phase,
    title: live?.title ?? soon?.title,
    until: live?.end,
    start: live ? undefined : soon?.start,
    later: slot.later,
    ended: slot.ended,
    banners: slot.banners,
    live: slot.live,
    soon: slot.soon,
  };
}

function choresOf(store: Store, agenda: Agenda, today: string): ChoresView {
  const slot = agenda.slots.get(CHORES);
  // 柴堆只算真正做了的杂务；没做的不留柴
  const cutoff = addDays(today, -7);
  const count = store.data.entries.filter((entry) =>
    (entry.outcome === 'done' || entry.outcome === 'partial')
      && entry.date > cutoff && entry.date <= today
      && settlementProjectId(store.data, entry) === CHORES,
  ).length;
  const live = slot?.live[0];
  const soon = slot?.soon[0];
  return {
    count,
    woodpile: woodpileStep(count),
    live: live ? { title: live.title, until: live.end } : undefined,
    soon: soon ? { title: soon.title, start: soon.start } : undefined,
    later: slot?.later ?? 0,
    ended: slot?.ended ?? 0,
  };
}

function granaryBusy(store: Store, now: Date): boolean {
  const at = now.getTime();
  const [sh, sm] = store.data.settings.workStart.split(':').map(Number);
  const [eh, em] = store.data.settings.workEnd.split(':').map(Number);
  const minute = now.getHours() * 60 + now.getMinutes();
  const start = (sh || 0) * 60 + (sm || 0);
  const end = (eh || 0) * 60 + (em || 0);
  return minute >= start && minute < end && store.data.events.some((event) => {
    if (event.allDay) return false;
    const a = new Date(event.start).getTime();
    const b = new Date(event.end).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && a <= at && at < b;
  });
}

export function buildScene(
  store: Store,
  selected: Selection | null,
  dusk: boolean,
  now: Date = store.clock(),
  agenda: Agenda = agendaAt(store.data, now),
): Scene {
  const today = localDate(now);
  const villages = store.villages(today);
  const views: VillageView[] = [];
  for (const p of store.activeProjects()) {
    const v = villages.get(p.id);
    if (!v) continue;
    const open = store.tasks().filter((t) => t.projectId === p.id && t.status === 'open');
    const shown = open.length ? Math.max(1, Math.min(MAX_WALKERS, Math.ceil(open.length * WALK_SHARE[v.stage]))) : 0;
    views.push({
      slot: p.islandSlot,
      projectId: p.id,
      name: p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name,
      roof: roofOf(p.islandSlot),
      stage: v.stage,
      houses: houseCount(store, p.id),
      walkers: open.slice(0, shown).map((t) => ({ id: t.id, title: t.title })),
      extra: open.length - shown,
      openCount: open.length,
      agenda: agendaViewOf(agenda.slots.get(p.id)),
      firedToday: agenda.fired.get(p.id) ?? 0,
    });
  }
  const g = granary(store.data, today);
  const pending = pendingDays(store.data, today).length;
  const chores = choresOf(store, agenda, today);
  const seen = readSeenDrifts();
  return {
    season: seasonOf(today),
    light: lightNow(now, dusk),
    date: today,
    hour: now.getHours() + now.getMinutes() / 60,
    now: now.getTime(),
    villages: views,
    dockShips: store.tasks().filter((t) => t.status === 'open' && !t.projectId).length,
    choresCount: chores.count,
    chores,
    cultivation: cultivationAreas(cultivationState(store.data, today)),
    drifting: agenda.drifting.filter((title) => !seen.has(title)).slice(0, DRIFT_BOTTLES_MAX).map((title) => ({ title })),
    lighthouseBanners: agenda.lighthouseBanners,
    granaryBusy: granaryBusy(store, now),
    granaryRatio: g.workHours ? g.available / g.workHours : 0,
    granaryLabel: t('scene.granaryLabel', { hours: g.available.toFixed(1) }),
    fog: Math.min(1, pending * 0.4),
    selected,
    rings: islandRings(store),
    landmarks: store.data.projects
      .filter((p) => p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null)
      .map((p) => ({ projectId: p.id, name: p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name, roof: roofOf(p.islandSlot), index: p.landmarkIndex!, size: houseCount(store, p.id) })),
  };
}
