import type { ISODate } from '../types';
import { addDays, fmtDay, startOfLocalDay } from '../lib/date';

export type DateSelectMode = 'task' | 'schedule' | 'diary';

interface DateSelectOptions {
  current?: ISODate;
  withNone?: boolean;
  mode?: DateSelectMode;
}

function pushUnique(opts: Array<[string, string]>, value: string, label: string) {
  if (!opts.some(([v]) => v === value)) opts.push([value, label]);
}

/**
 * Shared date picker used by capture forms and tracker forms.
 * Presets keep the common choices fast while "other" always exposes the native date picker.
 */
export function dateSelect(name: string, today: ISODate, options: DateSelectOptions = {}) {
  const { current, withNone = true, mode = 'task' } = options;
  const opts: Array<[string, string]> = [];

  if (withNone) opts.push(['', '不定日期']);

  if (mode === 'diary') {
    opts.push([today, '今天'], [addDays(today, -1), '昨天'], [addDays(today, -2), '前天']);
  } else {
    opts.push([today, '今天'], [addDays(today, 1), '明天'], [addDays(today, 2), '后天']);
    const wd = startOfLocalDay(today).getDay();
    const nextMon = addDays(today, ((8 - wd) % 7) || 7);
    pushUnique(opts, nextMon, `下周一（${fmtDay(nextMon)}）`);
  }

  if (current) pushUnique(opts, current, fmtDay(current));
  opts.push(['other', '其他日期…']);

  const selected = current ?? (withNone ? '' : today);
  return `<select name="${name}" data-date-select data-date-mode="${mode}">${opts
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`)
    .join('')}</select>`;
}

export function readDate(sel: HTMLSelectElement): ISODate | undefined {
  return sel.value && sel.value !== 'other' ? (sel.value as ISODate) : undefined;
}

export function bindDateSelects(root: ParentNode, today: ISODate) {
  root.querySelectorAll<HTMLSelectElement>('select[data-date-select]').forEach((sel) => {
    // "other" is a transient editing sentinel, never a committed date. Keep
    // the last real selection separately so canceling the native picker is a
    // no-op instead of silently changing the date.
    let committedValue = sel.value === 'other' ? '' : sel.value;

    sel.addEventListener('change', () => {
      if (sel.value !== 'other') {
        committedValue = sel.value;
        return;
      }

      const previousValue = committedValue;
      const input = document.createElement('input');
      input.type = 'date';
      input.value = previousValue;
      input.setAttribute('aria-label', '选择日期');

      const mode = sel.dataset.dateMode as DateSelectMode | undefined;
      if (mode === 'diary') input.max = today;

      let done = false;
      const finish = () => {
        if (done) return;
        const value = input.value;
        if (value && !input.checkValidity()) {
          input.reportValidity();
          input.focus();
          return;
        }

        done = true;
        if (value) {
          if (![...sel.options].some((option) => option.value === value)) {
            sel.add(new Option(fmtDay(value), value), sel.options[sel.options.length - 1]);
          }
          sel.value = value;
          committedValue = value;
        } else {
          sel.value = previousValue;
          committedValue = previousValue;
        }
        input.remove();
        sel.hidden = false;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
      };

      // Keep both listeners alive while the native input is invalid. A one-shot
      // blur/change listener would be consumed by the first rejected attempt.
      input.addEventListener('change', finish);
      input.addEventListener('blur', finish);
      sel.hidden = true;
      sel.after(input);
      input.focus();

      try {
        input.showPicker?.();
      } catch {
        // Some browsers only allow showPicker from a direct user gesture.
      }
    });
  });
}
