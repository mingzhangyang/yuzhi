import { describe, expect, it } from 'vitest';
import { LANDMARK_HEIGHT, LANDMARK_KINDS, landmarkKind } from '../src/island/render/style';

describe('地标样式轮换', () => {
  it('0–2 号仍是钟楼、藏书阁、风车：已经建成的前三座地标外观不变', () => {
    expect([0, 1, 2].map(landmarkKind)).toEqual(['clock', 'library', 'windmill']);
  });

  it('前八座地标各不相同，之后按八种循环', () => {
    const first = Array.from({ length: 8 }, (_, k) => landmarkKind(k));
    expect(new Set(first).size).toBe(8);
    expect(first.slice(3)).toEqual(['observatory', 'greenhouse', 'harbor', 'memorial', 'pavilion']);
    for (let k = 0; k < 40; k++) expect(landmarkKind(k + 8)).toBe(landmarkKind(k));
  });

  it('每种样式都有轮廓高度', () => {
    for (const kind of LANDMARK_KINDS) expect(LANDMARK_HEIGHT[kind]).toBeGreaterThan(0.4);
  });
});
