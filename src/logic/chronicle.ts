import type { Project, SettlementEntry } from '../types';
import { CHORES } from '../types';
import type { HistoryEvent } from '../history-types';
import { historyEvent } from '../history-types';
import { formatChronicleEvents, formatHistoryEvent } from '../history';
import { type Locale } from '../i18n';
import { type Stage } from './config';

export interface StageChange {
  project: Project;
  from: Stage;
  to: Stage;
}

export function stageChangeEvent(c: StageChange): HistoryEvent {
  if (c.to < c.from) {
    return c.to === 0
      ? historyEvent('history.chron.stageRecovered', { name: c.project.name })
      : historyEvent('history.chron.stageRecoveredSome', { name: c.project.name });
  }
  if (c.to === 1) return historyEvent('history.chron.stageQuiet', { name: c.project.name });
  if (c.to === 2) return historyEvent('history.chron.stageDusty', { name: c.project.name });
  return historyEvent('history.chron.stageLeaving', { name: c.project.name });
}

/** 阶段变化的一句话；语义事件负责在显示时选择语言。 */
export function stageChangeText(c: StageChange, target?: Locale): string {
  return formatHistoryEvent(stageChangeEvent(c), target);
}

/** 每天结算后自动写下的一组语义事件。 */
export function dayEvents(
  entries: SettlementEntry[],
  projects: Map<string, Project>,
  changes: StageChange[],
): HistoryEvent[] {
  const done = entries.filter((e) => e.outcome === 'done').length;
  const partial = entries.filter((e) => e.outcome === 'partial').length;
  const skipped = entries.filter((e) => e.outcome === 'skipped');
  const events: HistoryEvent[] = [];

  if (done + partial === 0) {
    events.push(historyEvent(entries.length ? 'history.chron.dayNoProgress' : 'history.chron.dayQuiet'));
  } else if (done) {
    events.push(historyEvent('history.chron.dayDone', { count: done }));
    if (partial) events.push(historyEvent('history.chron.dayPartialAlso', { count: partial }));
  } else {
    events.push(historyEvent('history.chron.dayPartialOnly', { count: partial }));
  }

  if (done + partial > 0) {
    const count = new Map<string, number>();
    for (const entry of entries) {
      if (entry.outcome !== 'skipped' && entry.projectId && entry.projectId !== CHORES) {
        count.set(entry.projectId, (count.get(entry.projectId) ?? 0) + 1);
      }
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    const project = top && projects.get(top[0]);
    if (project && count.size > 1) events.push(historyEvent('history.chron.dayTopProject', { name: project.name }));
  }

  for (const change of changes.filter((item) => item.to < item.from)) events.push(stageChangeEvent(change));
  for (const change of changes.filter((item) => item.to > item.from)) events.push(stageChangeEvent(change));

  const noEnergy = skipped.filter((entry) => entry.reason === 'no_energy').length;
  const dropped = skipped.filter((entry) => entry.reason === 'not_important').length;
  const interrupted = skipped.filter((entry) => entry.reason === 'interrupted').length;
  if (dropped) events.push(historyEvent('history.chron.dayDropped', { count: dropped }));
  if (interrupted) events.push(historyEvent('history.chron.dayInterrupted', { count: interrupted }));
  if (noEnergy) events.push(historyEvent('history.chron.dayNoEnergy'));
  return events;
}

/** 每天结算后自动写下的一行编年史。 */
export function dayLine(
  entries: SettlementEntry[],
  projects: Map<string, Project>,
  changes: StageChange[],
  target?: Locale,
): string {
  return formatChronicleEvents(dayEvents(entries, projects, changes), target);
}
