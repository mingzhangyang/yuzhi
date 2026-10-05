/** Diary-domain facts. Journaling is input, never a task or settlement item. */
import type { DiaryEntry, ISODate } from '../types';
import type { Store } from '../store';
import { uid } from '../lib/id';
import { fmtDay } from '../lib/date';
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
    date: store.today(),
    kind: 'diary-created',
    payload: { after: { date: entry.date, text: entry.text } },
    life: [{
      subjectType: 'diary',
      subjectId: entry.id,
      kind: 'start',
      text: entry.date === store.today() ? '写下这篇日记' : `补写了 ${fmtDay(entry.date)} 的日记`,
    }],
  });
  return entry;
}

function editDiaryImpl(store: Store, id: string, input: { text: string; date?: ISODate }): DiaryEntry | undefined {
  const entry = store.data.diaries.find((item) => item.id === id);
  if (!entry) return undefined;
  const text = input.text.trim();
  if (!text) throw new ActionError('日记内容不能为空');
  const date = input.date ?? entry.date;
  if (text === entry.text && date === entry.date) return entry;
  const next = { ...entry, text, date };
  operation(store, {
    date: store.today(),
    kind: 'diary-edited',
    payload: {
      before: { date: entry.date, text: entry.text },
      after: { date: next.date, text: next.text },
    },
    life: [{
      subjectType: 'diary',
      subjectId: id,
      kind: 'event',
      text: date === entry.date ? '修改了这篇日记' : `修改日记，并把记录日期改为 ${fmtDay(date)}`,
    }],
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
    life: [{
      subjectType: 'diary',
      subjectId: id,
      kind: 'close',
      text: '删除了日记；一生之书仍然保留',
    }],
  });
  store.del('diaries', id);
}

export const createDiary = (...args: Parameters<typeof createDiaryImpl>): ReturnType<typeof createDiaryImpl> =>
  args[0].batch(() => createDiaryImpl(...args));

export const editDiary = (...args: Parameters<typeof editDiaryImpl>): ReturnType<typeof editDiaryImpl> =>
  args[0].batch(() => editDiaryImpl(...args));

export const deleteDiary = (...args: Parameters<typeof deleteDiaryImpl>): ReturnType<typeof deleteDiaryImpl> =>
  args[0].batch(() => deleteDiaryImpl(...args));
