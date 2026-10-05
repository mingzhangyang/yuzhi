import { describe, expect, it } from 'vitest';
import { createDiary } from '../src/actions';
import { emptyData, MemoryPersistence } from '../src/db';
import { Store } from '../src/store';

describe('diary actions', () => {
  it('rejects future dates at the mutation boundary', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    store.clock = () => new Date(2026, 9, 5, 12);

    expect(() =>
      createDiary(store, { date: '2026-10-06', text: '这条未来日记不应该被保存' }),
    ).toThrow('日记只能记录今天或过去发生的事');
    expect(store.data.diaries).toHaveLength(0);

    expect(createDiary(store, { date: '2026-10-05', text: '今天的记录' }).date).toBe('2026-10-05');
  });
});
