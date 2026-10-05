import { describe, expect, it } from 'vitest';
import {
  createDiary,
  createProject,
  createSchedule,
  createTask,
  deleteDiary,
  deleteSchedule,
  editDiary,
  editSchedule,
  moveTask,
  renameTask,
  setEventProject,
  settleDay,
} from '../src/actions';
import { CHORES, LOCAL_CALENDAR_SOURCE_ID } from '../src/types';
import {
  buildLifeBookIndex,
  diaryLatestSnapshot,
  diaryVersions,
  lifeBookEntries,
  lifeBookSubjectIds,
  scheduleLatestSnapshot,
  scheduleVersions,
} from '../src/logic/life-book';
import { BACKUP_FORMAT, MemoryPersistence, emptyData, parseBackup } from '../src/db';
import { Store } from '../src/store';
import { itemKey } from '../src/logic/days';
import { makeStore } from './helpers';

describe('unified life book', () => {
  it('keeps diary revisions and history after the live entry is deleted', () => {
    const h = makeStore('2026-10-05');
    const diary = createDiary(h.store, { date: '2026-10-04', text: '第一版' });

    h.setToday('2026-10-06');
    editDiary(h.store, diary.id, { date: '2026-10-04', text: '第二版，补充了一句。' });

    expect(diaryVersions(h.store.data, diary.id).map((version) => version.snapshot.text)).toEqual([
      '第一版',
      '第二版，补充了一句。',
    ]);
    expect(lifeBookEntries(h.store.data, { type: 'diary', id: diary.id }).map((entry) => entry.kind))
      .toEqual(['start', 'event']);

    deleteDiary(h.store, diary.id);

    expect(h.store.data.diaries.find((entry) => entry.id === diary.id)).toBeUndefined();
    expect(diaryLatestSnapshot(h.store.data, diary.id)?.text).toBe('第二版，补充了一句。');
    expect(lifeBookSubjectIds(h.store.data, 'diary')).toContain(diary.id);
    expect(lifeBookEntries(h.store.data, { type: 'diary', id: diary.id }).at(-1)?.kind).toBe('close');
  });

  it('keeps local schedule revisions and history after deletion', () => {
    const h = makeStore('2026-10-05');
    const event = createSchedule(h.store, {
      title: '第一次讨论',
      date: '2026-10-08',
      start: '09:00',
      end: '10:00',
      projectId: CHORES,
    });

    editSchedule(h.store, event.id, {
      title: '第二次讨论',
      date: '2026-10-09',
      start: '10:30',
      end: '11:30',
      projectId: CHORES,
    });

    expect(scheduleVersions(h.store.data, event.id).map((version) => version.snapshot.title))
      .toEqual(['第一次讨论', '第二次讨论']);
    expect(lifeBookEntries(h.store.data, { type: 'schedule', id: event.id }).map((entry) => entry.kind))
      .toEqual(['start', 'event']);

    deleteSchedule(h.store, event.id);

    expect(h.store.data.events.find((item) => item.id === event.id)).toBeUndefined();
    expect(scheduleLatestSnapshot(h.store.data, event.id)).toMatchObject({
      title: '第二次讨论',
      date: '2026-10-09',
      start: '10:30',
      end: '11:30',
    });
    expect(lifeBookSubjectIds(h.store.data, 'schedule')).toContain(event.id);
    expect(lifeBookEntries(h.store.data, { type: 'schedule', id: event.id }).at(-1)?.kind).toBe('close');
  });

  it('routes existing project/task facts through the same subject read model', () => {
    const h = makeStore('2026-10-05');
    const a = createProject(h.store, '旧村落');
    const b = createProject(h.store, '新村落');
    const task = createTask(h.store, { title: '旧名字', projectId: a.id });
    moveTask(h.store, task.id, b.id);
    renameTask(h.store, task.id, '新名字');

    const rows = lifeBookEntries(h.store.data, { type: 'task', id: task.id });
    expect(rows.at(-1)?.text).toBe('改名：「旧名字」 → 「新名字」');
    expect(rows.at(-1)).toMatchObject({ subjectType: 'task', subjectId: task.id, projectId: b.id });
  });

  it('projects settlement facts into a local schedule Life Book', () => {
    const h = makeStore('2026-10-05');
    const event = createSchedule(h.store, {
      title: '今天的讨论',
      date: h.today,
      start: '09:00',
      end: '10:00',
      projectId: CHORES,
    });
    settleDay(h.store, h.today, new Map([[itemKey('event', event.id), { outcome: 'done' }]]));

    Object.defineProperty(h.store.data.events, 'find', {
      configurable: true,
      value: () => {
        throw new Error('settlement projection must not rescan events per row');
      },
    });

    expect(lifeBookEntries(h.store.data, { type: 'schedule', id: event.id }).map((entry) => entry.kind))
      .toEqual(['start', 'done']);
  });

  it('does not let chores reassignment mutate a settled local schedule', () => {
    const h = makeStore('2026-10-05');
    const project = createProject(h.store, '项目');
    const event = createSchedule(h.store, {
      title: '已经结算的讨论',
      date: h.today,
      start: '09:00',
      end: '10:00',
      projectId: CHORES,
    });
    settleDay(h.store, h.today, new Map([[itemKey('event', event.id), { outcome: 'done' }]]));

    expect(() => setEventProject(h.store, event.id, project.id)).toThrow('已经留下结算记录');
    expect(h.store.data.events.find((item) => item.id === event.id)?.projectId).toBe(CHORES);
    expect(scheduleVersions(h.store.data, event.id)).toHaveLength(1);
  });

  it('migrates a settled v5 local schedule with start before settlement', () => {
    const data = emptyData();
    data.events.push({
      id: 'local|settled',
      sourceId: LOCAL_CALENDAR_SOURCE_ID,
      uid: 'settled',
      title: '已经完成的旧日程',
      start: new Date(2026, 9, 2, 9, 0, 0).toISOString(),
      end: new Date(2026, 9, 2, 10, 0, 0).toISOString(),
      allDay: false,
      projectId: CHORES,
      classified: true,
    });
    data.entries.push({
      id: '2026-10-02|event|local|settled',
      seq: 1,
      date: '2026-10-02',
      itemType: 'event',
      itemId: 'local|settled',
      outcome: 'done',
      projectId: CHORES,
      title: '已经完成的旧日程',
    });

    const migrated = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 5,
      exportedAt: '2026-10-05T00:00:00.000Z',
      ...data,
    }));

    const rows = lifeBookEntries(migrated, { type: 'schedule', id: 'local|settled' });
    expect(rows.map((entry) => entry.kind)).toEqual(['start', 'done']);
    expect(rows[0].factSeq).toBeUndefined();
    expect(rows[1].factSeq).toBe(1);
  });

  it('keeps a migrated future schedule baseline before immediate post-migration edits', () => {
    const data = emptyData();
    data.events.push({
      id: 'local|future',
      sourceId: LOCAL_CALENDAR_SOURCE_ID,
      uid: 'future',
      title: '未来的旧日程',
      start: new Date(2026, 9, 8, 9, 0, 0).toISOString(),
      end: new Date(2026, 9, 8, 10, 0, 0).toISOString(),
      allDay: false,
      projectId: CHORES,
      classified: true,
    });

    const migrated = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 5,
      exportedAt: '2026-10-05T00:00:00.000Z',
      ...data,
    }));
    const store = new Store(migrated, new MemoryPersistence(migrated));
    store.clock = () => new Date(2026, 9, 5, 12, 0, 0);

    editSchedule(store, 'local|future', {
      title: '未来的旧日程（已修改）',
      date: '2026-10-08',
      start: '09:00',
      end: '10:00',
      projectId: CHORES,
    });

    const rows = lifeBookEntries(store.data, { type: 'schedule', id: 'local|future' });
    expect(rows.map((entry) => entry.kind)).toEqual(['start', 'event']);
    expect(rows[0]).toMatchObject({ baseline: true, date: '2026-10-08' });
    expect(rows[1]).toMatchObject({ date: '2026-10-05' });

    const index = buildLifeBookIndex(store.data);
    expect(index.entries({ type: 'schedule', id: 'local|future' }).map((entry) => entry.kind))
      .toEqual(['start', 'event']);
  });

  it('migrates v5 diaries and local schedules into baseline life-book facts', () => {
    const data = emptyData();
    data.diaries.push({
      id: 'diary-old',
      date: '2026-10-01',
      text: '旧日记',
      createdAt: '2026-10-01T12:00:00.000Z',
    });
    data.events.push({
      id: 'local|old',
      sourceId: LOCAL_CALENDAR_SOURCE_ID,
      uid: 'old',
      title: '旧日程',
      start: new Date(2026, 9, 2, 9, 0, 0).toISOString(),
      end: new Date(2026, 9, 2, 10, 0, 0).toISOString(),
      allDay: false,
      projectId: CHORES,
      classified: true,
    });

    const migrated = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 5,
      exportedAt: '2026-10-05T00:00:00.000Z',
      ...data,
    }));

    expect(diaryVersions(migrated, 'diary-old')).toHaveLength(1);
    expect(scheduleVersions(migrated, 'local|old')).toHaveLength(1);
    expect(migrated.operations.map((event) => event.kind)).toEqual([
      'diary-created',
      'schedule-created',
    ]);
    expect(migrated.operations.map((event) => event.seq)).toEqual([1, 2]);
  });
});
