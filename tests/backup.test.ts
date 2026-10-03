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
