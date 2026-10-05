/** Diary-domain facts. Journaling is input, never a task or settlement item. */
import type { DiaryEntry, ISODate } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { ActionError, operation } from './shared';

function createDiaryImpl(store: Store, input: { text: string; date?: ISODate }): DiaryEntry {
  const text = input.text.trim();
  if (!text) throw new ActionError('写下一点今天发生的事吧');
  const entry: DiaryEntry = {
    id: uid('diary'),
    date: input.date ?? store.today(),
    text,
    createdAt: store.clock().toISOString(),
  };
  store.put('diaries', entry);
  operation(store, {
    kind: 'diary-created',
    subjectType: 'diary',
    subjectId: entry.id,
    payload: { entryDate: entry.date, text: entry.text, createdAt: entry.createdAt },
  });
  return entry;
}

function updateDiaryImpl(store: Store, id: string, input: { text: string; date?: ISODate }): DiaryEntry | undefined {
  const entry = store.data.diaries.find((item) => item.id === id);
  if (!entry) return undefined;
  const text = input.text.trim();
  if (!text) throw new ActionError('日记内容不能为空');
  const date = input.date ?? entry.date;
  if (text === entry.text && date === entry.date) return entry;

  const next: DiaryEntry = { ...entry, text, date };
  operation(store, {
    kind: 'diary-edited',
    subjectType: 'diary',
    subjectId: id,
    payload: {
      fromDate: entry.date,
      toDate: date,
      fromText: entry.text,
      toText: text,
    },
  });
  store.put('diaries', next);
  return next;
}

function deleteDiaryImpl(store: Store, id: string) {
  const entry = store.data.diaries.find((item) => item.id === id);
  if (!entry) return;
  operation(store, {
    kind: 'diary-deleted',
    subjectType: 'diary',
    subjectId: id,
    payload: { entryDate: entry.date, text: entry.text, createdAt: entry.createdAt },
  });
  store.del('diaries', id);
}

export const createDiary = (...args: Parameters<typeof createDiaryImpl>): ReturnType<typeof createDiaryImpl> =>
  args[0].batch(() => createDiaryImpl(...args));

export const updateDiary = (...args: Parameters<typeof updateDiaryImpl>): ReturnType<typeof updateDiaryImpl> =>
  args[0].batch(() => updateDiaryImpl(...args));

export const deleteDiary = (...args: Parameters<typeof deleteDiaryImpl>): ReturnType<typeof deleteDiaryImpl> =>
  args[0].batch(() => deleteDiaryImpl(...args));
