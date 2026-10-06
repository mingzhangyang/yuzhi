import type { ChronicleLine, LifeEntry } from './types';
import type { HistoryEvent } from './history-types';
import { formatCalendarDay, getLocale, message, type Locale, type MessageKey, type MessageVars } from './i18n';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const STALLED_REASONS = [
  ['interrupted', 'history.reason.interrupted'],
  ['noEnergy', 'history.reason.noEnergy'],
  ['notImportant', 'history.reason.notImportant'],
  ['postponed', 'history.reason.postponed'],
] as const;

function displayVars(event: HistoryEvent, target: Locale): MessageVars {
  const vars: MessageVars = {};
  for (const [name, value] of Object.entries(event.params ?? {})) {
    vars[name] = typeof value === 'string'
      && ISO_DATE.test(value)
      && (name === 'date' || name.endsWith('Date'))
      ? formatCalendarDay(value, target)
      : value;
  }

  if (event.key === 'history.reason.stalled' || event.key === 'history.life.projectClosedStalled') {
    const reasons = STALLED_REASONS
      .map(([param, labelKey], index) => ({
        labelKey,
        count: Number(event.params?.[param] ?? 0),
        index,
      }))
      .filter((item) => Number.isFinite(item.count) && item.count > 0)
      .sort((a, b) => b.count - a.count || a.index - b.index);
    const parts = reasons.map((item) =>
      message(target, 'history.reason.count', {
        reason: message(target, item.labelKey),
        count: item.count,
      }),
    );
    vars.detail = parts.length
      ? target === 'zh-CN' ? `（${parts.join('、')}）` : ` (${parts.join(', ')})`
      : '';
  }
  return vars;
}

export function formatHistoryEvent(event: HistoryEvent, target: Locale = getLocale()): string {
  return message(target, event.key as MessageKey, displayVars(event, target));
}

export function formatChronicleEvents(events: readonly HistoryEvent[], target: Locale = getLocale()): string {
  const clauses = events.map((event) => formatHistoryEvent(event, target)).filter(Boolean);
  if (!clauses.length) return '';
  return target === 'zh-CN' ? clauses.join('，') + '。' : clauses.join('; ') + '.';
}

export function formatChronicleLine(line: ChronicleLine, target: Locale = getLocale()): string {
  return line.events?.length ? formatChronicleEvents(line.events, target) : line.text;
}

export function formatLifeEntry(entry: LifeEntry, target: Locale = getLocale()): string {
  return entry.event ? formatHistoryEvent(entry.event, target) : entry.text;
}
