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

  await page.locator('form[data-form="ptask"] input[name="ptask"]').fill('第一件具体的事');
  await page.locator('form[data-form="ptask"] button.primary').click();
  const contextualTask = await page.evaluate(() =>
    window.yuzhi.store.data.tasks.find((task) => task.title === '第一件具体的事'));
  assert(contextualTask?.projectId === projectState.projectId && contextualTask?.scheduledFor === projectState.today,
    `project Todo did not inherit project/today: ${JSON.stringify(contextualTask)}`);

  // Diary text survives an accidental dismissal and is recovered next time.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="diary"]').click();
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
