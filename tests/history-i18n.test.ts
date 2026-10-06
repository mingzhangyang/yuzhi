import { describe, expect, it } from 'vitest';
import { closeProject, closeStalledProject, createProject, createTask, dropTask, settleDay } from '../src/actions';
import { BACKUP_FORMAT, parseBackup } from '../src/db';
import { formatChronicleLine, formatHistoryEvent, formatLifeEntry } from '../src/history';
import { lifeEntries } from '../src/logic/operations';
import { itemKey } from '../src/logic/days';
import type { ChronicleLine, LifeEntry } from '../src/types';
import { makeStore } from './helpers';

describe('semantic history localization', () => {
  it('renders new Chronicle and Life Book facts in either locale without translating user-authored names', () => {
    const h = makeStore('2026-10-06');
    const project = createProject(h.store, '写书 Project');
    const task = createTask(h.store, {
      title: '第一章 Chapter 1',
      projectId: project.id,
      scheduledFor: h.today,
    });
    settleDay(h.store, h.today, new Map([
      [itemKey('task', task.id), { outcome: 'done' }],
    ]));

    const created = h.store.data.chronicle.find((line) =>
      line.events?.some((event) => event.key === 'history.chron.projectCreated'));
    expect(created?.text).toContain('写书 Project');
    expect(formatChronicleLine(created!, 'en')).toContain('new village');
    expect(formatChronicleLine(created!, 'en')).toContain('写书 Project');

    const taskCreated = lifeEntries(h.store.data).find((entry) =>
      entry.taskId === task.id && entry.event?.key === 'history.life.taskCreated');
    expect(taskCreated?.text).toContain('第一章 Chapter 1');
    expect(formatLifeEntry(taskCreated!, 'en')).toContain('New task');
    expect(formatLifeEntry(taskCreated!, 'en')).toContain('第一章 Chapter 1');

    const completed = lifeEntries(h.store.data).find((entry) =>
      entry.taskId === task.id && entry.kind === 'done');
    expect(formatLifeEntry(completed!, 'en')).toContain('Completed');
    expect(formatLifeEntry(completed!, 'en')).toContain('第一章 Chapter 1');
  });

  it('keeps legacy text verbatim when no semantic event exists', () => {
    const chronicle: ChronicleLine = {
      id: 'legacy-chronicle',
      date: '2026-10-01',
      text: '旧版编年史原文',
      kind: 'event',
    };
    const life: LifeEntry = {
      id: 'legacy-life',
      date: '2026-10-01',
      text: '旧版一生之书原文',
      kind: 'event',
    };

    expect(formatChronicleLine(chronicle, 'en')).toBe('旧版编年史原文');
    expect(formatLifeEntry(life, 'en')).toBe('旧版一生之书原文');
  });

  it('localizes system-generated stalled-close reasons but preserves manual reasons as user text', () => {
    const h = makeStore('2026-10-06');
    const stalled = createProject(h.store, '停滞项目');
    closeStalledProject(h.store, stalled.id, ['postponed', 'postponed', 'no_energy']);

    const stored = h.store.project(stalled.id)!;
    expect(stored.closeReason).toContain('长期停滞');
    expect(stored.closeReasonEvent?.key).toBe('history.reason.stalled');
    const english = formatHistoryEvent(stored.closeReasonEvent!, 'en');
    expect(english).toContain('Long-term stall');
    expect(english).toContain('postponed 2 times');
    expect(english).toContain('low energy 1 time');

    const manual = createProject(h.store, '手动关闭');
    closeProject(h.store, manual.id, '方向 changed');
    expect(h.store.project(manual.id)?.closeReason).toBe('方向 changed');
    expect(h.store.project(manual.id)?.closeReasonEvent).toBeUndefined();
  });

  it('preserves custom dropTask narration while keeping system notes semantic', () => {
    const h = makeStore('2026-10-06');
    const project = createProject(h.store, '项目');
    const task = createTask(h.store, { title: '任务', projectId: project.id });

    dropTask(h.store, task.id, '暂时搁置，等依赖完成');

    const dropped = lifeEntries(h.store.data).find((entry) => entry.taskId === task.id && entry.kind === 'drop');
    expect(dropped).toMatchObject({
      text: '「任务」暂时搁置，等依赖完成',
      reason: 'not_important',
    });
    expect(dropped?.event).toBeUndefined();
    expect(formatLifeEntry(dropped!, 'en')).toBe('「任务」暂时搁置，等依赖完成');
  });

  it('rejects semantic history whose required parameters are missing or malformed', () => {
    const h = makeStore('2026-10-06');
    createProject(h.store, '备份项目');

    const missingName = structuredClone(h.store.data);
    missingName.chronicle[0] = {
      ...missingName.chronicle[0],
      events: [{ key: 'history.chron.projectCreated' }],
    };
    expect(() => parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 6,
      exportedAt: '2026-10-06T00:00:00.000Z',
      ...missingName,
    }))).toThrow(/events/);

    const invalidDate = structuredClone(h.store.data);
    invalidDate.chronicle[0] = {
      ...invalidDate.chronicle[0],
      events: [{ key: 'history.chron.dayArchived', params: { date: 'not-a-date' } }],
    };
    expect(() => parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 6,
      exportedAt: '2026-10-06T00:00:00.000Z',
      ...invalidDate,
    }))).toThrow(/events/);
  });

  it('accepts semantic fields in current-version backups and keeps the fallback text', () => {
    const h = makeStore('2026-10-06');
    createProject(h.store, '备份项目');

    const restored = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: 6,
      exportedAt: '2026-10-06T00:00:00.000Z',
      ...h.store.data,
    }));

    expect(restored.chronicle[0].events?.[0]?.key).toBe('history.chron.projectCreated');
    expect(restored.chronicle[0].text).toContain('备份项目');
  });
});
