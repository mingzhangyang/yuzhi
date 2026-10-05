import type { Data, ISODate, LifeEntry, LifeSubjectType, OperationEvent } from '../types';
import { lifeEntries } from './operations';

export interface LifeBookSubject {
  type: LifeSubjectType;
  id: string;
}

export interface DiarySnapshot {
  date: ISODate;
  text: string;
}

export interface ScheduleSnapshot {
  title: string;
  date: ISODate;
  start: string;
  end: string;
  projectId?: string;
}

export interface LifeBookVersion<T> {
  id: string;
  seq: number;
  recordedOn: ISODate;
  kind: 'created' | 'edited';
  snapshot: T;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function operationTargets(event: OperationEvent, subject: LifeBookSubject): boolean {
  const life = event.payload?.life;
  return Array.isArray(life) && life.some((snapshot) =>
    snapshot.subjectType === subject.type && snapshot.subjectId === subject.id,
  );
}

function diarySnapshot(value: unknown): DiarySnapshot | undefined {
  const row = record(value);
  if (!row || typeof row.date !== 'string' || typeof row.text !== 'string') return undefined;
  return { date: row.date, text: row.text };
}

function scheduleSnapshot(value: unknown): ScheduleSnapshot | undefined {
  const row = record(value);
  if (
    !row ||
    typeof row.title !== 'string' ||
    typeof row.date !== 'string' ||
    typeof row.start !== 'string' ||
    typeof row.end !== 'string'
  ) return undefined;
  return {
    title: row.title,
    date: row.date,
    start: row.start,
    end: row.end,
    projectId: typeof row.projectId === 'string' ? row.projectId : undefined,
  };
}

/** One read model for the own life book of every first-class record. */
export function lifeBookEntries(
  data: Data,
  subject: LifeBookSubject,
  derived: LifeEntry[] = [],
): LifeEntry[] {
  return lifeEntries(data, derived).filter((entry) => {
    if (entry.subjectType === subject.type && entry.subjectId === subject.id) return true;
    if (subject.type === 'project') return entry.projectId === subject.id;
    if (subject.type === 'task') return entry.taskId === subject.id;
    return false;
  });
}

/** Includes deleted diary/schedule IDs because their operation facts are never removed. */
export function lifeBookSubjectIds(data: Data, type: LifeSubjectType): string[] {
  const ids = new Set<string>();
  for (const entry of lifeEntries(data)) {
    if (entry.subjectType === type && entry.subjectId) ids.add(entry.subjectId);
  }
  return [...ids];
}

export function diaryVersions(data: Data, id: string): LifeBookVersion<DiarySnapshot>[] {
  const subject: LifeBookSubject = { type: 'diary', id };
  return data.operations
    .filter((event) =>
      (event.kind === 'diary-created' || event.kind === 'diary-edited') &&
      operationTargets(event, subject),
    )
    .map((event) => {
      const snapshot = diarySnapshot(event.payload?.after);
      if (!snapshot) return undefined;
      return {
        id: event.id,
        seq: event.seq,
        recordedOn: event.date,
        kind: event.kind === 'diary-created' ? 'created' as const : 'edited' as const,
        snapshot,
      };
    })
    .filter((value): value is LifeBookVersion<DiarySnapshot> => !!value)
    .sort((a, b) => a.seq - b.seq);
}

export function diaryLatestSnapshot(data: Data, id: string): DiarySnapshot | undefined {
  const current = data.diaries.find((entry) => entry.id === id);
  if (current) return { date: current.date, text: current.text };
  const versions = diaryVersions(data, id);
  if (versions.length) return versions[versions.length - 1].snapshot;
  const deleted = data.operations
    .filter((event) => event.kind === 'diary-deleted' && operationTargets(event, { type: 'diary', id }))
    .sort((a, b) => b.seq - a.seq)[0];
  return diarySnapshot(deleted?.payload?.before);
}

export function scheduleVersions(data: Data, id: string): LifeBookVersion<ScheduleSnapshot>[] {
  const subject: LifeBookSubject = { type: 'schedule', id };
  return data.operations
    .filter((event) =>
      (event.kind === 'schedule-created' || event.kind === 'schedule-edited') &&
      operationTargets(event, subject),
    )
    .map((event) => {
      const snapshot = scheduleSnapshot(event.payload?.after);
      if (!snapshot) return undefined;
      return {
        id: event.id,
        seq: event.seq,
        recordedOn: event.date,
        kind: event.kind === 'schedule-created' ? 'created' as const : 'edited' as const,
        snapshot,
      };
    })
    .filter((value): value is LifeBookVersion<ScheduleSnapshot> => !!value)
    .sort((a, b) => a.seq - b.seq);
}

export function scheduleLatestSnapshot(data: Data, id: string): ScheduleSnapshot | undefined {
  const current = data.events.find((event) => event.id === id);
  if (current) {
    const start = new Date(current.start);
    const end = new Date(current.end);
    const hm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const ymd = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    return { title: current.title, date: ymd, start: hm(start), end: hm(end), projectId: current.projectId };
  }
  const versions = scheduleVersions(data, id);
  if (versions.length) return versions[versions.length - 1].snapshot;
  const deleted = data.operations
    .filter((event) => event.kind === 'schedule-deleted' && operationTargets(event, { type: 'schedule', id }))
    .sort((a, b) => b.seq - a.seq)[0];
  return scheduleSnapshot(deleted?.payload?.before);
}
