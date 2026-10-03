import { describe, expect, it } from 'vitest';
import { addDays, diffDays, eachDay, relDay, seasonOf } from '../src/lib/date';

describe('date', () => {
  it('跨月、跨年加减天数', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-09-01', '2026-10-01')).toBe(30);
    expect(eachDay('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  it('季节跟随月份', () => {
    expect(seasonOf('2026-04-10')).toBe(0);
    expect(seasonOf('2026-07-10')).toBe(1);
    expect(seasonOf('2026-10-03')).toBe(2);
    expect(seasonOf('2026-01-03')).toBe(3);
  });
  it('相对日期', () => {
    expect(relDay('2026-10-03', '2026-10-03')).toBe('今天');
    expect(relDay('2026-10-02', '2026-10-03')).toBe('昨天');
    expect(relDay('2026-10-10', '2026-10-03')).toBe('10月10日');
  });
});
