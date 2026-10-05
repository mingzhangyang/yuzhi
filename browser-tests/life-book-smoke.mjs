/**
 * Life Book UI regression smoke.
 *
 * Verifies diary/schedule detail history, revision creation, and deleted-history
 * retention through real browser interactions.
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

  // Diary: create -> detail -> edit revision -> delete -> historical detail remains.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="diary"]').click();
  await page.locator('form[data-f="diary"] textarea[name="text"]').fill('一生之书 smoke 初版');
  await page.locator('form[data-f="diary"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });

  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'diaries' }));
  await page.locator('[data-act="diary"]').first().click();
  assert(await page.locator('.revision').count() === 1, 'new diary should have one revision');

  await page.locator('[data-act="edit-diary"]').click();
  await page.locator('form[data-f="edit-diary"] textarea[name="text"]').fill('一生之书 smoke 第二版');
  await page.locator('form[data-f="edit-diary"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  await page.waitForFunction(() => document.querySelectorAll('.revision').length === 2, undefined, { timeout });

  await page.locator('[data-act="delete-diary"]').click();
  await page.locator('#mdl [data-ok]').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  await page.waitForFunction(() => document.querySelector('#trackerBody')?.textContent?.includes('已删除'), undefined, { timeout });
  assert((await page.locator('#trackerBody').textContent()).includes('第二版'), 'deleted diary lost its latest snapshot');

  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'diaries' }));
  assert((await page.locator('#trackerBody').textContent()).includes('已删除的日记'), 'deleted diary archive is missing');
  const archivedDiaryLink = page.locator('.history-record button[data-act="diary"]').first();
  assert(await archivedDiaryLink.isVisible(), 'deleted diary history is not exposed as a keyboard-focusable control');
  await archivedDiaryLink.focus();
  assert(await archivedDiaryLink.evaluate((el) => document.activeElement === el), 'deleted diary history cannot receive keyboard focus');

  // Schedule: create -> detail -> edit revision -> delete -> historical detail remains.
  await page.locator('#newBtn').click();
  await page.locator('[data-k="schedule"]').click();
  await page.locator('form[data-f="schedule"] input[name="title"]').fill('一生之书 smoke 日程');
  await page.locator('form[data-f="schedule"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });

  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'schedules' }));
  await page.locator('[data-act="schedule"]').first().click();
  assert(await page.locator('.revision').count() === 1, 'new schedule should have one revision');

  await page.locator('[data-act="edit-schedule"]').click();
  await page.locator('form[data-f="edit-schedule"] input[name="title"]').fill('一生之书 smoke 日程第二版');
  await page.locator('form[data-f="edit-schedule"] button.primary').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  await page.waitForFunction(() => document.querySelectorAll('.revision').length === 2, undefined, { timeout });

  await page.locator('[data-act="delete-schedule"]').click();
  await page.locator('#mdl [data-ok]').click();
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  await page.waitForFunction(() => document.querySelector('#trackerBody')?.textContent?.includes('已删除'), undefined, { timeout });
  assert((await page.locator('#trackerBody').textContent()).includes('日程第二版'), 'deleted schedule lost its latest snapshot');

  await page.evaluate(() => window.yuzhi.tracker.open({ kind: 'schedules' }));
  assert((await page.locator('#trackerBody').textContent()).includes('已删除的日程'), 'deleted schedule archive is missing');
  const archivedScheduleLink = page.locator('.history-record button[data-act="schedule"]').first();
  assert(await archivedScheduleLink.isVisible(), 'deleted schedule history is not exposed as a keyboard-focusable control');
  await archivedScheduleLink.focus();
  assert(await archivedScheduleLink.evaluate((el) => document.activeElement === el), 'deleted schedule history cannot receive keyboard focus');

  await context.close();
} finally {
  await browser.close();
}

console.log('[life-book] unified history UI passed');
