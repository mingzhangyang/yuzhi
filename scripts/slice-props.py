#!/usr/bin/env python3
"""把 art/source/ 里的道具原稿切成独立的运行时 WebP 小图。

用法（需要 Pillow、numpy、scipy）：
    pip install pillow numpy scipy
    python3 scripts/slice-props.py

输出：
    src/assets/island/props/<id>.webp   每个道具一张图
    src/island/prop-sprites.ts          尺寸与锚点元数据（自动生成，勿手改）

处理步骤：按 alpha 连通域找出每个物体 → 去掉抠图残留的低 alpha 光晕，
把边缘 alpha 拉伸到满值 → 用最近的实心像素颜色替换半透明边缘（去色边）→
裁到内容边界并留透明边 → 统一缩放后导出。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / 'art' / 'source'
OUT_DIR = ROOT / 'src' / 'assets' / 'island' / 'props'
META_FILE = ROOT / 'src' / 'island' / 'prop-sprites.ts'

# 原稿按行（从上到下）、行内从左到右排列的道具 id
SHEETS: dict[str, tuple[str, list[str]]] = {
    'props-harbor.webp': (
        'harbor',
        [
            'crate', 'stacked-crates', 'barrel', 'rope-coil', 'fishing-net',
            'dock-post', 'buoy', 'lantern-post', 'signpost', 'fence',
            'stone-stairs', 'market-stall', 'bench', 'water-jar',
            'handcart', 'fishing-supplies', 'dock-module', 'hoist',
        ],
    ),
    'props-nature.webp': (
        'nature',
        [
            'shore-rocks', 'reeds', 'grass-flowers', 'flowering-shrub',
            'driftwood', 'shells', 'stone-marker', 'stone-wall',
            'stone-lantern', 'stepping-path', 'haystack', 'vegetable-planter',
            'potted-flowers', 'clothesline', 'stump-seating', 'garden-gate',
        ],
    ),
}

SEED_ALPHA = 64      # 判定"属于物体"的 alpha 阈值，用于连通域分割
MIN_AREA = 2000      # 小于此面积的连通域视为碎屑
ALPHA_LO = 36        # 低于此值的 alpha 视为抠图光晕，直接清零
ALPHA_HI = 232       # 高于此值的 alpha 拉满到 255
CORE_ALPHA = 240     # 去色边时取色的"实心"像素阈值
REACH = 24           # 软边像素最多归属到距离物体多远（px）
SCALE = 0.75         # 原稿统一缩放比例
PAD = 2              # 透明留白（缩放后 px）


def find_objects(alpha: np.ndarray, count: int) -> list[np.ndarray]:
    """返回按阅读顺序排列的物体 mask（含软边）。"""
    labels, n = ndimage.label(alpha >= SEED_ALPHA, structure=np.ones((3, 3)))
    areas = ndimage.sum(np.ones_like(alpha), labels, range(1, n + 1))
    keep = [i + 1 for i, a in enumerate(areas) if a >= MIN_AREA]
    if len(keep) != count:
        raise SystemExit(f'expected {count} objects, found {len(keep)}')

    seeds = np.where(np.isin(labels, keep), labels, 0)
    # 每个像素归属到最近的物体，软边和光晕都跟着各自的物体走
    dist, (iy, ix) = ndimage.distance_transform_edt(seeds == 0, return_indices=True)
    owner = np.where((alpha > 0) & (dist <= REACH), seeds[iy, ix], 0)

    centers = {k: ndimage.center_of_mass(seeds == k) for k in keep}
    order = sorted(keep, key=lambda k: centers[k][0])
    rows: list[list[int]] = []
    for k in order:
        if rows and centers[k][0] - centers[rows[-1][0]][0] < 120:
            rows[-1].append(k)
        else:
            rows.append([k])
    ordered = [k for row in rows for k in sorted(row, key=lambda k: centers[k][1])]
    return [owner == k for k in ordered]


def clean(rgba: np.ndarray, mask: np.ndarray) -> np.ndarray:
    rgb = rgba[..., :3]
    a = np.where(mask, rgba[..., 3], 0).astype(np.float32)
    a = np.clip((a - ALPHA_LO) / (ALPHA_HI - ALPHA_LO), 0, 1) * 255
    core = mask & (rgba[..., 3] >= CORE_ALPHA)
    _, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    out = np.zeros_like(rgba)
    out[..., :3] = np.where(core[..., None], rgb, rgb[iy, ix])
    out[..., 3] = np.round(a).astype(np.uint8)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob('*.webp'):
        old.unlink()
    meta: list[str] = []
    for file, (category, ids) in SHEETS.items():
        rgba = np.array(Image.open(SRC_DIR / file).convert('RGBA'))
        for sprite_id, mask in zip(ids, find_objects(rgba[..., 3], len(ids))):
            obj = clean(rgba, mask)
            ys, xs = np.nonzero(obj[..., 3])
            crop = Image.fromarray(obj[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
            w = round(crop.width * SCALE)
            h = round(crop.height * SCALE)
            img = Image.new('RGBA', (w + PAD * 2, h + PAD * 2))
            img.paste(crop.resize((w, h), Image.LANCZOS), (PAD, PAD))
            img.save(OUT_DIR / f'{sprite_id}.webp', quality=86, alpha_quality=100, method=6)
            # 锚点：内容底边中点（不含透明留白）
            ax = (PAD + w / 2) / img.width
            ay = (PAD + h) / img.height
            meta.append(
                f"  '{sprite_id}': {{ category: '{category}', w: {img.width}, h: {img.height}, "
                f'anchorX: {ax:.3f}, anchorY: {ay:.3f} }},'
            )

    META_FILE.write_text(
        '// 由 scripts/slice-props.py 生成，请勿手动修改。\n'
        "export type PropCategory = 'harbor' | 'nature';\n\n"
        'export interface PropSpriteMeta {\n'
        '  category: PropCategory;\n'
        '  w: number;\n'
        '  h: number;\n'
        '  anchorX: number;\n'
        '  anchorY: number;\n'
        '}\n\n'
        'export const PROP_SPRITES = {\n' + '\n'.join(meta) + '\n'
        '} as const satisfies Record<string, PropSpriteMeta>;\n\n'
        'export type PropId = keyof typeof PROP_SPRITES;\n',
        encoding='utf-8',
    )
    print(f'wrote {len(meta)} sprites to {OUT_DIR.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
