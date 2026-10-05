/** Diary-domain facts. Journaling is input, never a task or settlement item. */
import type { DiaryEntry, ISODate } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { ActionError } from './shared';

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
  return entry;
}

function deleteDiaryImpl(store: Store, id: string) {
  if (store.data.diaries.some((entry) => entry.id === id)) store.del('diaries', id);
}

export const createDiary = (...args: Parameters<typeof createDiaryImpl>): ReturnType<typeof createDiaryImpl> =>
  args[0].batch(() => createDiaryImpl(...args));

export const deleteDiary = (...args: Parameters<typeof deleteDiaryImpl>): ReturnType<typeof deleteDiaryImpl> =>
  args[0].batch(() => deleteDiaryImpl(...args));
