/**
 * Mobile input-focus stability regression.
 *
 * Checks the two invariants that keep iOS Safari-style text entry from making
 * the UI jump:
 * 1. touch form controls render at >= 16px before focus, avoiding focus zoom;
 * 2. height-only viewport changes (a software-keyboard analogue) do not
 *    reallocate the island canvas when its own CSS geometry is unchanged.
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
  await page.waitForFunction(() => Boolean(window.yuzhi?.renderer && window.yuzhi?.store), undefined, { timeout });
  await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout });

  // The collapsed tracker already contains a quick-add input/select.
  const baseControls = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), textarea, select')]
      .map((el) => ({ tag: el.tagName, name: el.getAttribute('name'), size: parseFloat(getComputedStyle(el).fontSize) })),
  );
  assert(baseControls.length > 0, 'no form controls found on the mobile page');
  assert(baseControls.every((control) => control.size >= 16),
    `mobile controls below 16px before focus: ${JSON.stringify(baseControls.filter((control) => control.size < 16))}`);

  const before = await page.evaluate(() => {
    const canvas = document.getElementById('map');
    const r = window.yuzhi.renderer;
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      viewWidth: r.view.w,
      viewHeight: r.view.h,
      rect: document.getElementById('mapwrap').getBoundingClientRect().toJSON(),
    };
  });

  // Open the creation modal through a real user gesture. Its autofocus path is
  // exactly where Safari would otherwise zoom a 12-14px text field.
  await page.locator('#newBtn').click();
  await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
  const focusState = await page.evaluate(() => {
    const active = document.activeElement;
    const controls = [...document.querySelectorAll('#mdlBox input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), #mdlBox textarea, #mdlBox select')]
      .map((el) => ({ tag: el.tagName, name: el.getAttribute('name'), size: parseFloat(getComputedStyle(el).fontSize) }));
    return {
      activeTag: active?.tagName,
      activeName: active?.getAttribute?.('name') ?? null,
      activeSize: active ? parseFloat(getComputedStyle(active).fontSize) : 0,
      controls,
    };
  });
  assert(focusState.activeTag === 'INPUT' && focusState.activeName === 'title',
    `new-task autofocus did not land on title: ${JSON.stringify(focusState)}`);
  assert(focusState.activeSize >= 16, `autofocused input is only ${focusState.activeSize}px`);
  assert(focusState.controls.every((control) => control.size >= 16),
    `modal controls below 16px: ${JSON.stringify(focusState.controls.filter((control) => control.size < 16))}`);

  // Switch to the diary form to exercise the explicit textarea focus path too.
  await page.locator('[data-k="diary"]').click();
  const diaryFocus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    name: document.activeElement?.getAttribute?.('name') ?? null,
    size: document.activeElement ? parseFloat(getComputedStyle(document.activeElement).fontSize) : 0,
  }));
  assert(diaryFocus.tag === 'TEXTAREA' && diaryFocus.name === 'text' && diaryFocus.size >= 16,
    `diary autofocus is not stable: ${JSON.stringify(diaryFocus)}`);

  // Approximate the software keyboard by shrinking only the viewport height.
  // The map is width/aspect-ratio driven, so its own geometry should not change
  // and the backing store must not be reassigned.
  await page.setViewportSize({ width: 390, height: 520 });
  await page.waitForTimeout(250);
  const duringKeyboard = await page.evaluate(() => {
    const canvas = document.getElementById('map');
    const r = window.yuzhi.renderer;
    const rect = document.getElementById('mapwrap').getBoundingClientRect();
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      viewWidth: r.view.w,
      viewHeight: r.view.h,
      rect: { width: rect.width, height: rect.height },
      activeName: document.activeElement?.getAttribute?.('name') ?? null,
    };
  });

  assert(Math.abs(duringKeyboard.rect.width - before.rect.width) < 0.01
    && Math.abs(duringKeyboard.rect.height - before.rect.height) < 0.01,
    `map CSS geometry changed on height-only viewport resize: ${JSON.stringify({ before: before.rect, after: duringKeyboard.rect })}`);
  assert(duringKeyboard.canvasWidth === before.canvasWidth && duringKeyboard.canvasHeight === before.canvasHeight,
    `canvas backing store changed on keyboard-like resize: ${JSON.stringify({ before, duringKeyboard })}`);
  assert(Math.abs(duringKeyboard.viewWidth - before.viewWidth) < 0.01
    && Math.abs(duringKeyboard.viewHeight - before.viewHeight) < 0.01,
    `renderer view geometry changed on keyboard-like resize: ${JSON.stringify({ before, duringKeyboard })}`);
  assert(duringKeyboard.activeName === 'text',
    `keyboard-like resize unexpectedly moved focus: ${JSON.stringify(duringKeyboard)}`);

  await context.close();
} finally {
  await browser.close();
}

console.log('[input-focus] mobile focus stability passed');
