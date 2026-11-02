/**
 * Real-browser regression for evening review's long-list keyboard and scroll
 * state. Re-rendering a verdict must preserve the exact row/action focus and
 * scrollTop, while selecting another day starts at the top of its list.
 */
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const timeout = 20_000;
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};

const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'UTC',
    viewport: { width: 1100, height: 620 },
  });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.yuzhi?.store && document.body.dataset.readOnly === 'false',
    undefined,
    { timeout },
  );
  if (await page.locator('#mdl').isVisible()) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  }

  // One long today task list and a different long pending day. Seed a fresh
  // browser profile without changing any production code or the app's clock.
  const { today, prior } = await page.evaluate(async () => {
    const { store, actions: A } = window.yuzhi;
    const today = store.today();
    const [year, month, day] = today.split('-').map(Number);
    const prior = new Date(Date.UTC(year, month - 1, day - 1, 12)).toISOString().slice(0, 10);
    store.batch(() => {
      store.saveSettings({ firstDay: prior });
      const project = A.createProject(store, '结算焦点回归测试');
      for (let i = 0; i < 55; i++) {
        A.createTask(store, {
          title: `今天的长列表任务 ${String(i).padStart(2, '0')}`,
          projectId: project.id,
          scheduledFor: today,
        });
      }
      store.put('sources', { id: 'settle-scroll-smoke', name: '结算测试日历' });
      for (let i = 0; i < 25; i++) {
        store.put('events', {
          id: `settle-smoke-event-${i}`,
          uid: `settle-smoke-event-${i}`,
          sourceId: 'settle-scroll-smoke',
          title: `昨天的日程 ${String(i).padStart(2, '0')}`,
          start: `${prior}T12:${String(i).padStart(2, '0')}:00.000Z`,
          end: `${prior}T13:${String(i).padStart(2, '0')}:00.000Z`,
          allDay: false,
          classified: true,
          projectId: project.id,
        });
      }
    });
    await store.flush();
    return { today, prior };
  });

  await page.locator('#settleBtn').click();
  await page.waitForFunction(() => !document.getElementById('settle').hidden, undefined, { timeout });
  const dayTabs = page.locator('#settle [data-day]');
  const dates = await dayTabs.evaluateAll((nodes) => nodes.map((node) => node.dataset.day));
  assert(dates.includes(today) && dates.includes(prior), `missing two settlement days: ${JSON.stringify({ today, prior, dates })}`);
  await page.locator(`#settle [data-day="${today}"]`).click();

  const list = page.locator('#settle .slist');
  const rows = page.locator('#settle .slist .sitem');
  assert(await rows.count() >= 55, 'today did not render a long task list');
  const chosen = rows.nth(30);
  const key = await chosen.getAttribute('data-key');
  assert(key?.startsWith('task|'), `expected a task row, got: ${key}`);
  // Locate the row using its stable data-key, so assertions target the
  // replacement DOM element rather than a detached pre-render button.
  const row = page.locator(`#settle .sitem[data-key="${key}"]`);
  const action = row.locator('[data-set="partial"]');
  await action.scrollIntoViewIfNeeded();
  await action.focus();
  const before = await list.evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
  assert(before.max > 400 && before.top > 0, `list was not scrolled: ${JSON.stringify(before)}`);

  await action.press('Enter');
  await page.waitForFunction((key) => {
    const row = [...document.querySelectorAll('#settle .sitem')].find((el) => el.dataset.key === key);
    return Boolean(row?.classList.contains('o-partial'));
  }, key, { timeout });
  const afterPartial = await page.evaluate((key) => {
    const focused = document.activeElement;
    const row = [...document.querySelectorAll('#settle .sitem')].find((el) => el.dataset.key === key);
    return {
      top: document.querySelector('#settle .slist').scrollTop,
      focusKey: focused?.closest('.sitem')?.dataset.key,
      focusAction: focused?.getAttribute('data-set'),
      replacementIsFocused: focused === row?.querySelector('[data-set="partial"]'),
    };
  }, key);
  assert(Math.abs(afterPartial.top - before.top) <= 2, `scroll jumped after partial verdict: ${JSON.stringify({ before, afterPartial })}`);
  assert(afterPartial.focusKey === key && afterPartial.focusAction === 'partial' && afterPartial.replacementIsFocused,
    `focused verdict control was not restored after partial verdict: ${JSON.stringify(afterPartial)}`);

  // A second verdict changes the row markup again. Keyboard focus must follow
  // the selected action even when its old DOM element has been replaced.
  const skipped = row.locator('[data-set="skipped"]');
  await skipped.focus();
  const scrollBeforeSkipped = await list.evaluate((el) => el.scrollTop);
  await skipped.press('Enter');
  await page.waitForFunction((key) => {
    const row = [...document.querySelectorAll('#settle .sitem')].find((el) => el.dataset.key === key);
    return Boolean(row?.classList.contains('o-skipped'));
  }, key, { timeout });
  const afterSkipped = await page.evaluate((key) => {
    const focused = document.activeElement;
    const row = [...document.querySelectorAll('#settle .sitem')].find((el) => el.dataset.key === key);
    return {
      top: document.querySelector('#settle .slist').scrollTop,
      replacementIsFocused: focused === row?.querySelector('[data-set="skipped"]'),
    };
  }, key);
  assert(afterSkipped.replacementIsFocused, 'focused verdict control was lost after skipped verdict');
  assert(Math.abs(afterSkipped.top - scrollBeforeSkipped) <= 2,
    `scroll jumped after skipped verdict: ${JSON.stringify({ scrollBeforeSkipped, afterSkipped })}`);

  // The old date has a different list; it must not inherit today's position.
  await page.locator(`#settle [data-day="${prior}"]`).click();
  const priorState = await list.evaluate((el) => ({
    top: el.scrollTop,
    rows: el.querySelectorAll('.sitem').length,
    max: el.scrollHeight - el.clientHeight,
  }));
  assert(priorState.rows >= 25 && priorState.top === 0,
    `switching to previous day retained the wrong scroll: ${JSON.stringify(priorState)}`);

  // Switch back while the previous day's list is scrolled: still reset.
  await list.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight); });
  assert(await list.evaluate((el) => el.scrollTop) > 0, 'previous day was not scrollable');
  await page.locator(`#settle [data-day="${today}"]`).click();
  const back = await list.evaluate((el) => ({
    top: el.scrollTop,
    rows: el.querySelectorAll('.sitem').length,
  }));
  assert(back.rows >= 55 && back.top === 0,
    `switching back to today failed to reset scroll: ${JSON.stringify(back)}`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('settle').hidden, undefined, { timeout });
  await context.close();
} finally {
  await browser.close();
}
console.log('[settle-scroll] verdict focus, scroll preservation and day resets passed');
