import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { downloadSpy } = vi.hoisted(() => ({ downloadSpy: vi.fn() }));
vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  download: downloadSpy,
}));

import { deliverBackup } from '../src/ui/safety';

function usePicker(picker: unknown) {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    showSaveFilePicker: picker,
  });
}

beforeEach(() => {
  downloadSpy.mockReset();
  vi.stubGlobal('navigator', {});
  usePicker(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('manual backup delivery', () => {
  it('only reports saved after the writable stream has closed, with the correct Window receiver', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let enteredClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => { enteredClose = resolve; });
    const write = vi.fn(async (_text: string) => {});
    const abort = vi.fn(async () => {});
    const close = vi.fn(() => { enteredClose(); return closeGate; });
    const picker = vi.fn(async function (this: unknown, options: { suggestedName: string }) {
      expect(this).toBe(window);
      expect(options.suggestedName).toBe('backup.json');
      return { createWritable: async () => ({ write, close, abort }) };
    });
    usePicker(picker);

    const saving = deliverBackup('backup.json', '{"saved":true}');
    await closeStarted;
    let settled = false;
    void saving.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(downloadSpy).not.toHaveBeenCalled();
    releaseClose();

    await expect(saving).resolves.toBe('saved');
    expect(write).toHaveBeenCalledWith('{"saved":true}');
    expect(close).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it('treats a cancelled picker as cancelled, without falling back to a download', async () => {
    usePicker(async () => { throw new DOMException('User cancelled', 'AbortError'); });
    await expect(deliverBackup('backup.json', '{}')).resolves.toBe('cancelled');
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it.each(['picker', 'create', 'write', 'close'] as const)(
    'rejects a %s failure instead of reporting a successful download',
    async (phase) => {
      const abort = vi.fn(async () => {});
      const stream = {
        write: vi.fn(async () => { if (phase === 'write') throw new Error(phase + ' failed'); }),
        close: vi.fn(async () => { if (phase === 'close') throw new Error(phase + ' failed'); }),
        abort,
      };
      usePicker(async () => {
        if (phase === 'picker') throw new Error(phase + ' failed');
        return {
          createWritable: async () => {
            if (phase === 'create') throw new Error(phase + ' failed');
            return stream;
          },
        };
      });

      await expect(deliverBackup('backup.json', '{}')).rejects.toThrow(phase + ' failed');
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledTimes(phase === 'write' || phase === 'close' ? 1 : 0);
    },
  );

  it('marks the download-only fallback as unverified', async () => {
    await expect(deliverBackup('backup.json', '{}')).resolves.toBe('downloaded');
    expect(downloadSpy).toHaveBeenCalledExactlyOnceWith('backup.json', '{}');
  });
});
