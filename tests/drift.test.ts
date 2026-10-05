import { describe, expect, it } from 'vitest';
import { markDriftSeen, readSeenDrifts } from '../src/ui/drift';

describe('漂流瓶本地 UI 标记', () => {
  it('localStorage 读写失败时不阻断渲染', () => {
    const root = globalThis as typeof globalThis & { localStorage?: Storage };
    const previous = root.localStorage;
    Object.defineProperty(root, 'localStorage', {
      configurable: true,
      value: {
        getItem() { throw new Error('storage disabled'); },
        setItem() { throw new Error('storage disabled'); },
      },
    });
    try {
      expect(readSeenDrifts().has('周会')).toBe(false);
      const seen = markDriftSeen('周会');
      expect(seen.has('周会')).toBe(true);
      expect(readSeenDrifts().has('周会')).toBe(true);
    } finally {
      Object.defineProperty(root, 'localStorage', { configurable: true, value: previous });
    }
  });
});
