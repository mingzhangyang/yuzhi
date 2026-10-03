import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbPersistence, exportBackup, parseBackup } from '../src/db';
import { Store } from '../src/store';
import { createProject, createTask } from '../src/actions';

describe('IndexedDB 与备份', () => {
  it('写入后重新载入，导出再导入', async () => {
    const per = new IdbPersistence('test-db');
    const store = new Store(await per.load(), per);
    const p = createProject(store, '团队');
    createTask(store, { title: '写周报', projectId: p.id });
    await store.flush();
    const again = await new IdbPersistence('test-db').load();
    expect(again.projects.map((x) => x.name)).toEqual(['团队']);
    expect(again.tasks.map((x) => x.title)).toEqual(['写周报']);

    const json = exportBackup(again);
    const parsed = parseBackup(json);
    const other = new IdbPersistence('test-db-2');
    await other.replaceAll(parsed);
    expect((await other.load()).tasks.length).toBe(1);
  });
  it('拒绝不是屿志备份的文件', () => {
    expect(() => parseBackup('{}')).toThrow('这不是屿志的备份文件');
    expect(() => parseBackup('oops')).toThrow('JSON');
  });
});

describe('备份里的设置', () => {
  const wrap = (settings: unknown) => JSON.stringify({ format: 'yuzhi-backup', version: 1, settings });
  it('类型或格式不对的设置会被拒绝', () => {
    expect(() => parseBackup(wrap({ workStart: 1 }))).toThrow('工作开始时间');
    expect(() => parseBackup(wrap({ workEnd: '25:00' }))).toThrow('工作结束时间');
    expect(() => parseBackup(wrap({ firstDay: '2026/10/01' }))).toThrow('起始日期');
    expect(() => parseBackup(wrap({ theme: 'neon' }))).toThrow('外观');
    expect(() => parseBackup(wrap({ workStart: '18:00', workEnd: '09:00' }))).toThrow('工作时段');
    expect(() => parseBackup(wrap('oops'))).toThrow('设置');
  });
  it('合法的设置原样保留，缺的字段用默认值', () => {
    const d = parseBackup(wrap({ workStart: '08:30', theme: 'dark' }));
    expect(d.settings).toMatchObject({ workStart: '08:30', workEnd: '18:00', theme: 'dark' });
  });
});
