import { Store } from '../src/store';
import { MemoryPersistence, emptyData } from '../src/db';
import { addDays } from '../src/lib/date';

/** 一个可以拨动「今天」的内存 store */
export function makeStore(today = '2026-10-01', firstDay = '2026-09-01') {
  const data = emptyData();
  data.settings.firstDay = firstDay;
  const store = new Store(data, new MemoryPersistence());
  let cur = today;
  store.clock = () => {
    const [y, m, d] = cur.split('-').map(Number);
    return new Date(y, m - 1, d, 21, 0, 0);
  };
  return {
    store,
    setToday(d: string) {
      cur = d;
      store.changed();
    },
    advance(n = 1) {
      cur = addDays(cur, n);
      store.changed();
      return cur;
    },
    get today() {
      return cur;
    },
  };
}
