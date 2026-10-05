import type { Data, ISODate } from '../types';
import { addDays, dateOfStamp } from '../lib/date';

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

  const orchardStart = addDays(today, -7);
  const orchardEnd = addDays(today, 7);
  const plannedDays = new Set<ISODate>();
  for (const event of data.events) {
    if (event.allDay) continue;
    const date = dateOfStamp(event.start);
    if (date >= orchardStart && date <= orchardEnd) plannedDays.add(date);
  }
  let eventDone = 0;
  let eventPartial = 0;
  for (const entry of data.entries) {
    if (entry.itemType !== 'event' || entry.date < orchardStart || entry.date > today) continue;
    if (entry.outcome === 'done') eventDone++;
    else if (entry.outcome === 'partial') eventPartial++;
  }
  const orchardScore = plannedDays.size + eventDone + eventPartial * 0.5;

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
      name: '农田',
      level: levelFrom(fieldScore, [1, 3, 7, 12]),
      score: fieldScore,
      summary: taskDone || taskPartial
        ? `最近 14 天推进了 ${taskDone} 件 Todo，另有 ${taskPartial} 件做了一部分。`
        : '最近 14 天还没有确认推进 Todo，农田正在休耕。',
    },
    orchard: {
      kind: 'orchard',
      name: '果园',
      level: levelFrom(orchardScore, [1, 3, 7, 12]),
      score: orchardScore,
      summary: plannedDays.size || eventDone || eventPartial
        ? `前后 7 天有 ${plannedDays.size} 天安排了定时日程；最近已确认完成 ${eventDone} 场，部分完成 ${eventPartial} 场。`
        : '最近没有定时日程，果园安静地等着下一段安排。',
    },
    pond: {
      kind: 'pond',
      name: '鱼塘',
      level: levelFrom(settledDays.size, [1, 4, 8, 12]),
      score: settledDays.size,
      summary: settledDays.size
        ? `最近 14 天有 ${settledDays.size} 天被认真结算。鱼塘只认真实记录，不评价这一天做得多不多。`
        : '最近 14 天还没有结算记录，鱼塘水面很安静。',
    },
    garden: {
      kind: 'garden',
      name: '花园',
      level: levelFrom(diaryDays.size, [1, 3, 7, 14]),
      score: diaryDays.size,
      summary: diaryDays.size
        ? `最近 30 天有 ${diaryDays.size} 天写过日记；同一天写很多篇也只算一次。`
        : '最近 30 天还没有日记，花圃里只留着嫩芽的位置。',
    },
  };
}

export const cultivationAreas = (state: CultivationState): CultivationAreaState[] => [
  state.field,
  state.orchard,
  state.pond,
  state.garden,
];
