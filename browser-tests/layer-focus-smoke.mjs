/**
 * Real-browser regression for modal focus containment and feedback stacking.
 * The shared layer stack must keep Tab/Shift+Tab inside each active dialog,
 * including dialogs temporarily lacking enabled controls, while preserving
 * the Toast (z=80) and flying-brick (z=90) feedback channels above overlays.
 */
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const timeout = 20_000;

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.yuzhi?.store, undefined, { timeout });
  await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout });

  // Dismiss first-run welcome using the actual modal Escape path.
  if (await page.locator('#mdl').isVisible()) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  }

  const assertFeedbackAbove = async (selector) => {
    const z = await page.evaluate((selector) => ({
      overlay: Number(getComputedStyle(document.querySelector(selector)).zIndex),
      toast: Number(getComputedStyle(document.querySelector('#toast')).zIndex),
    }), selector);
    assert(z.overlay < z.toast && z.toast < 90,
      `feedback layers must be above ${selector}, got ${JSON.stringify(z)}`);
  };
  const focusable = (root) => page.locator(
    `${root} :is(button,input,select,textarea,a[href]):visible:not([disabled]):not([tabindex="-1"])`,
  );
  const activeIs = (locator) => locator.evaluate((element) => element === document.activeElement);

  // Ordinary creation dialog: wrap at both keyboard boundaries and from its
  // initially focused tabindex=-1 container.
  await page.locator('#newBtn').click();
  await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
  await assertFeedbackAbove('#mdl');
  const modalControls = focusable('#mdlBox');
  assert(await modalControls.count() >= 2, 'creation dialog has too few controls');
  await modalControls.last().focus();
  await page.keyboard.press('Tab');
  assert(await activeIs(modalControls.first()), 'Tab escaped past last creation-dialog control');
  await modalControls.first().focus();
  await page.keyboard.press('Shift+Tab');
  assert(await activeIs(modalControls.last()), 'Shift+Tab escaped before first creation-dialog control');

  await page.locator('#mdlBox').focus();
  await page.keyboard.press('Tab');
  assert(await activeIs(modalControls.first()), 'Tab from dialog container did not enter first control');

  // No enabled control: focus must stay on the labelled role=dialog container
  // rather than advance into the browser chrome.
  await page.evaluate(() => {
    const box = document.getElementById('mdlBox');
    for (const el of box.querySelectorAll('button,input,select,textarea')) el.disabled = true;
    for (const el of box.querySelectorAll('a[href],[tabindex="0"]')) el.tabIndex = -1;
  });
  await page.locator('#mdlBox').focus();
  await page.keyboard.press('Tab');
  assert(await activeIs(page.locator('#mdlBox')), 'empty dialog did not retain keyboard focus');
  await page.keyboard.press('Shift+Tab');
  assert(await activeIs(page.locator('#mdlBox')), 'empty dialog lost focus on Shift+Tab');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  assert(await activeIs(page.locator('#newBtn')), 'creation dialog did not restore focus to its trigger');

  // Evening review has a different top-level overlay; it shares the same trap.
  await page.locator('#settleBtn').click();
  await page.waitForFunction(() => !document.getElementById('settle').hidden, undefined, { timeout });
  await assertFeedbackAbove('#settle');
  const settleControls = focusable('#settleBox');
  assert(await settleControls.count() >= 2, 'evening review has too few controls');
  await settleControls.last().focus();
  await page.keyboard.press('Tab');
  assert(await activeIs(settleControls.first()), 'Tab escaped evening-review dialog');
  await settleControls.first().focus();
  await page.keyboard.press('Shift+Tab');
  assert(await activeIs(settleControls.last()), 'Shift+Tab escaped evening-review dialog');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('settle').hidden, undefined, { timeout });
  assert(await activeIs(page.locator('#settleBtn')), 'evening review did not restore trigger focus');
  await context.close();
} finally {
  await browser.close();
}
console.log('[layer-focus] dialog Tab trap and toast/flying-brick stacking passed');
