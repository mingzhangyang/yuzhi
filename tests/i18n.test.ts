import { afterEach, describe, expect, it } from 'vitest';
import { formatCalendarDay, getLocale, initI18n, message, resolveLocale, setLocale } from '../src/i18n';
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
  });

  it('formats calendar labels in the active locale without changing stored dates', () => {
    expect(formatCalendarDay('2026-10-03', 'zh-CN')).toBe('10月3日');
    expect(formatCalendarDay('2026-10-03', 'en')).toBe('Oct 3');

    setLocale('en', false);
    expect(fmtDay('2026-10-03')).toBe('Oct 3');
    expect(weekday('2026-10-03')).toBe('Sat');
    expect(relDay('2026-10-03', '2026-10-03')).toBe('Today');
    expect(relDay('2026-10-02', '2026-10-03')).toBe('Yesterday');
  });
});
