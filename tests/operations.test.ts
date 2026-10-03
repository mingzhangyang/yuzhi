import { describe, expect, it } from 'vitest';
import {
  arrangeTask,
  createProject,
  createTask,
  dropTask,
  markTaskDone,
  moveTask,
  rescheduleTask,
  restartProject,
} from '../src/actions';
import { lifeEntries } from '../src/logic/operations';
import { makeStore } from './helpers';

describe('Operation facts', () => {
  it('主动操作按 seq 记录，一生之书从 operation read model 生成而不再写重复 life', () => {
    const h = makeStore();
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    rescheduleTask(h.store, t.id, '2026-10-03');
    restartProject(h.store, p.id);

    expect(h.store.data.operations.map((event) => event.kind)).toEqual([
      'project-created',
      'task-created',
      'task-rescheduled',
      'project-restarted',
    ]);
    expect(h.store.data.operations.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(h.store.data.life).toEqual([]);

    const rows = lifeEntries(h.store.data);
    expect(rows.map((row) => row.text)).toEqual([
      '立项，村落「团队」在岛上落成',
      '新任务「写周报」住进村落',
      '「写周报」改到10月3日',
      '重新启动，村落重新热闹起来',
    ]);
  });

  it('reload 后即使 operations 数组按随机主键顺序返回，life projection 仍按 date/seq 排序', () => {
    const h = makeStore();
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id, scheduledFor: h.today });
    rescheduleTask(h.store, t.id, '2026-10-03');
    restartProject(h.store, p.id);

    h.store.data.operations.reverse();
    expect(lifeEntries(h.store.data).map((row) => row.text)).toEqual([
      '立项，村落「团队」在岛上落成',
      '新任务「写周报」住进村落',
      '「写周报」改到10月3日',
      '重新启动，村落重新热闹起来',
    ]);
  });

  it('同日 settlement 与 operation 共用 factSeq，并按真实发生顺序投影', () => {
    const h = makeStore();
    const p = createProject(h.store, '团队');
    const t = createTask(h.store, { title: '写周报', projectId: p.id });
    markTaskDone(h.store, t.id);
    restartProject(h.store, p.id);

    const rows = lifeEntries(h.store.data).filter((row) => row.projectId === p.id);
    expect(rows.map((row) => [row.factSeq, row.text])).toEqual([
      [1, '立项，村落「团队」在岛上落成'],
      [2, '新任务「写周报」住进村落'],
      [3, '完成了「写周报」'],
      [4, '重新启动，村落重新热闹起来'],
    ]);
  });

  it('同一次搬村只保存一个 operation fact，但能投影到两个村落的一生之书', () => {
    const h = makeStore();
    const a = createProject(h.store, '甲');
    const b = createProject(h.store, '乙');
    const t = createTask(h.store, { title: '整理资料', projectId: a.id });
    moveTask(h.store, t.id, b.id);

    const moved = h.store.data.operations.find((event) => event.kind === 'task-moved');
    expect(moved).toMatchObject({
      projectId: b.id,
      taskId: t.id,
      payload: { fromProjectId: a.id, toProjectId: b.id },
    });

    const rows = lifeEntries(h.store.data).filter((row) => row.taskId === t.id);
    expect(rows.filter((row) => row.projectId === a.id).map((row) => row.text)).toContain('「整理资料」搬去了别的村落');
    expect(rows.filter((row) => row.projectId === b.id).map((row) => row.text)).toContain('「整理资料」搬进村落');
  });

  it('码头安排和主动放下也留下结构化事实', () => {
    const h = makeStore();
    const p = createProject(h.store, '研究');
    const t = createTask(h.store, { title: '读论文' });
    arrangeTask(h.store, t.id, p.id, h.today);
    dropTask(h.store, t.id);

    expect(h.store.data.operations.slice(-2).map((event) => event.kind)).toEqual(['task-arranged', 'task-dropped']);
    expect(h.store.data.operations.at(-1)?.payload).toMatchObject({ source: 'manual' });
  });
});
