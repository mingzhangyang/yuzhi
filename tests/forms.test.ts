import { describe, expect, it, vi } from 'vitest';
import { emptyData, MemoryPersistence } from '../src/db';
import { Store } from '../src/store';

const toast = vi.fn();
const openModal = vi.fn();
vi.mock('../src/ui/dom', async (importOriginal) => ({ ...(await importOriginal<object>()), toast: (...a: unknown[]) => toast(...a) }));
vi.mock('../src/ui/modal', async (importOriginal) => ({ ...(await importOriginal<object>()), openModal: (...a: unknown[]) => openModal(...a) }));

const { openCalendar } = await import('../src/ui/forms');

describe('calendar dialog', () => {
  it('a read-only tab gets a notice instead of a partially bound dialog', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    store.setReadOnly(true);
    expect(() => openCalendar(store, () => {})).not.toThrow();
    expect(openModal).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('只读'), true);
  });

  it('a writer tab opens the dialog', () => {
    const store = new Store(emptyData(), new MemoryPersistence());
    openCalendar(store, () => {});
    expect(openModal).toHaveBeenCalledOnce();
  });
});
