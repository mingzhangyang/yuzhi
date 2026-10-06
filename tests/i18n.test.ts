import { afterEach, describe, expect, it } from 'vitest';
import { formatCalendarDay, formatFullDate, getLocale, initI18n, message, resolveLocale, setLocale } from '../src/i18n';
import { ActionError } from '../src/actions/shared';
import { fmtDay, relDay, weekday } from '../src/lib/date';

describe('i18n', () => {
  const original = getLocale();

  afterEach(() => {
    setLocale(original, false);
  });

  it('normalizes stored and browser locale preferences', () => {
    expect(resolveLocale('en-US', ['zh-CN'])).toBe('en');
    expect(resolveLocale(null, ['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale(null, ['fr-FR', 'en-GB'])).toBe('en');
    expect(resolveLocale(null, ['fr-FR'])).toBe('zh-CN');
  });

  it('treats locale persistence as optional when storage access itself throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('storage blocked');
        },
      });
      expect(() => initI18n()).not.toThrow();
      expect(() => setLocale('en')).not.toThrow();
      expect(getLocale()).toBe('en');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('keeps message keys aligned across locales and interpolates values', () => {
    expect(message('zh-CN', 'chron.count', { count: 3 })).toBe('共 3 条');
    expect(message('en', 'chron.count', { count: 3 })).toBe('3 entries');
    expect(message('en', 'forms.newTask')).toBe('New Todo');
    expect(message('en', 'tracker.dock')).toBe('Dock');
    expect(message('en', 'island.driftBottle')).toBe('Drift bottle');
    expect(message('en', 'error.taskRequired')).toBe('Write down something to do');
    expect(message('zh-CN', 'ceremony.occurrences', { count: 2 })).toBe('2 次');
    expect(message('en', 'ceremony.occurrence', { count: 1 })).toBe('1 occurrence');
    expect(message('en', 'ceremony.occurrences', { count: 2 })).toBe('2 occurrences');
    expect(message('en', 'common.version', { count: 1 })).toBe('1 version');
    expect(message('en', 'common.versions', { count: 2 })).toBe('2 versions');
    expect(message('en', 'settle.progress', { count: 1, confirmed: 1 })).toBe('1 item · 1 confirmed');
    expect(message('en', 'settle.progress', { count: 2, confirmed: 1 })).toBe('2 items · 1 confirmed');
    expect(message('en', 'tracker.villagesCount', { count: 1 })).toBe('1 village');
    expect(message('en', 'tracker.projectStarted', { date: 'Oct 1', days: 1, closed: '', done: '' })).toBe('Started Oct 1 · 1 day ago');
    expect(message('en', 'island.villagePeople', { name: 'Alpha', count: 1 })).toBe('Alpha · 1 person');
    expect(message('en', 'island.villagePeople', { name: 'Alpha', count: 2 })).toBe('Alpha · 2 people');
  });

  it('formats calendar labels in the active locale without changing stored dates', () => {
    expect(formatCalendarDay('2026-10-03', 'zh-CN')).toBe('10月3日');
    expect(formatCalendarDay('2026-10-03', 'en')).toBe('Oct 3');
    expect(formatFullDate('2026-10-03', 'zh-CN')).toBe('2026年10月3日');
    expect(formatFullDate('2026-10-03', 'en')).toBe('Oct 3, 2026');

    setLocale('en', false);
    expect(fmtDay('2026-10-03')).toBe('Oct 3');
    expect(weekday('2026-10-03')).toBe('Sat');
    expect(relDay('2026-10-03', '2026-10-03')).toBe('Today');
    expect(relDay('2026-10-02', '2026-10-03')).toBe('Yesterday');
  });

  it('localizes action errors through semantic message keys', () => {
    setLocale('en', false);
    expect(new ActionError('error.taskRequired').message).toBe('Write down something to do');
    expect(new ActionError('error.villageLimit', { count: 8 }).message).toContain('maximum 8');
  });
});
