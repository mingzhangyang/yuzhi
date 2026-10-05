const KEY = 'yuzhi.drift.seen';
const volatileSeen = new Set<string>();

/** 已捞起只属于当前浏览器的 UI 状态，不进 Store、备份或同步。 */
export function readSeenDrifts(): Set<string> {
  const seen = new Set(volatileSeen);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seen;
    const values: unknown = JSON.parse(raw);
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === 'string') seen.add(value);
    }
  } catch {
    // Storage is optional; volatileSeen remains authoritative for this page.
  }
  return seen;
}

export function markDriftSeen(title: string): Set<string> {
  volatileSeen.add(title);
  const seen = readSeenDrifts();
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen]));
  } catch {
    // Storage is optional. volatileSeen keeps the pickup stable for this page.
  }
  return seen;
}
