import { describe, expect, it, vi } from 'vitest';
import { bindDateSelects, dateSelect, dateSelectRestorePlan, readDate } from '../src/ui/date-select';
import { setLocale } from '../src/i18n';

describe('shared date select', () => {
  const today = '2026-10-05';

  it('keeps global tasks unscheduled until the user chooses a date', () => {
    const html = dateSelect('date', today, { withNone: true, mode: 'task' });
    expect(html).toContain('<option value="" selected>不定日期</option>');
    expect(html).toContain('今天');
    expect(html).toContain('明天');
    expect(html).toContain('其他日期…');
  });

  it('keeps schedules on today and diaries on today while offering their natural nearby dates', () => {
    const schedule = dateSelect('date', today, { current: today, withNone: false, mode: 'schedule' });
    expect(schedule).toContain('<option value="2026-10-05" selected>今天</option>');
    expect(schedule).toContain('下周一');

    const diary = dateSelect('date', today, { current: today, withNone: false, mode: 'diary' });
    expect(diary).toContain('<option value="2026-10-05" selected>今天</option>');
    expect(diary).toContain('昨天');
    expect(diary).toContain('前天');
    expect(diary).not.toContain('明天');
    expect(diary).toContain('其他日期…');
  });

  it('renders English labels from the same date-select model', () => {
    setLocale('en', false);
    try {
      const html = dateSelect('date', today, { withNone: true, mode: 'task' });
      expect(html).toContain('No date');
      expect(html).toContain('Today');
      expect(html).toContain('Tomorrow');
      expect(html).toContain('Other date…');
    } finally {
      setLocale('zh-CN', false);
    }
  });

  it('recreates a custom drafted date after a locale-driven select rebuild', () => {
    const rebuiltOptions = ['', today, '2026-10-06', '2026-10-07', '2026-10-12', 'other'];
    expect(dateSelectRestorePlan(rebuiltOptions, '2026-12-24')).toEqual({
      addOption: true,
      committedValue: '2026-12-24',
    });
    expect(dateSelectRestorePlan([...rebuiltOptions, '2026-12-24'], '2026-12-24')).toEqual({
      addOption: false,
      committedValue: '2026-12-24',
    });
  });

  it('treats the native picker sentinel as no committed date', () => {
    expect(readDate({ value: 'other' } as HTMLSelectElement)).toBeUndefined();
    expect(readDate({ value: '' } as HTMLSelectElement)).toBeUndefined();
    expect(readDate({ value: '2026-10-08' } as HTMLSelectElement)).toBe('2026-10-08');
    expect(readDate({ value: '0002-11-03' } as HTMLSelectElement)).toBeUndefined();
  });

  it('binds each unchanged select only once across tracker render passes', () => {
    const sel = {
      value: today,
      dataset: { dateMode: 'diary' },
      addEventListener: vi.fn(),
    } as unknown as HTMLSelectElement;
    const root = { querySelectorAll: () => [sel] } as unknown as ParentNode;
    bindDateSelects(root, today);
    bindDateSelects(root, today);
    bindDateSelects(root, today);
    expect(sel.addEventListener).toHaveBeenCalledTimes(1);
    expect(sel.dataset.committedDate).toBe(today);
  });

  it('labels a custom date in another year with its year', () => {
    expect(dateSelect('date', today, { current: '2027-01-05', withNone: true, mode: 'task' }))
      .toContain('<option value="2027-01-05" selected>2027年1月5日</option>');
  });
});
