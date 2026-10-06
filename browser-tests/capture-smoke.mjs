/**
 * Unified capture-flow regression smoke.
 *
 * Covers the product-level invariants behind Todo / project / diary / schedule
 * creation, including context defaults and diary draft recovery.
 */
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const timeout = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ channel: channel || undefined, headless: true });

try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.yuzhi?.tracker && window.yuzhi?.store), undefined, { timeout });
  await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout });

  if (await page.locator('#mdl').isVisible()) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  }

  // Global Todo capture stays neutral: no project and no date are implied.
  await page.locator('#newBtn').click();
  const taskDefaults = await page.evaluate(() => {
    const form = document.querySelector('form[data-f="task"]');
    return {
      title: document.querySelector('#mdlT')?.textContent,
      project: form?.querySelector('select[name="proj"]')?.value,
      date: form?.querySelector('select[name="date"]')?.value,
      hasOtherDate: [...(form?.querySelector('select[name="date"]')?.options ?? [])].some((option) => option.value === 'other'),
    };
  });
  assert(taskDefaults.title === '新建 Todo', `unexpected Todo title: ${JSON.stringify(taskDefaults)}`);
  assert(taskDefaults.project === '' && taskDefaults.date === '',
    `global Todo should start unassigned and unscheduled: ${JSON.stringify(taskDefaults)}`);
  assert(taskDefaults.hasOtherDate, 'global Todo is missing the arbitrary-date option');

  // Canceling the native custom-date editor must preserve the last committed
  // value, including the intentionally empty global-Todo date.
  const taskDateAfterCancel = await page.evaluate(() => {
    const form = document.querySelector('form[data-f="task"]');
    const select = form?.querySelector('select[name="date"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('task date select missing');

    select.value = 'other';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const input = form?.querySelector('input[type="date"][aria-label="选择日期"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('native task date input missing');
    input.value = '';
    input.dispatchEvent(new Event('blur'));

    return {
      value: select.value,
      visible: !select.hidden,
      nativeInputRemoved: !input.isConnected,
    };
  });
  assert(
    taskDateAfterCancel.value === ''
      && taskDateAfterCancel.visible
      && taskDateAfterCancel.nativeInputRemoved,
    `canceling custom task date changed the committed value: ${JSON.stringify(taskDateAfterCancel)}`,
  );

  await page.locator('form[data-f="task"] input[name="title"]').fill('捕捉一件稍后安排的事');
  await page.locator('form[data-f="task"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  const capturedTask = await page.evaluate(() =>
    window.yuzhi.store.data.tasks.find((task) => task.title === '捕捉一件稍后安排的事'));
  assert(capturedTask && !capturedTask.projectId && !capturedTask.scheduledFor,
    `global Todo acquired hidden defaults: ${JSON.stringify(capturedTask)}`);

  // Project creation continues directly into the project and its first task.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="project"]').click();
  await page.locator('form[data-f="project"] input[name="name"]').fill('创建体验验收');
  await page.locator('form[data-f="project"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  await page.waitForFunction(() => window.yuzhi.tracker.view?.kind === 'project', undefined, { timeout });
  await page.waitForFunction(() => document.activeElement?.getAttribute?.('name') === 'ptask', undefined, { timeout });

  const projectState = await page.evaluate(() => {
    const project = window.yuzhi.store.data.projects.find((item) => item.name === '创建体验验收');
    const date = document.querySelector('form[data-form="ptask"] select[name="pdate"]')?.value;
    return {
      projectId: project?.id,
      tracker: window.yuzhi.tracker.view,
      date,
      today: window.yuzhi.store.today(),
      activeName: document.activeElement?.getAttribute?.('name') ?? null,
    };
  });
  assert(projectState.projectId && projectState.tracker.id === projectState.projectId,
    `new project did not open itself: ${JSON.stringify(projectState)}`);
  assert(projectState.date === projectState.today && projectState.activeName === 'ptask',
    `project context did not inherit today/focus: ${JSON.stringify(projectState)}`);

  // Locale-driven tracker redraws must preserve runtime custom-date options,
  // the selected value, and the date picker's committed value used by cancel.
  const customDateAcrossLocale = await page.evaluate(() => {
    const form = document.querySelector('form[data-form="ptask"]');
    const select = form?.querySelector('select[name="pdate"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('project task date select missing');

    const today = window.yuzhi.store.today();
    const [year, month, day] = today.split('-').map(Number);
    const customDate = new Date(Date.UTC(year, month - 1, day + 37)).toISOString().slice(0, 10);

    select.value = 'other';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const firstPicker = form?.querySelector('input[type="date"][aria-label="选择日期"]');
    if (!(firstPicker instanceof HTMLInputElement)) throw new Error('custom date picker missing');
    firstPicker.value = customDate;
    firstPicker.dispatchEvent(new Event('change', { bubbles: true }));

    const languageButton = document.getElementById('langBtn');
    if (!(languageButton instanceof HTMLButtonElement)) throw new Error('language button missing');
    languageButton.click();

    const rebuilt = document.querySelector('form[data-form="ptask"] select[name="pdate"]');
    if (!(rebuilt instanceof HTMLSelectElement)) throw new Error('rebuilt project task date select missing');
    const restored = {
      customDate,
      value: rebuilt.value,
      committed: rebuilt.dataset.committedDate,
      hasOption: [...rebuilt.options].some((option) => option.value === customDate),
    };

    rebuilt.value = 'other';
    rebuilt.dispatchEvent(new Event('change', { bubbles: true }));
    const secondPicker = document.querySelector('form[data-form="ptask"] input[type="date"][aria-label="选择日期"]');
    if (!(secondPicker instanceof HTMLInputElement)) throw new Error('second custom date picker missing');
    secondPicker.value = '';
    secondPicker.dispatchEvent(new Event('blur'));

    const afterCancel = {
      value: rebuilt.value,
      committed: rebuilt.dataset.committedDate,
      visible: !rebuilt.hidden,
      nativeInputRemoved: !secondPicker.isConnected,
    };

    // Return to the rollout-default locale and reset the draft date so this
    // regression remains isolated from the existing "project Todo = today"
    // assertion below.
    languageButton.click();
    const resetSelect = document.querySelector('form[data-form="ptask"] select[name="pdate"]');
    if (!(resetSelect instanceof HTMLSelectElement)) throw new Error('reset project task date select missing');
    resetSelect.value = today;
    resetSelect.dispatchEvent(new Event('change', { bubbles: true }));

    return { restored, afterCancel };
  });
  assert(
    customDateAcrossLocale.restored.value === customDateAcrossLocale.restored.customDate
      && customDateAcrossLocale.restored.committed === customDateAcrossLocale.restored.customDate
      && customDateAcrossLocale.restored.hasOption,
    `locale redraw lost the custom project-task date: ${JSON.stringify(customDateAcrossLocale)}`,
  );
  assert(
    customDateAcrossLocale.afterCancel.value === customDateAcrossLocale.restored.customDate
      && customDateAcrossLocale.afterCancel.committed === customDateAcrossLocale.restored.customDate
      && customDateAcrossLocale.afterCancel.visible
      && customDateAcrossLocale.afterCancel.nativeInputRemoved,
    `canceling the picker after locale restore lost the custom date: ${JSON.stringify(customDateAcrossLocale)}`,
  );

  await page.locator('form[data-form="ptask"] input[name="ptask"]').fill('第一件具体的事');
  await page.locator('form[data-form="ptask"] button.primary').click();
  const contextualTask = await page.evaluate(() =>
    window.yuzhi.store.data.tasks.find((task) => task.title === '第一件具体的事'));
  assert(contextualTask?.projectId === projectState.projectId && contextualTask?.scheduledFor === projectState.today,
    `project Todo did not inherit project/today: ${JSON.stringify(contextualTask)}`);

  // Diary text survives an accidental dismissal and is recovered next time.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="diary"]').click();

  const diaryDateLabel = await page.evaluate(() => {
    const select = document.querySelector('form[data-f="diary"] select[name="date"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('diary date select missing');
    return [...select.labels].some((label) => label.textContent?.includes('记录日期'));
  });
  assert(diaryDateLabel, 'diary date select lost its accessible "记录日期" label');

  // The detached native picker must not bypass the diary's max=today rule.
  // Exercise the invalid path with synthetic events so headless Chromium does
  // not open its native picker UI.
  const diaryDateGuard = await page.evaluate(() => {
    const form = document.querySelector('form[data-f="diary"]');
    const select = form?.querySelector('select[name="date"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('diary date select missing');

    select.value = 'other';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const input = form?.querySelector('input[type="date"][aria-label="选择日期"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('native diary date input missing');

    const today = window.yuzhi.store.today();
    const [year, month, day] = today.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const future = next.toISOString().slice(0, 10);

    input.value = future;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const rejected = {
      future,
      rangeOverflow: input.validity.rangeOverflow,
      inputStillPresent: input.isConnected,
      selectHidden: select.hidden,
      selectValue: select.value,
      hasFutureOption: [...select.options].some((option) => option.value === future),
    };

    input.value = today;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      ...rejected,
      recoveredSelectValue: select.value,
      recoveredSelectVisible: !select.hidden,
      nativeInputRemoved: !input.isConnected,
    };
  });
  assert(
    diaryDateGuard.rangeOverflow
      && diaryDateGuard.inputStillPresent
      && diaryDateGuard.selectHidden
      && diaryDateGuard.selectValue === 'other'
      && !diaryDateGuard.hasFutureOption,
    `future diary date escaped native validation: ${JSON.stringify(diaryDateGuard)}`,
  );
  assert(
    diaryDateGuard.recoveredSelectValue
      && diaryDateGuard.recoveredSelectVisible
      && diaryDateGuard.nativeInputRemoved,
    `diary date picker did not recover after a valid correction: ${JSON.stringify(diaryDateGuard)}`,
  );

  await page.locator('form[data-f="diary"] textarea[name="text"]').fill('这是一段还没有提交、但不应该因为误关而丢失的日记。');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });

  await page.locator('#newBtn').click();
  await page.locator('[data-k="diary"]').click();
  const recovered = await page.locator('form[data-f="diary"] textarea[name="text"]').inputValue();
  assert(recovered.includes('不应该因为误关而丢失'), `diary draft was not recovered: ${JSON.stringify(recovered)}`);
  await page.locator('form[data-f="diary"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  const diarySaved = await page.evaluate(() =>
    window.yuzhi.store.data.diaries.some((entry) => entry.text.includes('不应该因为误关而丢失')));
  assert(diarySaved, 'recovered diary draft was not saved');

  // Schedule capture exposes arbitrary dates and saves through the local calendar path.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="schedule"]').click();
  const scheduleState = await page.evaluate(() => {
    const form = document.querySelector('form[data-f="schedule"]');
    const date = form?.querySelector('select[name="date"]');
    return {
      title: document.querySelector('#mdlT')?.textContent,
      date: date?.value,
      today: window.yuzhi.store.today(),
      hasOtherDate: [...(date?.options ?? [])].some((option) => option.value === 'other'),
    };
  });
  assert(scheduleState.title === '新建日程' && scheduleState.date === scheduleState.today && scheduleState.hasOtherDate,
    `schedule defaults are incomplete: ${JSON.stringify(scheduleState)}`);
  await page.locator('form[data-f="schedule"] input[name="title"]').fill('创建体验日程');
  await page.locator('form[data-f="schedule"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  const scheduleSaved = await page.evaluate(() =>
    window.yuzhi.store.data.events.some((event) => event.title === '创建体验日程'));
  assert(scheduleSaved, 'local schedule was not created');

  // Management views expose creation in the same context instead of sending
  // users back to the page header.
  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'diaries' }));
  assert(await page.locator('[data-act="new-diary"]').isVisible(), 'diary view has no contextual create action');
  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'schedules' }));
  assert(await page.locator('[data-act="new-schedule"]').isVisible(), 'schedule view has no contextual create action');

  await context.close();
} finally {
  await browser.close();
}

console.log('[capture] unified creation flow passed');
