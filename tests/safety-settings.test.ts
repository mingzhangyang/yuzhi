import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/ui/settlement-backup', () => ({ readSettlementSnapshot: snapshots.read }));
import { fillSafetySettings } from '../src/ui/safety';

function settings() {
  const snapshot = { textContent: 'checking' };
  const storage = { textContent: 'checking' };
  const button = { hidden: true };
  const box = {
    querySelector(selector: string) {
      if (selector === '[data-safety-snapshot]') return snapshot;
      if (selector === '[data-safety-snapshot-export]') return button;
      if (selector === '[data-safety-storage]') return storage;
      return null;
    },
  } as unknown as HTMLElement;
  return { box, snapshot, button };
}

beforeEach(() => { snapshots.read.mockReset(); });

describe('结算快照设置', () => {
  it('快照可读时显示日期和导出入口', async () => {
    snapshots.read.mockResolvedValue({ date: '2026-11-02', json: '{}', diaryCount: 0 });
    const view = settings();
    fillSafetySettings(view.box, () => true, true, () => '2026-11-02');
    await Promise.resolve();
    expect(view.snapshot.textContent).toContain('今天');
    expect(view.button.hidden).toBe(false);
  });

  it('异步读取失败时显示状态，不提供损坏快照的导出入口', async () => {
    snapshots.read.mockRejectedValue(new Error('blocked'));
    const view = settings();
    fillSafetySettings(view.box, () => true, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(view.snapshot.textContent).toContain('无法读取');
    expect(view.button.hidden).toBe(true);
  });

  it('设置窗口已经关闭时不更新复用的界面', async () => {
    snapshots.read.mockResolvedValue({ date: '2026-11-02', json: '{}', diaryCount: 0 });
    const view = settings();
    fillSafetySettings(view.box, () => false, true);
    await Promise.resolve();
    expect(view.snapshot.textContent).toBe('checking');
    expect(view.button.hidden).toBe(true);
  });
});
