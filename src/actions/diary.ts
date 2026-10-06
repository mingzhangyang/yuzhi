/** Diary-domain facts. Journaling is input, never a task or settlement item. */
import type { DiaryEntry, ISODate } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { historyEvent } from '../history-types';
import { ActionError, operation, semanticLife } from './shared';

function validDiaryDate(store: Store, date: ISODate | undefined): ISODate {
  const today = store.today();
  const value = date ?? today;
  if (value > today) throw new ActionError('error.diaryFuture');
  return value;
}

function createDiaryImpl(store: Store, input: { text: string; date?: ISODate }): DiaryEntry {
  const text = input.text.trim();
  if (!text) throw new ActionError('error.diaryRequired');

  const date = validDiaryDate(store, input.date);
  const entry: DiaryEntry = {
    id: uid('diary'),
    date,
    text,
    createdAt: store.clock().toISOString(),
  };
  store.put('diaries', entry);
  operation(store, {
    date: store.today(),
    kind: 'diary-created',
    payload: { after: { date: entry.date, text: entry.text } },
    life: [semanticLife({
      subjectType: 'diary',
      subjectId: entry.id,
      kind: 'start',
      event: entry.date === store.today()
        ? historyEvent('history.life.diaryWritten')
        : historyEvent('history.life.diaryBackfilled', { date: entry.date }),
    })],
  });
  return entry;
}

function editDiaryImpl(store: Store, id: string, input: { text: string; date?: ISODate }): DiaryEntry | undefined {
  const entry = store.data.diaries.find((item) => item.id === id);
  if (!entry) return undefined;
  const text = input.text.trim();
  if (!text) throw new ActionError('error.diaryEmpty');
  const date = validDiaryDate(store, input.date ?? entry.date);
  if (text === entry.text && date === entry.date) return entry;

  const next: DiaryEntry = { ...entry, text, date };
  operation(store, {
    date: store.today(),
    kind: 'diary-edited',
    payload: {
      before: { date: entry.date, text: entry.text },
      after: { date: next.date, text: next.text },
    },
    life: [semanticLife({
      subjectType: 'diary',
      subjectId: id,
      kind: 'event',
      event: date === entry.date
        ? historyEvent('history.life.diaryEdited')
        : historyEvent('history.life.diaryDateChanged', { date }),
    })],
  });
  store.put('diaries', next);
  return next;
}

function deleteDiaryImpl(store: Store, id: string) {
  const entry = store.data.diaries.find((item) => item.id === id);
  if (!entry) return;
  operation(store, {
    date: store.today(),
    kind: 'diary-deleted',
    payload: { before: { date: entry.date, text: entry.text } },
    life: [semanticLife({
      subjectType: 'diary',
      subjectId: id,
      kind: 'close',
      event: historyEvent('history.life.diaryDeleted'),
    })],
  });
  store.del('diaries', id);
}

export const createDiary = (...args: Parameters<typeof createDiaryImpl>): ReturnType<typeof createDiaryImpl> =>
  args[0].batch(() => createDiaryImpl(...args));

export const editDiary = (...args: Parameters<typeof editDiaryImpl>): ReturnType<typeof editDiaryImpl> =>
  args[0].batch(() => editDiaryImpl(...args));

export const deleteDiary = (...args: Parameters<typeof deleteDiaryImpl>): ReturnType<typeof deleteDiaryImpl> =>
  args[0].batch(() => deleteDiaryImpl(...args));
