import { describe, expect, it } from 'vitest';
import { dateSelect, readDate } from '../src/ui/date-select';

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

  it('treats the native picker sentinel as no committed date', () => {
    expect(readDate({ value: 'other' } as HTMLSelectElement)).toBeUndefined();
    expect(readDate({ value: '' } as HTMLSelectElement)).toBeUndefined();
    expect(readDate({ value: '2026-10-08' } as HTMLSelectElement)).toBe('2026-10-08');
  });
});
