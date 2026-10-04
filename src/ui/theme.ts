import type { Settings } from '../types';

export type ThemeDataset = { theme?: string };

/**
 * Make the DOM theme marker reflect the authoritative Store setting.
 * Returns true only when the marker had to change.
 */
export function syncThemeDataset(theme: Settings['theme'], dataset: ThemeDataset): boolean {
  const matches = theme === 'auto' ? dataset.theme === undefined : dataset.theme === theme;
  if (matches) return false;
  if (theme === 'auto') delete dataset.theme;
  else dataset.theme = theme;
  return true;
}
