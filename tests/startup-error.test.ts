import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageUnavailableError } from '../src/db';

const snapshots = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/ui/settlement-backup', () => ({ readSettlementSnapshot: snapshots.read }));
import { showStartupError } from '../src/ui/startup-error';

class ButtonStub extends EventTarget {
  hidden = true;
  disabled = false;
  isConnected = true;
  focused = false;
  focus() { this.focused = true; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

class WrapStub {
  innerHTML = '';
  retry = new ButtonStub();
  exportButton = new ButtonStub();
  querySelector(selector: string) {
    return selector === '[data-retry-startup]' ? this.retry
      : selector === '[data-export-startup-snapshot]' ? this.exportButton : null;
  }
}

let wrap: WrapStub;
beforeEach(() => {
  wrap = new WrapStub();
  snapshots.read.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('document', { querySelector: (selector: string) => selector === '.wrap' ? wrap : null });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('启动错误界面', () => {
  it('持续显示错误、转义错误详情，并让重试按钮获得焦点', () => {
    const retry = vi.fn();
    showStartupError(new Error('<bad data>'), { retry, exportSnapshot: vi.fn() });
    expect(wrap.innerHTML).toContain('role="alert"');
    expect(wrap.innerHTML).toContain('&lt;bad data&gt;');
    expect(wrap.innerHTML).toContain('不要清除浏览器站点数据');
    expect(wrap.retry.focused).toBe(true);
    wrap.retry.click();
    wrap.retry.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('有已校验的结算快照时提供导出，没有快照时保持隐藏', async () => {
    const snapshot = { date: '2026-11-02', json: '{}', diaryCount: 0 };
    snapshots.read.mockResolvedValue(snapshot);
    const exportSnapshot = vi.fn();
    showStartupError(new StorageUnavailableError(new Error('blocked')), { retry: vi.fn(), exportSnapshot });
    await Promise.resolve();
    expect(wrap.innerHTML).toContain('本地存储暂时不可用');
    expect(wrap.exportButton.hidden).toBe(false);
    wrap.exportButton.click();
    expect(exportSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('快照库也不可用时仍能重试启动', async () => {
    snapshots.read.mockRejectedValue(new Error('blocked'));
    const retry = vi.fn();
    showStartupError(new Error('blocked'), { retry, exportSnapshot: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(wrap.exportButton.hidden).toBe(true);
    wrap.retry.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
