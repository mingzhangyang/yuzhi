import { describe, expect, it } from 'vitest';
import { dayLight, festivalsOf, moonPhase, seasonProgress, snowCover, weatherOf } from '../src/island/ambience';

describe('小岛的天时', () => {
  it('认得公历和农历节日', () => {
    expect(festivalsOf('2026-10-04')).toEqual(['guoqing']);
    expect(festivalsOf('2026-01-01')).toEqual(['newyear']);
    expect(festivalsOf('2025-12-31')).toEqual(['newyear']);
    expect(festivalsOf('2026-12-25')).toEqual(['christmas']);
    // 2026 年春节 2 月 17 日：除夕到初七
    expect(festivalsOf('2026-02-16')).toEqual(['chunjie']);
    expect(festivalsOf('2026-02-23')).toEqual(['chunjie']);
    expect(festivalsOf('2026-02-24')).toEqual([]);
    expect(festivalsOf('2026-03-03')).toEqual(['yuanxiao']);
    expect(festivalsOf('2026-06-19')).toEqual(['duanwu']);
    expect(festivalsOf('2026-09-25')).toEqual(['zhongqiu']);
    // 除夕在 1 月、春节表在下一年
    expect(festivalsOf('2025-01-28')).toEqual(['chunjie']);
    // 2028 年中秋碰上国庆
    expect(festivalsOf('2028-10-03').sort()).toEqual(['guoqing', 'zhongqiu']);
    expect(festivalsOf('2026-07-15')).toEqual([]);
  });

  it('季节进度在 0–1 之间，冬天跨年', () => {
    expect(seasonProgress('2026-03-01')).toBe(0);
    expect(seasonProgress('2026-05-31')).toBeGreaterThan(0.97);
    expect(seasonProgress('2026-12-01')).toBe(0);
    const jan = seasonProgress('2027-01-15');
    expect(jan).toBeGreaterThan(0.45);
    expect(jan).toBeLessThan(0.55);
    expect(seasonProgress('2027-02-28')).toBeGreaterThan(0.97);
  });

  it('只有冬天有积雪，隆冬最厚', () => {
    expect(snowCover(1, 0.5, 'clear')).toBe(0);
    expect(snowCover(3, 0.45, 'clear')).toBeGreaterThan(snowCover(3, 0.02, 'clear'));
    expect(snowCover(3, 0.45, 'snow')).toBeLessThanOrEqual(1);
  });

  it('天气由日期决定，同一天总是一样；节日天晴；冬天只下雪不下雨', () => {
    for (let d = 1; d <= 28; d++) {
      const day = `2026-04-${String(d).padStart(2, '0')}`;
      expect(weatherOf(day, 0)).toBe(weatherOf(day, 0));
      expect(weatherOf(`2026-01-${String(d + 1).padStart(2, '0')}`, 3)).not.toBe('rain');
    }
    expect(weatherOf('2026-10-01', 2)).toBe('clear');
    const kinds = new Set<string>();
    for (let d = 1; d <= 90; d++) kinds.add(weatherOf(`2026-${String(3 + Math.floor((d - 1) / 30)).padStart(2, '0')}-${String(((d - 1) % 28) + 1).padStart(2, '0')}`, 0));
    expect(kinds.has('clear') && kinds.has('rain')).toBe(true);
  });

  it('月相：已知的满月和新月', () => {
    // 2026-09-26 前后是满月（中秋），2026-10-10 前后是新月
    expect(Math.abs(moonPhase(new Date(Date.UTC(2026, 8, 26, 12))) - 0.5)).toBeLessThan(0.06);
    const nm = moonPhase(new Date(Date.UTC(2026, 9, 10, 12)));
    expect(Math.min(nm, 1 - nm)).toBeLessThan(0.06);
  });

  it('一天里的光线连续变化，夏天天黑得晚', () => {
    expect(dayLight(12, 0).night).toBe(0);
    expect(dayLight(12, 0).tint).toEqual([255, 255, 255]);
    expect(dayLight(2, 0).night).toBe(1);
    expect(dayLight(18.6, 0).warm).toBeGreaterThan(0.8);
    expect(dayLight(19.5, 1).night).toBeLessThan(dayLight(19.5, 3).night);
    for (let h = 0; h < 24; h += 0.25) {
      const a = dayLight(h, 2).night;
      const b = dayLight(h + 0.25, 2).night;
      expect(Math.abs(a - b)).toBeLessThan(0.5);
    }
  });
});
