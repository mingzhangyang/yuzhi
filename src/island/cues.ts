import { AGENDA_BELL_COOLDOWN_SEC } from '../logic/config';
import type { Stage } from '../logic/config';
import type { Scene } from './render';

export type Cue =
  | { kind: 'house-built'; projectId: string }
  | { kind: 'stage-changed'; projectId: string; from: Stage; to: Stage }
  | { kind: 'granary-changed'; from: number; to: number }
  | { kind: 'fog-changed'; from: number; to: number }
  | { kind: 'bell'; projectId: string; eventId: string }
  | { kind: 'kiln'; projectId: string };

export interface BellCandidate {
  projectId: string;
  eventId: string;
  start: number;
  slot: number;
}

/**
 * 选择全岛唯一的钟声候选。时间和排序都作为参数传入，便于单独测试；
 * 「已响过」由 Renderer 在一个生命周期内维护，不写入数据。
 */
export function pickBell(
  candidates: BellCandidate[],
  lastBellAt: number | null,
  selected: string | null,
  now: number,
): BellCandidate | null {
  if (lastBellAt != null && now - lastBellAt < AGENDA_BELL_COOLDOWN_SEC * 1000) return null;
  return candidates
    .filter((candidate) => Number.isFinite(candidate.start))
    .slice()
    .sort((a, b) =>
      Number(b.projectId === selected) - Number(a.projectId === selected)
      || a.start - b.start
      || a.slot - b.slot
      || a.eventId.localeCompare(b.eventId),
    )[0] ?? null;
}

function villageMap(scene: Scene | null): Map<string, Scene['villages'][number]> {
  return new Map((scene?.villages ?? []).map((v) => [v.projectId, v] as const));
}

function landmarkMap(scene: Scene | null): Map<string, Scene['landmarks'][number]> {
  return new Map((scene?.landmarks ?? []).map((v) => [v.projectId, v] as const));
}

/**
 * 只比较两个画面快照，不碰 Store，也不决定任何业务后果。
 * 首次加载返回空队列，避免刷新页面时把静态状态误报成刚刚发生的事。
 */
export function diffScene(prev: Scene | null, next: Scene): Cue[] {
  if (!prev) return [];
  const cues: Cue[] = [];
  const oldVillages = villageMap(prev);
  const oldLandmarks = landmarkMap(prev);

  for (const village of next.villages) {
    const old = oldVillages.get(village.projectId);
    if (!old) continue;
    if (village.houses > old.houses) cues.push({ kind: 'house-built', projectId: village.projectId });
    if (village.stage !== old.stage) cues.push({ kind: 'stage-changed', projectId: village.projectId, from: old.stage, to: village.stage });
    // 只有结算成「做了 / 做了一部分」才烧成砖；结算成「没做」时砖坯只是淡出。
    if (prev.date === next.date && (village.firedToday ?? 0) > (old.firedToday ?? 0)) cues.push({ kind: 'kiln', projectId: village.projectId });

    const oldSoon = new Set((old.agenda?.soon ?? []).map((item) => item.eventId));
    for (const item of village.agenda?.soon ?? []) {
      if (!oldSoon.has(item.eventId)) cues.push({ kind: 'bell', projectId: village.projectId, eventId: item.eventId });
    }
  }

  for (const landmark of next.landmarks) {
    const old = oldLandmarks.get(landmark.projectId);
    if (!old || landmark.size > old.size) cues.push({ kind: 'house-built', projectId: landmark.projectId });
  }

  if (prev.granaryRatio !== next.granaryRatio) cues.push({ kind: 'granary-changed', from: prev.granaryRatio, to: next.granaryRatio });
  if (prev.fog !== next.fog) cues.push({ kind: 'fog-changed', from: prev.fog, to: next.fog });
  return cues;
}
