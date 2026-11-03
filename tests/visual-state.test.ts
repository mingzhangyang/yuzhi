import { describe, expect, it } from 'vitest';
import { cultivationExtent, cultivationOutline } from '../src/island/render/cultivation';
import { groundVillageCacheKey } from '../src/island/render/paint/terrain';
import {
  collapsedSlot,
  CULTIVATION_STEPS,
  cultivationElements,
  DECAY_LOOK,
  decayLook,
  GRANARY_EMPTY,
  GRANARY_SACKS,
  granaryEmpty,
  granarySacks,
  houseBoarded,
  houseLit,
  houseSmokes,
  missingSlabs,
  WALL_MATERIALS,
  wallMaterial,
} from '../src/island/render/visual-state';

const KINDS = ['field', 'orchard', 'pond', 'garden'] as const;

describe('B1 衰败阶段的画法', () => {
  it('四个阶段一档比一档更冷清：只减不增', () => {
    expect(DECAY_LOOK).toHaveLength(4);
    for (let k = 1; k < 4; k++) {
      const a = DECAY_LOOK[k - 1];
      const b = DECAY_LOOK[k];
      expect(b.roofSaturation).toBeLessThan(a.roofSaturation);
      expect(b.roofDust).toBeGreaterThanOrEqual(a.roofDust);
      expect(b.smokeShare).toBeLessThanOrEqual(a.smokeShare);
      expect(b.litShare).toBeLessThan(a.litShare);
      expect(b.plazaGrass).toBeGreaterThan(a.plazaGrass);
      expect(b.plazaMissing).toBeGreaterThanOrEqual(a.plazaMissing);
      expect(b.groundFade).toBeGreaterThanOrEqual(a.groundFade);
      expect(b.pathGrass).toBeGreaterThan(a.pathGrass);
      expect(b.yardProps).toBeLessThanOrEqual(a.yardProps);
    }
  });

  it('按计划表落在各阶段：正常完整、安静炊烟减半、蒙灰褪色长草、搬离塌顶撤道具', () => {
    expect(decayLook(0)).toMatchObject({ roofSaturation: 1, smokeShare: 1, plazaGrass: 0, plazaMissing: 0, groundFade: 0, weeds: false, yardProps: 1, collapsed: 0 });
    expect(decayLook(1).smokeShare).toBe(0.5);
    expect(decayLook(1).groundFade).toBe(0);
    expect(decayLook(2)).toMatchObject({ weeds: true, yardProps: 0.5 });
    expect(decayLook(2).groundFade).toBeGreaterThan(0);
    expect(decayLook(2).plazaMissing).toBeGreaterThan(0);
    expect(decayLook(3)).toMatchObject({ collapsed: 1, yardProps: 0, boarded: true });
    // 搬离的地面发黄，蒙灰的是灰褐
    expect(decayLook(3).groundDry).toBeGreaterThan(decayLook(2).groundDry);
    // 越界的阶段取最近的一档
    expect(decayLook(-1)).toBe(DECAY_LOOK[0]);
    expect(decayLook(9)).toBe(DECAY_LOOK[3]);
  });

  it('安静的村子大约一半人家熄了炊烟，正常的都冒烟、蒙灰以后都不冒', () => {
    const slots = [...Array(200).keys()];
    const share = (stage: number) => slots.filter((k) => houseSmokes(`p-${k % 7}`, k, stage)).length / slots.length;
    expect(share(0)).toBe(1);
    expect(share(1)).toBeGreaterThan(0.35);
    expect(share(1)).toBeLessThan(0.65);
    expect(share(2)).toBe(0);
    expect(share(3)).toBe(0);
    // 亮灯：安静比正常少
    const lit = (stage: number) => slots.filter((k) => houseLit(`p-${k % 7}`, k, stage)).length;
    expect(lit(1)).toBeLessThan(lit(0));
  });

  it('搬离时塌顶的是一户封了窗的单号户；只有一户时就是它；别的阶段不塌', () => {
    for (const id of ['a', 'b', 'c', 'writing', 'garden']) {
      for (let houses = 2; houses <= 10; houses++) {
        const k = collapsedSlot(id, houses, 3);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(k).toBeLessThan(houses);
        expect(k % 2).toBe(1);
        expect(houseBoarded(k, 3)).toBe(true);
        expect(collapsedSlot(id, houses, 3)).toBe(k);
      }
      expect(collapsedSlot(id, 1, 3)).toBe(0);
      expect(collapsedSlot(id, 0, 3)).toBe(-1);
      for (const stage of [0, 1, 2]) expect(collapsedSlot(id, 6, stage)).toBe(-1);
    }
  });

  it('广场缺的石板数与阶段一致、位置稳定，也不挑井底下那块', () => {
    expect(missingSlabs(10, 12, 0)).toEqual([]);
    expect(missingSlabs(10, 12, 1)).toEqual([]);
    const two = missingSlabs(10, 12, 2);
    expect(two).toHaveLength(decayLook(2).plazaMissing);
    expect(missingSlabs(10, 12, 2)).toEqual(two);
    const three = missingSlabs(10, 12, 3);
    expect(three).toHaveLength(decayLook(3).plazaMissing);
    // 搬离时缺得更多，蒙灰时缺的那几块还缺着
    for (const k of two) expect(three).toContain(k);
    for (const k of three) {
      expect(k).not.toBe(4);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(9);
    }
  });
});

