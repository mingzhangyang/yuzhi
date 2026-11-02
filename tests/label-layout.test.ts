import { describe, expect, it } from 'vitest';
import { labelContains, layoutLabels, placedLabelBounds, type LabelRequest } from '../src/island/render/label-layout';

const box = (id: string, x: number, y: number, priority: number, optional = false): LabelRequest =>
  ({ id, x, y, w: 80, h: 20, priority, optional });

const rect = (q: LabelRequest, dy: number) => ({ l: q.x - q.w / 2, r: q.x + q.w / 2, t: q.y + dy - q.h / 2, b: q.y + dy + q.h / 2 });
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

describe('map label collision layout', () => {
  it('keeps labels that do not touch where they are', () => {
    const out = layoutLabels([box('a', 0, 0, 50), box('b', 200, 0, 50)]);
    expect(out.get('a')).toEqual({ dy: 0, hidden: false });
    expect(out.get('b')).toEqual({ dy: 0, hidden: false });
  });

  it('nudges the lower-priority label off a higher-priority one', () => {
    const village = box('village', 0, 0, 50);
    const granary = box('granary', 20, 6, 40);
    const out = layoutLabels([granary, village]);
    expect(out.get('village')!.dy).toBe(0);
    const g = out.get('granary')!;
    expect(g.hidden).toBe(false);
    expect(g.dy).not.toBe(0);
    expect(overlaps(rect(village, 0), rect(granary, g.dy))).toBe(false);
  });

  it('hides optional labels that have nowhere to go, but never required ones', () => {
    // A tight stack: required labels fill every candidate slot around the optional one.
    const stack = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map((y, i) => box(`v${i}`, 0, y, 50));
    const out = layoutLabels([...stack, box('farm', 0, 0, 20, true)]);
    expect(out.get('farm')!.hidden).toBe(true);
    for (const q of stack) expect(out.get(q.id)!.hidden).toBe(false);
  });

  it('shares shifted label geometry with pointer hit-testing', () => {
    const village = box('village:p', 0, 0, 50);
    const chores = box('chores', 20, 6, 30);
    const placed = layoutLabels([chores, village]);
    const bounds = placedLabelBounds([chores, village], placed).get('chores')!;
    expect(bounds.y).toBe(chores.y + placed.get('chores')!.dy);
    expect(bounds.y).not.toBe(chores.y);
    expect(labelContains(bounds, { x: bounds.x, y: bounds.y })).toBe(true);
    expect(labelContains(bounds, { x: bounds.x, y: bounds.y + bounds.h })).toBe(false);
  });

  it('excludes optional hidden labels from all interactive bounds', () => {
    const stack = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map((y, i) => box(`v${i}`, 0, y, 50));
    const optional = box('cultivation:tea', 0, 0, 20, true);
    const inputs = [...stack, optional];
    const visible = placedLabelBounds(inputs, layoutLabels(inputs));
    expect(visible.has(optional.id)).toBe(false);
    expect(visible.size).toBe(stack.length);
  });

  it('expands compact label hit targets', () => {
    expect(labelContains({ x: 0, y: 12, w: 40, h: 15 }, { x: 0, y: 23 })).toBe(true);
  });

  it('a selected (highest priority) label keeps its exact place', () => {
    const out = layoutLabels([box('a', 0, 0, 50), box('selected', 10, 4, 100)]);
    expect(out.get('selected')!.dy).toBe(0);
    expect(out.get('a')!.dy).not.toBe(0);
  });
});
