import type { Store } from '../store';
import type { Light, Scene, Selection, VillageView } from '../island/render';
import { CHORES } from '../types';
import { BRICKS_PER_HOUSE, MAX_WALKERS } from '../logic/config';
import { granary, progressWeight } from '../logic/metrics';
import { pendingDays } from '../logic/days';
import { islandRings } from '../actions';
import { addDays, dateOfStamp, seasonOf } from '../lib/date';

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

export function buildScene(store: Store, selected: Selection | null, dusk: boolean): Scene {
  const today = store.today();
  const villages = store.villages();
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
    });
  }
  const g = granary(store.data, today);
  const pending = pendingDays(store.data, today).length;
  return {
    season: seasonOf(today),
    light: lightNow(store.clock(), dusk),
    villages: views,
    dockShips: store.tasks().filter((t) => t.status === 'open' && !t.projectId).length,
    choresCount: store.data.events.filter((e) => e.projectId === CHORES && !e.allDay && dateOfStamp(e.start) > addDays(today, -7) && dateOfStamp(e.start) <= today).length,
    granaryRatio: g.workHours ? g.available / g.workHours : 0,
    granaryLabel: `粮仓 ${g.available.toFixed(1)} 小时`,
    fog: Math.min(1, pending * 0.4),
    selected,
    rings: islandRings(store),
    landmarks: store.data.projects
      .filter((p) => p.status === 'done' && p.resting === 'landmark' && p.landmarkIndex != null)
      .map((p) => ({ projectId: p.id, name: p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name, roof: roofOf(p.islandSlot), index: p.landmarkIndex!, size: houseCount(store, p.id) })),
  };
}
