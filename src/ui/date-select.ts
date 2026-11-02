import type { ISODate } from '../types';
import { addDays, fmtDay, fmtDayFrom, isPlausibleDate, localDate, MAX_PICK_DATE, MIN_PICK_DATE, startOfLocalDay } from '../lib/date';
import { t } from '../i18n';

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

  if (withNone) opts.push(['', t('dateSelect.none')]);

  if (mode === 'diary') {
    opts.push([today, t('date.today')], [addDays(today, -1), t('date.yesterday')], [addDays(today, -2), t('date.dayBeforeYesterday')]);
  } else {
    opts.push([today, t('date.today')], [addDays(today, 1), t('date.tomorrow')], [addDays(today, 2), t('date.dayAfterTomorrow')]);
    const wd = startOfLocalDay(today).getDay();
    const nextMon = addDays(today, ((8 - wd) % 7) || 7);
    pushUnique(opts, nextMon, t('dateSelect.nextMonday', { date: fmtDay(nextMon) }));
  }

  if (current) pushUnique(opts, current, fmtDayFrom(current, today));
  opts.push(['other', t('dateSelect.other')]);

  const selected = current ?? (withNone ? '' : today);
  return `<select name="${name}" data-date-select data-date-mode="${mode}">${opts
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`)
    .join('')}</select>`;
}

export function readDate(sel: HTMLSelectElement): ISODate | undefined {
  return isPlausibleDate(sel.value) ? sel.value : undefined;
}

export interface DateSelectRestorePlan {
  addOption: boolean;
  committedValue: string;
}

/**
 * Decide how to restore a drafted date after the select markup is rebuilt.
 * Custom dates are runtime options, so assigning select.value alone is not
 * sufficient when the rebuilt select does not contain that option.
 */
export function dateSelectRestorePlan(optionValues: readonly string[], value: string): DateSelectRestorePlan {
  const committedValue = value === 'other' ? '' : value;
  return {
    addOption: Boolean(committedValue) && !optionValues.includes(committedValue),
    committedValue,
  };
}

export function restoreDateSelectValue(sel: HTMLSelectElement, value: string): void {
  const plan = dateSelectRestorePlan([...sel.options].map((option) => option.value), value);
  if (plan.addOption) {
    const option = document.createElement('option');
    option.value = plan.committedValue;
    option.textContent = fmtDayFrom(plan.committedValue as ISODate, localDate());
    const other = [...sel.options].find((candidate) => candidate.value === 'other') ?? null;
    sel.insertBefore(option, other);
  }
  sel.value = value;
  sel.dataset.committedDate = plan.committedValue;
}

export function bindDateSelects(root: ParentNode, today: ISODate) {
  root.querySelectorAll<HTMLSelectElement>('select[data-date-select]').forEach((sel) => {
    // "other" is a transient editing sentinel, never a committed date. Keep
    // the last real selection on the element so locale-driven DOM restoration
    // can synchronize the picker state after rebuilding its options.
    sel.dataset.committedDate = sel.value === 'other' ? (sel.dataset.committedDate ?? '') : sel.value;

    sel.addEventListener('change', () => {
      if (sel.value !== 'other') {
        sel.dataset.committedDate = sel.value;
        return;
      }

      const previousValue = sel.dataset.committedDate ?? '';
      const input = document.createElement('input');
      input.type = 'date';
      input.value = previousValue;
      input.setAttribute('aria-label', t('dateSelect.aria'));

      // Out-of-range values are almost always a half-typed year (0002, 0020…).
      const mode = sel.dataset.dateMode as DateSelectMode | undefined;
      input.min = MIN_PICK_DATE;
      input.max = mode === 'diary' ? today : MAX_PICK_DATE;

      const form = sel.form;
      let done = false;
      const finish = (): boolean => {
        if (done) return true;
        const value = input.value;
        if (value && !input.checkValidity()) {
          input.reportValidity();
          input.focus();
          return false;
        }

        done = true;
        form?.removeEventListener('submit', guardSubmit, true);
        if (value) restoreDateSelectValue(sel, value);
        else restoreDateSelectValue(sel, previousValue);
        input.remove();
        sel.hidden = false;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      // Submitting (button click or Enter inside the date field) commits the
      // date first, so the form's own handler reads the final value. An invalid
      // date blocks the submission instead of silently saving "no date".
      const guardSubmit = (event: Event) => {
        if (finish()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      // Do NOT commit on change: while the year is typed digit by digit,
      // Chromium fires change for 0002-11-03, 0020-11-03, 0202-11-03 and only
      // then 2026-11-03. Committing on the first one stored year 2 (YZ-F1).
      // Commit when the field is left, on Enter, or when the form submits.
      // Keep the blur listener alive while the value is invalid.
      input.addEventListener('blur', () => { finish(); });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || form) return;
        event.preventDefault();
        finish();
      });
      form?.addEventListener('submit', guardSubmit, true);
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
