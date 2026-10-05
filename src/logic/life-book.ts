import type { Data, ISODate, LifeEntry, LifeSubjectType, OperationEvent } from '../types';
import { compareLifeEntries, lifeEntries } from './operations';

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

export interface LifeBookIndex {
  entries(subject: LifeBookSubject): readonly LifeEntry[];
  subjectIds(type: LifeSubjectType): readonly string[];
  diaryVersions(id: string): readonly LifeBookVersion<DiarySnapshot>[];
  diaryLatest(id: string): DiarySnapshot | undefined;
  scheduleVersions(id: string): readonly LifeBookVersion<ScheduleSnapshot>[];
  scheduleLatest(id: string): ScheduleSnapshot | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSubjectType(value: unknown): value is LifeSubjectType {
  return value === 'project' || value === 'task' || value === 'diary' || value === 'schedule';
}

function subjectKey(type: LifeSubjectType, id: string) {
  return `${type}\u0000${id}`;
}

function operationSubjects(event: OperationEvent): LifeBookSubject[] {
  const raw = event.payload?.life;
  if (!Array.isArray(raw)) return [];
  const out: LifeBookSubject[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (!isSubjectType(row.subjectType) || typeof row.subjectId !== 'string' || !row.subjectId) continue;
    const key = subjectKey(row.subjectType, row.subjectId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: row.subjectType, id: row.subjectId });
  }
  return out;
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

function scheduleSnapshotFromCurrent(event: Data['events'][number]): ScheduleSnapshot {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const hm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const ymd = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return { title: event.title, date: ymd, start: hm(start), end: hm(end), projectId: event.projectId };
}

function addEntry(map: Map<string, LifeEntry[]>, key: string, entry: LifeEntry) {
  const rows = map.get(key);
  if (rows) rows.push(entry);
  else map.set(key, [entry]);
}

function addVersion<T>(map: Map<string, LifeBookVersion<T>[]>, id: string, version: LifeBookVersion<T>) {
  const versions = map.get(id);
  if (versions) versions.push(version);
  else map.set(id, [version]);
}

/**
 * Build one indexed projection for a Tracker render.
 *
 * The fact stream is scanned a constant number of times regardless of how many
 * diary/schedule rows are displayed. Deleted records remain addressable because
 * the index is rooted in immutable operation facts rather than live entities.
 */
export function buildLifeBookIndex(data: Data): LifeBookIndex {
  const entriesBySubject = new Map<string, LifeEntry[]>();
  const idsByType = new Map<LifeSubjectType, Set<string>>([
    ['project', new Set()],
    ['task', new Set()],
    ['diary', new Set()],
    ['schedule', new Set()],
  ]);

  for (const entry of lifeEntries(data)) {
    const keys = new Set<string>();
    if (entry.subjectType && entry.subjectId) {
      const key = subjectKey(entry.subjectType, entry.subjectId);
      keys.add(key);
      idsByType.get(entry.subjectType)!.add(entry.subjectId);
    }
    if (entry.projectId) keys.add(subjectKey('project', entry.projectId));
    if (entry.taskId) keys.add(subjectKey('task', entry.taskId));
    for (const key of keys) addEntry(entriesBySubject, key, entry);
  }

  const diaryVersionMap = new Map<string, LifeBookVersion<DiarySnapshot>[]>();
  const scheduleVersionMap = new Map<string, LifeBookVersion<ScheduleSnapshot>[]>();
  const deletedDiaries = new Map<string, DiarySnapshot>();
  const deletedSchedules = new Map<string, ScheduleSnapshot>();

  for (const event of data.operations.slice().sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))) {
    const subjects = operationSubjects(event);
    if (!subjects.length) continue;

    for (const subject of subjects) {
      if (subject.type === 'diary') {
        if (event.kind === 'diary-created' || event.kind === 'diary-edited') {
          const snapshot = diarySnapshot(event.payload?.after);
          if (snapshot) {
            addVersion(diaryVersionMap, subject.id, {
              id: event.id,
              seq: event.seq,
              recordedOn: event.date,
              kind: event.kind === 'diary-created' ? 'created' : 'edited',
              snapshot,
            });
          }
        } else if (event.kind === 'diary-deleted') {
          const snapshot = diarySnapshot(event.payload?.before);
          if (snapshot) deletedDiaries.set(subject.id, snapshot);
        }
      } else if (subject.type === 'schedule') {
        if (event.kind === 'schedule-created' || event.kind === 'schedule-edited') {
          const snapshot = scheduleSnapshot(event.payload?.after);
          if (snapshot) {
            addVersion(scheduleVersionMap, subject.id, {
              id: event.id,
              seq: event.seq,
              recordedOn: event.date,
              kind: event.kind === 'schedule-created' ? 'created' : 'edited',
              snapshot,
            });
          }
        } else if (event.kind === 'schedule-deleted') {
          const snapshot = scheduleSnapshot(event.payload?.before);
          if (snapshot) deletedSchedules.set(subject.id, snapshot);
        }
      }
    }
  }

  const currentDiaries = new Map(
    data.diaries.map((entry) => [entry.id, { date: entry.date, text: entry.text } satisfies DiarySnapshot] as const),
  );
  const currentSchedules = new Map(
    data.events.map((event) => [event.id, scheduleSnapshotFromCurrent(event)] as const),
  );

  return {
    entries(subject) {
      return entriesBySubject.get(subjectKey(subject.type, subject.id)) ?? [];
    },
    subjectIds(type) {
      return [...(idsByType.get(type) ?? [])];
    },
    diaryVersions(id) {
      return diaryVersionMap.get(id) ?? [];
    },
    diaryLatest(id) {
      const current = currentDiaries.get(id);
      if (current) return current;
      const versions = diaryVersionMap.get(id);
      if (versions?.length) return versions[versions.length - 1].snapshot;
      return deletedDiaries.get(id);
    },
    scheduleVersions(id) {
      return scheduleVersionMap.get(id) ?? [];
    },
    scheduleLatest(id) {
      const current = currentSchedules.get(id);
      if (current) return current;
      const versions = scheduleVersionMap.get(id);
      if (versions?.length) return versions[versions.length - 1].snapshot;
      return deletedSchedules.get(id);
    },
  };
}

