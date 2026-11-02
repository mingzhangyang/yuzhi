/**
 * 地图标签避让：按优先级依次摆放，和已摆好的标签重叠时上下挪一点；
 * 实在放不下的可选标签（培育区、地标）隐藏，必须显示的放在重叠最少的位置。
 * 纯几何，不碰 Canvas，方便测试。
 */

export interface LabelRequest {
  id: string;
  /** 胶囊中心 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 数字越大越先摆、越不让位 */
  priority: number;
  /** 放不下时可以不画 */
  optional?: boolean;
}

export interface LabelPlacement {
  dy: number;
  hidden: boolean;
}

interface Rect { l: number; r: number; t: number; b: number }

const rectOf = (q: LabelRequest, dy: number, gap: number): Rect => ({
  l: q.x - q.w / 2 - gap / 2,
  r: q.x + q.w / 2 + gap / 2,
  t: q.y + dy - q.h / 2 - gap / 2,
  b: q.y + dy + q.h / 2 + gap / 2,
});

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

/**
 * 候选位置：原位，然后先上后下、逐步加大偏移，最多挪 maxShift 倍标签高度。
 * 先上：标签本来就画在景物上方，往上挪不会盖住景物本身。
 */
function offsets(h: number, gap: number, maxShift: number): number[] {
  const step = (h + gap) / 2;
  const out = [0];
  for (let k = 1; k * step <= maxShift * h + 1e-6; k++) out.push(-k * step, k * step);
  return out;
}

export function layoutLabels(
  requests: readonly LabelRequest[],
  opts: { gap?: number; maxShift?: number } = {},
): Map<string, LabelPlacement> {
  const gap = opts.gap ?? 3;
  const maxShift = opts.maxShift ?? 1.6;
  const order = requests
    .map((q, i) => ({ q, i }))
    .sort((a, b) => b.q.priority - a.q.priority || a.i - b.i);
  const placed: Rect[] = [];
  const out = new Map<string, LabelPlacement>();
  for (const { q } of order) {
    let best: { dy: number; cost: number } | null = null;
    for (const dy of offsets(q.h, gap, maxShift)) {
      const r = rectOf(q, dy, gap);
      let cost = 0;
      for (const p of placed) cost += overlapArea(r, p);
      if (cost === 0) {
        best = { dy, cost };
        break;
      }
      if (!best || cost < best.cost) best = { dy, cost };
    }
    const chosen = best ?? { dy: 0, cost: 0 };
    if (chosen.cost > 0 && q.optional) {
      out.set(q.id, { dy: 0, hidden: true });
      continue;
    }
    // 必须显示却放不下：取重叠最少的位置（偏移本身有上限，不会离景物太远）。
    placed.push(rectOf(q, chosen.dy, gap));
    out.set(q.id, { dy: chosen.dy, hidden: false });
  }
  return out;
}