describe('B4 墙面材质', () => {
  it('按项目 id 稳定分配，三种都用得上', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) {
      const m = wallMaterial(`project-${k}`);
      expect(WALL_MATERIALS).toContain(m);
      expect(wallMaterial(`project-${k}`)).toBe(m);
      seen.add(m);
    }
    expect(seen.size).toBe(3);
  });
});

describe('B2 培育区等级的画面元素', () => {
  it('每一级都比上一级多出一样新东西，0 级也不是空的', () => {
    for (const kind of KINDS) {
      expect(CULTIVATION_STEPS[kind]).toHaveLength(5);
      expect(cultivationElements(kind, 0).size).toBeGreaterThan(0);
      for (let level = 1; level <= 4; level++) {
        const before = cultivationElements(kind, level - 1);
        const now = cultivationElements(kind, level);
        const added = [...now].filter((e) => !before.has(e));
        expect(added.length, `${kind} ${level}`).toBeGreaterThan(0);
        for (const e of CULTIVATION_STEPS[kind][level]) expect(now.has(e), `${kind} ${level} ${e}`).toBe(true);
      }
    }
  });

  it('长大的东西替换前一级（嫩芽长成作物、树苗长成成树），其余的一直留着', () => {
    expect([...cultivationElements('field', 4)].sort()).toEqual(['bund', 'crop-gold', 'haystack', 'ridges', 'scarecrow']);
    expect(cultivationElements('orchard', 2).has('stakes')).toBe(false);
    expect(cultivationElements('orchard', 1).has('stakes')).toBe(true);
    expect(cultivationElements('orchard', 4).has('blossom')).toBe(false);
    expect([...cultivationElements('pond', 4)].sort()).toEqual(['ducks', 'fish', 'jetty', 'lilies', 'reeds', 'ripples', 'rod', 'still-water', 'stone-bank']);
    expect(cultivationElements('garden', 3).has('sparse-bloom')).toBe(false);
    expect(cultivationElements('garden', 4).has('fence')).toBe(true);
  });

  it('遮挡外框随高出来的元素一起变高：稻草人、成树、花拱门', () => {
    expect(cultivationExtent('field', 3).above).toBeGreaterThan(cultivationExtent('field', 0).above);
    expect(cultivationExtent('orchard', 2).above).toBeGreaterThan(cultivationExtent('orchard', 1).above);
    expect(cultivationExtent('garden', 4).above).toBeGreaterThan(cultivationExtent('garden', 3).above);
    for (const kind of KINDS) {
      for (let level = 0; level <= 4; level++) {
        const e = cultivationExtent(kind, level);
        // 外框不比原来的更窄、更矮（原来是半宽 0.47–0.49、上 0.23–0.4、下 0.23–0.24）
        // 不得收缩 B 期以前的点击范围：每类地块的旧尺寸不同。
        const prior = {
          field: { half: 0.47, above: 0.26, below: 0.24 },
          orchard: { half: 0.47, above: 0.4, below: 0.24 },
          pond: { half: 0.49, above: 0.23, below: 0.23 },
          garden: { half: 0.47, above: 0.26, below: 0.24 },
        }[kind];
        expect(e.half).toBeGreaterThanOrEqual(prior.half);
        expect(e.above).toBeGreaterThanOrEqual(prior.above);
        expect(e.below).toBeGreaterThanOrEqual(prior.below);
      }
    }
  });

  it('鱼塘 0–4 级保留旧版 0.49 半宽，左右边缘仍可点击和检查', () => {
    for (let level = 0; level <= 4; level++) {
      expect(cultivationExtent('pond', level).half).toBe(0.49);
      const outline = cultivationOutline(
        { kind: 'pond', level } as Parameters<typeof cultivationOutline>[0],
        100, 200, 100,
      );
      expect(outline[0][0]).toBeCloseTo(51);
      expect(outline[1][0]).toBeCloseTo(149);
    }
  });
});

describe('B1 衰败地面的缓存身份', () => {
  it('同一占位和衰败阶段更换项目也要重绘，输入不变则命中缓存', () => {
    const oldVillage = { slot: 0, projectId: 'old-project', houses: 6, stage: 2 as const };
    const key = groundVillageCacheKey([oldVillage]);
    expect(groundVillageCacheKey([{ ...oldVillage }])).toBe(key);
    expect(groundVillageCacheKey([{ ...oldVillage, projectId: 'new-project' }])).not.toBe(key);
    expect(groundVillageCacheKey([{ ...oldVillage, houses: 7 }])).not.toBe(key);
    expect(groundVillageCacheKey([{ ...oldVillage, stage: 3 }])).not.toBe(key);
    // 长短和分隔符不影响编码的唯一性
    expect(groundVillageCacheKey([{ ...oldVillage, projectId: 'old|project:2' }])).not.toBe(key);
  });
});

describe('B3 粮仓', () => {
  it('门口的麻袋随余量增加，0–5 袋', () => {
    let last = -1;
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const n = granarySacks(r);
      expect(n).toBeGreaterThanOrEqual(last);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(GRANARY_SACKS);
      last = n;
    }
    expect(granarySacks(1)).toBe(5);
    expect(granarySacks(3)).toBe(5);
    expect(granarySacks(0.5)).toBe(3);
  });

  it('余量低于两成时仓门敞开、一袋不剩；够两成就至少一袋', () => {
    for (const r of [0, 0.05, 0.19, NaN, -1]) {
      expect(granaryEmpty(r)).toBe(true);
      expect(granarySacks(r)).toBe(0);
    }
    expect(granaryEmpty(GRANARY_EMPTY)).toBe(false);
    expect(granarySacks(GRANARY_EMPTY)).toBe(1);
  });
});
