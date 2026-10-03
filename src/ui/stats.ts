import type { Store } from '../store';
import { $, setText } from './dom';
import { backlog, backlogSeries, condition, conditionSeries, granary, progress } from '../logic/metrics';
import { addDays, hmToMinutes } from '../lib/date';
import { dateOfStamp } from '../lib/date';

const STATS = [
  { k: 'granary', n: '粮仓', u: '小时' },
  { k: 'progress', n: '推进度', u: '件 / 7天' },
  { k: 'backlog', n: '积压', u: '件' },
  { k: 'condition', n: '状态', u: '%' },
] as const;

export function buildStats() {
  $('stats').innerHTML = STATS.map(
    (s) =>
      `<div class="card stat" id="st-${s.k}"><div class="top"><span>${s.n}</span><span id="st-${s.k}-r"></span></div><div class="mid"><div class="val"><span id="st-${s.k}-v"></span><small>${s.u}</small></div><svg viewBox="0 0 72 26" preserveAspectRatio="none" aria-hidden="true"><path id="st-${s.k}-p" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></div><div class="foot" id="st-${s.k}-f"></div></div>`,
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
    `工作时段 ${d.settings.workStart}–${d.settings.workEnd}`,
    g.noEnergy ? `日历已排 ${fmtH(g.scheduledHours)} 小时；近 7 天没精力 ${g.noEnergy} 次，少排一些` : `日历已排 ${fmtH(g.scheduledHours)} 小时（${todayEvents} 个事件），共 ${fmtH((we - ws) / 60)} 小时`,
    gSeries,
    g.workHours > 0 && g.available / g.workHours < 0.2,
  );

  const p = progress(d, today);
  set('progress', fmtH(p.week), `今天 ${fmtH(p.series[p.series.length - 1])}`, '近 7 天确认做了的条目，做了一部分算半件', p.series);

  const b = backlog(d, today);
  set('backlog', String(b.total), `码头 ${b.dock}　过期 ${b.overdue}`, b.total ? '码头上待安排的 + 过了日期还没做完的' : '码头清空，没有过期的事', backlogSeries(d, today), b.total >= 10);

  const c = condition(d, today);
  set('condition', c.ratio == null ? '—' : String(Math.round(c.ratio * 100)), c.settled ? `${c.good} / ${c.settled} 条` : '还没有结算记录', '近 7 天已结算条目里，做了和做了一部分的占比', conditionSeries(d, today), c.ratio != null && c.ratio < 0.4);
}
