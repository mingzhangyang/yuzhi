import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbPersistence, emptyData, exportBackup, parseBackup } from '../src/db';
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
    expect(again.operations.slice().sort((a, b) => a.seq - b.seq).map((x) => x.kind)).toEqual(['project-created', 'task-created']);

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

describe('备份里的记录', () => {
  const wrap = (extra: Record<string, unknown>) => JSON.stringify({ format: 'yuzhi-backup', version: 1, ...extra });
  const project = { id: 'p1', name: '团队', createdAt: '2026-09-01', status: 'active', islandSlot: 0 };
  it('必填字段缺失或类型不对的记录会被拒绝', () => {
    expect(() => parseBackup(wrap({ projects: [{ ...project, name: null }] }))).toThrow('name');
    expect(() => parseBackup(wrap({ projects: [{ ...project, status: 'gone' }] }))).toThrow('status');
    expect(() => parseBackup(wrap({ projects: [{ ...project, islandSlot: 99 }] }))).toThrow('islandSlot');
    expect(() => parseBackup(wrap({ tasks: [{ id: 't', title: 'x', postponeCount: -1, status: 'open', createdAt: '2026-09-01' }] }))).toThrow('postponeCount');
    expect(() => parseBackup(wrap({ entries: [{ id: 'e', date: '2026/09/01', itemType: 'task', itemId: 't', outcome: 'done', title: 'x' }] }))).toThrow('date');
    expect(() => parseBackup(wrap({ events: [{ id: 'e', sourceId: 's', uid: 'u', title: 'x', start: 'soon', end: 'later', allDay: false, classified: false }] }))).toThrow('start');
    expect(() => parseBackup(wrap({ days: ['2026-09-01'] }))).toThrow('days');
  });
  it('引用不存在的项目、重复记录、村落位置重叠都会被拒绝', () => {
    const task = { id: 't', title: 'x', postponeCount: 0, status: 'open', createdAt: '2026-09-01' };
    expect(() => parseBackup(wrap({ tasks: [{ ...task, projectId: 'nope' }] }))).toThrow('项目不存在');
    expect(() => parseBackup(wrap({ rules: [{ id: 'r', contains: '周会', projectId: 'nope' }] }))).toThrow('项目不存在');
    expect(() => parseBackup(wrap({ tasks: [task, task] }))).toThrow('重复');
    expect(() => parseBackup(wrap({ projects: [project, { ...project, id: 'p2' }] }))).toThrow('同一个位置');
  });
  it('合格的记录照常导入', () => {
    const d = parseBackup(wrap({ projects: [project], tasks: [{ id: 't', projectId: 'p1', title: 'x', postponeCount: 0, status: 'open', createdAt: '2026-09-01' }], rules: [{ id: 'r', contains: '买菜', projectId: 'chores' }] }));
    expect(d.projects).toHaveLength(1);
    expect(d.tasks[0].projectId).toBe('p1');
  });
});

describe('写入失败', () => {
  it('replaceAll 落盘失败时调用方能收到错误，之后的写入照常进行', async () => {
    const errors: unknown[] = [];
    const puts: string[] = [];
    const per = {
      load: async () => emptyData(),
      put: async (_c: string, item: object) => void puts.push((item as { id: string }).id),
      del: async () => {},
      putSettings: async () => {},
      renameFact: async () => {},
      replaceAll: async () => {
        throw new Error('磁盘满了');
      },
    };
    const store = new Store(emptyData(), per);
    store.onError = (e) => errors.push(e);
    await expect(store.replaceAll(emptyData())).rejects.toThrow('磁盘满了');
    const p = createProject(store, '团队');
    await store.flush();
    expect(puts).toContain(p.id);
    expect(errors).toHaveLength(1);
  });
});
