/**
 * Local-only interaction regression for YZ-F13/YZ-F14.
 * Start the built preview and run with Playwright installed locally:
 *   npm run build && npm run preview
 *   PW_CHANNEL=chrome node browser-tests/date-import-smoke.mjs
 * Native iPhone Safari still requires a manual device check.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true });
try {
  const page = await browser.newPage({ locale: 'zh-CN' });
  // The smoke controls native date popup timing explicitly, while the same
  // application code continues to call showPicker in production.
  await page.addInitScript(() => { HTMLInputElement.prototype.showPicker = () => {}; });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.yuzhi?.store && !window.yuzhi.store.isReadOnly);
  // First-run restore must open the chooser without removing the welcome modal.
  const welcomeRestore = page.locator('#mdl input[data-welcome-restore]');
  assert.equal(await welcomeRestore.count(), 1, 'welcome restore does not offer a direct file control');
  const welcomeChooserPromise = page.waitForEvent('filechooser');
  await welcomeRestore.click();
  const welcomeChooser = await welcomeChooserPromise;
  assert.equal(await page.locator('#mdl').isVisible(), true, 'welcome closed before file selection');
  await welcomeChooser.setFiles({ name: 'invalid-welcome.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"invalid"}') });
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('不是屿志的备份文件'));
  assert.equal(await page.locator('#mdl').isVisible(), false, 'welcome did not close after file selection');

  await page.locator('#newBtn').click();
  await page.locator('#mdl [data-k="diary"]').click();
  const today = await page.evaluate(() => window.yuzhi.store.today());
  const pastDate = new Date(Date.parse(today + 'T12:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
  const diary = page.locator('#mdl form[data-f="diary"]');
  const diaryDate = diary.locator('select[data-date-select]');
  await diaryDate.selectOption('other');
  const dateInput = diary.locator('.date-picker-editor input[type="date"]');
  await dateInput.fill(pastDate);
  await dateInput.dispatchEvent('blur');
  assert.equal(await dateInput.count(), 1, 'blur removed the date input before confirming');
  await diary.locator('.date-picker-apply').click();
  assert.equal(await diaryDate.inputValue(), pastDate, 'calendar date was silently reverted to today');
  await diary.locator('textarea[name="text"]').fill('YZ-F13 date regression');
  await diary.locator('button.primary').click();
  await page.waitForFunction((d) => window.yuzhi.store.data.diaries.some((x) =>
    x.date === d && x.text === 'YZ-F13 date regression'), pastDate);
  await page.reload();
  await page.waitForFunction((d) => window.yuzhi?.store?.data?.diaries.some((x) =>
    x.date === d && x.text === 'YZ-F13 date regression'), pastDate);

  await page.locator('#newBtn').click();
  await page.locator('#mdl [data-k="task"]').click();
  const task = page.locator('#mdl form[data-f="task"]');
  await task.locator('select[data-date-select]').selectOption('other');
  assert.equal(await task.locator('.date-picker-editor').count(), 1, 'duplicate picker handlers');
  await task.locator('.date-picker-editor button:not(.date-picker-apply)').click();
  assert.equal(await task.locator('select[data-date-select]').inputValue(), '', 'cancel did not restore undated task');
  await page.locator('#mdl [data-close]').first().click();

  // Switching locale while "Other date" is pending must not erase a task's
  // previously committed scheduled date when the Tracker form is saved.
  const taskId = await page.evaluate((scheduledFor) => {
    const { store, actions, tracker } = window.yuzhi;
    const created = actions.createTask(store, { title: 'YZ-F13 locale redraw', scheduledFor });
    tracker.open({ kind: 'task', id: created.id });
    return created.id;
  }, pastDate);
  const planForm = page.locator('#trackerBody form[data-form="tedit"]');
  await planForm.locator('select[name="tdate"]').selectOption('other');
  await page.locator('#trackerBody .date-picker-editor input[type="date"]').fill(today);
  await page.locator('#langBtn').click();
  assert.equal(await planForm.locator('select[name="tdate"]').inputValue(), pastDate,
    'locale switch discarded the previously committed task date');
  await planForm.locator('button').click();
  await page.waitForFunction(({ id, date }) => window.yuzhi.store.task(id)?.scheduledFor === date,
    { id: taskId, date: pastDate });

  await page.locator('#moreBtn').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#fileBackupMenu').click();
  const chooser = await chooserPromise;
  assert.equal(await page.locator('#menu').isVisible(), true, 'menu closed before native file chooser');
  await chooser.setFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"invalid"}') });
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('不是屿志的备份文件'));
  assert.equal(await page.locator('#menu').isVisible(), false, 'menu stayed open after a file was chosen');
  await page.locator('#moreBtn').click();
  const againPromise = page.waitForEvent('filechooser');
  await page.locator('#fileBackupMenu').click();
  await (await againPromise).setFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"invalid"}') });
  console.log('YZ-F13/YZ-F14 browser smoke passed');
} finally {
  await browser.close();
}
