export const SKIN = ['#f1c9a5', '#e6b48c', '#d9a074', '#c98d62'];
export const HAIR = ['#2f2620', '#4a3426', '#1f1c1a', '#6b4a2e', '#3b2f2a'];
export const SNOW = '#f3f6f8';
export const BEACH = '#e9d9ae';
export const SNOW_SHADE = '#d6e0e8';
export const WARM = '255,206,110';
export const LANTERN = '255,120,70';
export const FIREWORK = ['#ffd36b', '#ff7a6b', '#8fd3ff', '#c99bff', '#9dff9b', '#ffffff', '#ffb3d9'];

/** 村落房屋相对地块宽度的比例。 */
export const HOUSE_SCALE = 0.42;

/** 小人的绘制尺寸：约为地块宽的 0.15，手机上不小于 4px，身高大致与屋檐齐平。 */
export function personSize(tw: number): number {
  return Math.max(4, tw * 0.15);
}
