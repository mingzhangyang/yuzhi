import { describe, expect, it } from 'vitest';
import { buildScene } from '../src/ui/scene';
import { makeStore } from './helpers';

describe('scene time snapshot', () => {
  it('derives date, light and hour from one clock reading', () => {
    const { store } = makeStore();
    let calls = 0;
    store.clock = () => {
      calls++;
      return calls === 1
        ? new Date(2026, 9, 4, 23, 59, 30)
        : new Date(2026, 9, 5, 0, 0, 30);
    };

    const scene = buildScene(store, null, false);

    expect(calls).toBe(1);
    expect(scene.date).toBe('2026-10-04');
    expect(scene.season).toBe(2);
    expect(scene.light).toBe('night');
    expect(scene.hour).toBeCloseTo(23 + 59 / 60, 6);
  });

  it('uses a supplied snapshot without rereading the clock', () => {
    const { store } = makeStore();
    store.clock = () => { throw new Error('buildScene should use the supplied snapshot'); };
    const now = new Date(2026, 9, 5, 6, 15, 0);

    const scene = buildScene(store, null, false, now);

    expect(scene.date).toBe('2026-10-05');
    expect(scene.light).toBe('day');
    expect(scene.hour).toBe(6.25);
  });
});