function matchesSubject(entry: LifeEntry, subject: LifeBookSubject): boolean {
  if (entry.subjectType === subject.type && entry.subjectId === subject.id) return true;
  if (subject.type === 'project') return entry.projectId === subject.id;
  if (subject.type === 'task') return entry.taskId === subject.id;
  return false;
}

/** One read model for the own life book of every first-class record. */
export function lifeBookEntries(
  data: Data,
  subject: LifeBookSubject,
  derived: LifeEntry[] = [],
): LifeEntry[] {
  return lifeEntries(data, derived).filter((entry) => matchesSubject(entry, subject)).sort(compareLifeEntries);
}

/** Includes deleted diary/schedule IDs because their operation facts are never removed. */
export function lifeBookSubjectIds(data: Data, type: LifeSubjectType): string[] {
  return [...buildLifeBookIndex(data).subjectIds(type)];
}

export function diaryVersions(data: Data, id: string): LifeBookVersion<DiarySnapshot>[] {
  return [...buildLifeBookIndex(data).diaryVersions(id)];
}

export function diaryLatestSnapshot(data: Data, id: string): DiarySnapshot | undefined {
  return buildLifeBookIndex(data).diaryLatest(id);
}

export function scheduleVersions(data: Data, id: string): LifeBookVersion<ScheduleSnapshot>[] {
  return [...buildLifeBookIndex(data).scheduleVersions(id)];
}

export function scheduleLatestSnapshot(data: Data, id: string): ScheduleSnapshot | undefined {
  return buildLifeBookIndex(data).scheduleLatest(id);
}
