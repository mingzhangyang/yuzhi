import type { Store } from '../store';
import { $, setText } from './dom';
import { backlog, backlogSeries, condition, conditionSeries, granary, progress } from '../logic/metrics';
import { addDays, hmToMinutes } from '../lib/date';
import { dateOfStamp } from '../lib/date';
import { t } from '../i18n';

const STATS = [
  { k: 'granary', n: 'stats.granary', u: 'stats.hours' },
  { k: 'progress', n: 'stats.progress', u: 'stats.items7d' },
  { k: 'backlog', n: 'stats.backlog', u: 'stats.items' },
  { k: 'condition', n: 'stats.condition', u: null },
] as const;

export function buildStats() {
  $('stats').innerHTML = STATS.map(
    (s) =>
      `<div class="card stat" id="st-${s.k}"><div class="top"><span>${t(s.n)}</span><span id="st-${s.k}-r"></span></div><div class="mid"><div class="val"><span id="st-${s.k}-v"></span><small>${s.u ? t(s.u) : '%'}</small></div><svg viewBox="0 0 72 26" preserveAspectRatio="none" aria-hidden="true"><path id="st-${s.k}-p" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></div><div class="foot" id="st-${s.k}-f"></div></div>`,
  ).join('');
}

function spark(a: number[]): string {
  if (a.length < 2) return '';
  let mn = Math.min(...a);
  let mx = Math.max(...a);
  if (mx - mn < 1e-6) {
    mx += 1;
    mn -= 1;
  }
  return a.map((v, i) => `${i ? 'L' : 'M'}${((i / (a.length - 1)) * 72).toFixed(1)},${(24 - ((v - mn) / (mx - mn)) * 22).toFixed(1)}`).join('');
}

const fmtH = (h: number) => (Math.round(h * 10) / 10).toString();

export function updateStats(store: Store) {
  const today = store.today();
  const d = store.data;
  const set = (k: string, v: string, r: string, f: string, series: number[], warn = false) => {
    setText($(`st-${k}-v`), v);
    setText($(`st-${k}-r`), r);
    setText($(`st-${k}-f`), f);
    $(`st-${k}-p`).setAttribute('d', spark(series));
    $(`st-${k}`).classList.toggle('warn', warn);
  };

  const g = granary(d, today);
  const gSeries: number[] = [];
  for (let k = 13; k >= 0; k--) {
    const day = addDays(today, -k);
    gSeries.push(granary(d, day).available);
  }
  const ws = hmToMinutes(d.settings.workStart);
  const we = hmToMinutes(d.settings.workEnd);
  const todayEvents = d.events.filter((e) => !e.allDay && dateOfStamp(e.start) === today).length;
  set(
    'granary',
    fmtH(g.available),
    t('stats.workHours', { start: d.settings.workStart, end: d.settings.workEnd }),
    g.noEnergy
      ? t('stats.scheduledTired', { scheduled: fmtH(g.scheduledHours), count: g.noEnergy })
      : t('stats.scheduled', { scheduled: fmtH(g.scheduledHours), events: todayEvents, hours: fmtH((we - ws) / 60) }),
    gSeries,
    g.workHours > 0 && g.available / g.workHours < 0.2,
  );

  const p = progress(d, today);
  set('progress', fmtH(p.week), t('stats.today', { value: fmtH(p.series[p.series.length - 1]) }), t('stats.progressFoot'), p.series);

  const b = backlog(d, today);
  set('backlog', String(b.total), t('stats.backlogRight', { dock: b.dock, overdue: b.overdue }), b.total ? t('stats.backlogFoot') : t('stats.backlogEmpty'), backlogSeries(d, today), b.total >= 10);

  const c = condition(d, today);
  set('condition', c.ratio == null ? '—' : String(Math.round(c.ratio * 100)), c.settled ? t('stats.settled', { good: c.good, settled: c.settled }) : t('stats.noSettlements'), t('stats.conditionFoot'), conditionSeries(d, today), c.ratio != null && c.ratio < 0.4);
}
