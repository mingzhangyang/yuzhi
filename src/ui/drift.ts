const KEY = 'yuzhi.drift.seen';

/** 已捞起只属于当前浏览器的 UI 状态，不进 Store、备份或同步。 */
export function readSeenDrifts(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) ? new Set(values.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function markDriftSeen(title: string): Set<string> {
  const seen = readSeenDrifts();
  seen.add(title);
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen]));
  } catch {
    // Storage is optional. The current render still treats this bottle as
    // picked up; a later reload may show it again when storage is unavailable.
  }
  return seen;
}
