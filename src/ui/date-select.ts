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

/** A pending "Other date" picker is not a committed value for redraw drafts. */
export function draftDateSelectValue(sel: Pick<HTMLSelectElement, 'value' | 'dataset'>): string {
  return sel.value === 'other' ? (sel.dataset.committedDate ?? '') : sel.value;
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
  sel.value = plan.committedValue;
  sel.dataset.committedDate = plan.committedValue;
}

const boundDateSelects = new WeakSet<HTMLSelectElement>();

export function bindDateSelects(root: ParentNode, today: ISODate) {
  root.querySelectorAll<HTMLSelectElement>('select[data-date-select]').forEach((sel) => {
    // Tracker.render() can run without replacing the controls. Never install
    // multiple handlers on the same select.
    if (boundDateSelects.has(sel)) return;
    boundDateSelects.add(sel);
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
      input.required = true;
      input.setAttribute('aria-label', t('dateSelect.aria'));
      const mode = sel.dataset.dateMode as DateSelectMode | undefined;
      input.min = MIN_PICK_DATE;
      input.max = mode === 'diary' ? today : MAX_PICK_DATE;

      // Explicit confirmation avoids the native picker delivering blur BEFORE
      // its chosen date. Controls must be outside the label containing the
      // select: nesting buttons inside a label can reopen the select on Safari.
      const editor = document.createElement('span');
      editor.className = 'date-picker-editor';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'date-picker-apply';
      apply.textContent = t('dateSelect.apply');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = t('common.cancel');
      editor.append(input, apply, cancel);

      const form = sel.form;
      let finished = false;
      const finish = (date: string) => {
        if (finished) return;
        finished = true;
        form?.removeEventListener('submit', guardSubmit, true);
        restoreDateSelectValue(sel, date);
        editor.remove();
        sel.hidden = false;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const commit = (): boolean => {
        // Do not commit on change: while the year is typed, Chromium fires
        // change for intermediate values such as 0002, 0020 and 0202 (YZ-F1).
        const date = input.value;
        if (!isPlausibleDate(date) || !input.checkValidity()) {
          input.reportValidity();
          input.focus();
          return false;
        }
        finish(date);
        return true;
      };
      const guardSubmit = (event: Event) => {
        if (commit()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      apply.addEventListener('click', () => { commit(); });
      cancel.addEventListener('click', () => finish(previousValue));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(previousValue);
        } else if (event.key === 'Enter' && !form) {
          event.preventDefault();
          commit();
        }
      });
      form?.addEventListener('submit', guardSubmit, true);
      sel.hidden = true;
      const label = sel.closest('label');
      (label ?? sel).after(editor);
      input.focus();
      try {
        input.showPicker?.();
      } catch {
        // Some browsers only allow showPicker from a direct user gesture.
      }
    });
  });
}
