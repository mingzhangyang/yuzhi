import { describe as group, expect, it } from 'vitest';
import { describe, moonName, type InfoContext } from '../src/island/info';

const ctx = (o: Partial<InfoContext> = {}): InfoContext => ({
  season: 0,
  progress: 0.3,
  cover: 0,
  weather: 'clear',
  light: 'day',
  hour: 12,
  fest: [],
  moon: 0.5,
  ...o,
});

group('景物说明', () => {
  it('树随季节变化', () => {
    expect(describe({ kind: 'tree', tree: 'round', cherry: true, forest: false }, ctx()).title).toBe('樱花树');
    expect(describe({ kind: 'tree', tree: 'round', cherry: true, forest: false }, ctx({ season: 2 })).title).toBe('阔叶树');
    expect(describe({ kind: 'tree', tree: 'round', cherry: false, forest: true }, ctx({ season: 3 })).lines[0]).toContain('落光');
    const pine = describe({ kind: 'tree', tree: 'pine', cherry: false, forest: false }, ctx({ season: 3, cover: 0.8, fest: ['christmas'] }));
    expect(pine.title).toBe('松树');
    expect(pine.lines.join()).toContain('雪');
    expect(pine.lines.join()).toContain('彩灯');
  });

  it('空地说明它将来的用途，新年轮会注明', () => {
    expect(describe({ kind: 'ground', type: 'plaza', ring: 0, site: 'village' }, ctx()).lines[0]).toContain('村落');
    const lm = describe({ kind: 'ground', type: 'grass', ring: 2, site: 'landmark' }, ctx());
    expect(lm.lines[0]).toContain('地标');
    expect(lm.lines.at(-1)).toContain('第 2 圈');
    expect(describe({ kind: 'ground', type: 'water', ring: 0 }, ctx({ season: 3, cover: 0.9 })).lines[0]).toContain('结了冰');
    expect(describe({ kind: 'ground', type: 'field', ring: 0 }, ctx({ season: 2, progress: 0.7 })).lines[0]).toContain('草垛');
  });

  it('海面显示天时：季节、时刻、天气、月相、节日', () => {
    const sea = describe({ kind: 'sea' }, ctx({ season: 2, light: 'night', hour: 22, fest: ['zhongqiu', 'guoqing'] }));
    expect(sea.lines[0]).toBe('秋季 · 夜里 · 晴');
    expect(sea.lines[1]).toContain('满月');
    expect(sea.lines.join()).toContain('中秋、国庆');
  });

  it('月相名称', () => {
    expect(moonName(0)).toBe('新月');
    expect(moonName(0.1)).toBe('蛾眉月');
    expect(moonName(0.25)).toBe('上弦月');
    expect(moonName(0.5)).toBe('满月');
    expect(moonName(0.75)).toBe('下弦月');
    expect(moonName(0.9)).toBe('残月');
  });
});

group('日程说明', () => {
  it('即将开始的说明写出开始时间', () => {
    const start = new Date(2026, 9, 4, 14, 10).toISOString();
    const info = describe({ kind: 'agenda', target: 'p', targetName: '团队', phase: 'soon', title: '周会', start, later: 0, ended: 0, banners: [] }, ctx());
    expect(info.lines[0]).toBe('「周会」即将开始，14:10 开始。');
  });

  it('只有全天条幅时不说稍后还有场次', () => {
    const info = describe({ kind: 'agenda', target: 'p', targetName: '团队', phase: 'later', later: 0, ended: 0, banners: ['出差'] }, ctx());
    expect(info.lines.join('')).not.toContain('稍后');
    expect(info.lines.join('')).toContain('今天全天：出差');
  });
});
