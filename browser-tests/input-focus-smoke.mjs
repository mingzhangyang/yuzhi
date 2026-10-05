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

  // A fresh profile intentionally opens the first-run welcome dialog. Dismiss
  // that real startup state before exercising the separate "New" flow; forcing
  // the click through the overlay would hide an invalid test precondition.
  if (await page.locator('#mdl').isVisible()) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  }

  // The collapsed tracker already contains a quick-add input/select.
  const baseControls = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), textarea, select')]
      .map((el) => ({ tag: el.tagName, name: el.getAttribute('name'), size: parseFloat(getComputedStyle(el).fontSize) })),
  );
  assert(baseControls.length > 0, 'no form controls found on the mobile page');
  assert(baseControls.every((control) => control.size >= 16),
    `mobile controls below 16px before focus: ${JSON.stringify(baseControls.filter((control) => control.size < 16))}`);

  // Guard the selector boundary too: native-only controls must not be pulled
  // into the 16px text-entry rule by component-specific selectors.
  const excludedNativeControls = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'add field';
    const types = ['checkbox', 'radio', 'range', 'file'];
    for (const type of types) {
      const input = document.createElement('input');
      input.type = type;
      input.dataset.testType = type;
      host.append(input);
    }
    document.body.append(host);
    const sizes = [...host.querySelectorAll('input')].map((el) => ({
      type: el.dataset.testType,
      size: parseFloat(getComputedStyle(el).fontSize),
    }));
    host.remove();
    return sizes;
  });
  assert(excludedNativeControls.every((control) => control.size < 16),
    `native controls were pulled into the 16px text-entry rule: ${JSON.stringify(excludedNativeControls)}`);

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
  // Instrument the actual canvas IDL setters first: assigning the same numeric
  // width/height still clears its backing store, so value equality alone cannot
  // detect the regression this smoke is meant to prevent.
  await page.evaluate(() => {
    const canvas = document.getElementById('map');
    const proto = HTMLCanvasElement.prototype;
    const width = Object.getOwnPropertyDescriptor(proto, 'width');
    const height = Object.getOwnPropertyDescriptor(proto, 'height');
    if (!width?.get || !width.set || !height?.get || !height.set) {
      throw new Error('canvas width/height accessors unavailable');
    }
    const writes = { width: 0, height: 0 };
    Object.defineProperties(canvas, {
      width: {
        configurable: true,
        get() { return width.get.call(this); },
        set(value) {
          writes.width += 1;
          width.set.call(this, value);
        },
      },
      height: {
        configurable: true,
        get() { return height.get.call(this); },
        set(value) {
          writes.height += 1;
          height.set.call(this, value);
        },
      },
    });
    window.__yuzhiCanvasResizeWrites = writes;
  });

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
      resizeWrites: { ...window.__yuzhiCanvasResizeWrites },
    };
  });

  assert(duringKeyboard.resizeWrites.width === 0 && duringKeyboard.resizeWrites.height === 0,
    `canvas backing-store setters ran on keyboard-like resize: ${JSON.stringify(duringKeyboard.resizeWrites)}`);
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
