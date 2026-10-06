import type { Data, ISODate } from '../types';
import { addDays } from '../lib/date';
import { t } from '../i18n';

export type CultivationKind = 'field' | 'orchard' | 'pond' | 'garden';
export type CultivationLevel = 0 | 1 | 2 | 3 | 4;

export interface CultivationAreaState {
  kind: CultivationKind;
  name: string;
  level: CultivationLevel;
  score: number;
  summary: string;
}

export interface CultivationState {
  field: CultivationAreaState;
  orchard: CultivationAreaState;
  pond: CultivationAreaState;
  garden: CultivationAreaState;
}

const levelFrom = (score: number, t: readonly [number, number, number, number]): CultivationLevel =>
  score >= t[3] ? 4 : score >= t[2] ? 3 : score >= t[1] ? 2 : score >= t[0] ? 1 : 0;

/**
 * Cultivation is deliberately derived from durable life facts.
 * There is no second mutable "farm level" or "pond level" to keep in sync.
 */
export function cultivationState(data: Data, today: ISODate): CultivationState {
  const fieldStart = addDays(today, -13);
  let taskDone = 0;
  let taskPartial = 0;
  for (const entry of data.entries) {
    if (entry.itemType !== 'task' || entry.date < fieldStart || entry.date > today) continue;
    if (entry.outcome === 'done') taskDone++;
    else if (entry.outcome === 'partial') taskPartial++;
  }
  const fieldScore = taskDone * 2 + taskPartial;

  const orchardStart = addDays(today, -13);
  const timedEventIds = new Set(data.events.filter((event) => !event.allDay).map((event) => event.id));
  let eventDone = 0;
  let eventPartial = 0;
  let eventSkipped = 0;
  for (const entry of data.entries) {
    if (
      entry.itemType !== 'event' ||
      entry.date < orchardStart ||
      entry.date > today ||
      !timedEventIds.has(entry.itemId)
    ) continue;
    if (entry.outcome === 'done') eventDone++;
    else if (entry.outcome === 'partial') eventPartial++;
    else if (entry.outcome === 'skipped') eventSkipped++;
  }
  // Planning alone never grows the orchard. Only schedules that have passed
  // through settlement become cultivation facts.
  const orchardScore = eventDone * 2 + eventPartial + eventSkipped * 0.5;

  const pondStart = addDays(today, -13);
  const settledDays = new Set(
    data.days
      .filter((day) => day.status === 'settled' && day.date >= pondStart && day.date <= today)
      .map((day) => day.date),
  );

  const gardenStart = addDays(today, -29);
  const diaryDays = new Set(
    data.diaries
      .filter((entry) => entry.date >= gardenStart && entry.date <= today)
      .map((entry) => entry.date),
  );

  return {
    field: {
      kind: 'field',
      name: t('cultivation.field'),
      level: levelFrom(fieldScore, [1, 3, 7, 12]),
      score: fieldScore,
      summary: taskDone || taskPartial
        ? t('cultivation.fieldActive', { done: taskDone, partial: taskPartial })
        : t('cultivation.fieldIdle'),
    },
    orchard: {
      kind: 'orchard',
      name: t('cultivation.orchard'),
      level: levelFrom(orchardScore, [0.5, 2, 5, 9]),
      score: orchardScore,
      summary: eventDone || eventPartial || eventSkipped
        ? t('cultivation.orchardActive', { count: eventDone + eventPartial + eventSkipped, done: eventDone, partial: eventPartial, skipped: eventSkipped })
        : t('cultivation.orchardIdle'),
    },
    pond: {
      kind: 'pond',
      name: t('cultivation.pond'),
      level: levelFrom(settledDays.size, [1, 4, 8, 12]),
      score: settledDays.size,
      summary: settledDays.size
        ? t('cultivation.pondActive', { count: settledDays.size })
        : t('cultivation.pondIdle'),
    },
    garden: {
      kind: 'garden',
      name: t('cultivation.garden'),
      level: levelFrom(diaryDays.size, [1, 3, 7, 14]),
      score: diaryDays.size,
      summary: diaryDays.size
        ? t('cultivation.gardenActive', { count: diaryDays.size })
        : t('cultivation.gardenIdle'),
    },
  };
}

export const cultivationAreas = (state: CultivationState): CultivationAreaState[] => [
  state.field,
  state.orchard,
  state.pond,
  state.garden,
];
