// 由 scripts/slice-props.py 生成，请勿手动修改。
export type PropCategory = 'harbor' | 'nature';

export interface PropSpriteMeta {
  category: PropCategory;
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
}

export const PROP_SPRITES = {
  'crate': { category: 'harbor', w: 201, h: 166, anchorX: 0.500, anchorY: 0.988 },
  'stacked-crates': { category: 'harbor', w: 209, h: 186, anchorX: 0.500, anchorY: 0.989 },
  'barrel': { category: 'harbor', w: 158, h: 174, anchorX: 0.500, anchorY: 0.989 },
  'rope-coil': { category: 'harbor', w: 177, h: 158, anchorX: 0.500, anchorY: 0.987 },
  'fishing-net': { category: 'harbor', w: 205, h: 176, anchorX: 0.500, anchorY: 0.989 },
  'dock-post': { category: 'harbor', w: 181, h: 215, anchorX: 0.500, anchorY: 0.991 },
  'buoy': { category: 'harbor', w: 172, h: 178, anchorX: 0.500, anchorY: 0.989 },
  'lantern-post': { category: 'harbor', w: 132, h: 224, anchorX: 0.500, anchorY: 0.991 },
  'signpost': { category: 'harbor', w: 142, h: 235, anchorX: 0.500, anchorY: 0.991 },
  'fence': { category: 'harbor', w: 239, h: 178, anchorX: 0.500, anchorY: 0.989 },
  'stone-stairs': { category: 'harbor', w: 259, h: 176, anchorX: 0.500, anchorY: 0.989 },
  'market-stall': { category: 'harbor', w: 274, h: 230, anchorX: 0.500, anchorY: 0.991 },
  'bench': { category: 'harbor', w: 248, h: 170, anchorX: 0.500, anchorY: 0.988 },
  'water-jar': { category: 'harbor', w: 198, h: 156, anchorX: 0.500, anchorY: 0.987 },
  'handcart': { category: 'harbor', w: 266, h: 165, anchorX: 0.500, anchorY: 0.988 },
  'fishing-supplies': { category: 'harbor', w: 236, h: 152, anchorX: 0.500, anchorY: 0.987 },
  'dock-module': { category: 'harbor', w: 270, h: 186, anchorX: 0.500, anchorY: 0.989 },
  'hoist': { category: 'harbor', w: 229, h: 193, anchorX: 0.500, anchorY: 0.990 },
  'shore-rocks': { category: 'nature', w: 380, h: 258, anchorX: 0.500, anchorY: 0.992 },
  'reeds': { category: 'nature', w: 216, h: 243, anchorX: 0.500, anchorY: 0.992 },
  'grass-flowers': { category: 'nature', w: 215, h: 176, anchorX: 0.500, anchorY: 0.989 },
  'flowering-shrub': { category: 'nature', w: 231, h: 199, anchorX: 0.500, anchorY: 0.990 },
  'driftwood': { category: 'nature', w: 320, h: 146, anchorX: 0.500, anchorY: 0.986 },
  'shells': { category: 'nature', w: 188, h: 108, anchorX: 0.500, anchorY: 0.981 },
  'stone-marker': { category: 'nature', w: 192, h: 186, anchorX: 0.500, anchorY: 0.989 },
  'stone-wall': { category: 'nature', w: 330, h: 180, anchorX: 0.500, anchorY: 0.989 },
  'stone-lantern': { category: 'nature', w: 194, h: 215, anchorX: 0.500, anchorY: 0.991 },
  'stepping-path': { category: 'nature', w: 343, h: 190, anchorX: 0.500, anchorY: 0.989 },
  'haystack': { category: 'nature', w: 235, h: 185, anchorX: 0.500, anchorY: 0.989 },
  'vegetable-planter': { category: 'nature', w: 282, h: 178, anchorX: 0.500, anchorY: 0.989 },
  'potted-flowers': { category: 'nature', w: 262, h: 164, anchorX: 0.500, anchorY: 0.988 },
  'clothesline': { category: 'nature', w: 259, h: 184, anchorX: 0.500, anchorY: 0.989 },
  'stump-seating': { category: 'nature', w: 243, h: 149, anchorX: 0.500, anchorY: 0.987 },
  'garden-gate': { category: 'nature', w: 258, h: 201, anchorX: 0.500, anchorY: 0.990 },
} as const satisfies Record<string, PropSpriteMeta>;

export type PropId = keyof typeof PROP_SPRITES;
