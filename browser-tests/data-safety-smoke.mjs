/**
 * Data-safety regression smoke.
 *
 * Yuzhi keeps the only copy of the island in this browser. This checks the
 * real page: persistent storage is requested once the island holds data, a
 * backup reminder appears after 14 days without export and clears on export
 * or "later", Apple WebKit users get the Home Screen hint, and settings report
 * the current state.
 */
import { chromium, devices } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const timeout = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const countPersistRequests = () => {
  window.__persistCalls = 0;
  const storage = navigator.storage;
  if (!storage?.persist) return;
  const original = storage.persist.bind(storage);
  storage.persist = () => {
    window.__persistCalls += 1;
    return original();
  };
};

async function openApp(page, onWelcome) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.yuzhi?.store), undefined, { timeout });
  await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout });
  if (await page.locator('#mdl').isVisible()) {
    await onWelcome?.();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
  }
}

/** Pretend the island was founded long ago, then reload so startup sees it. */
async function ageIsland(page, days) {
  await page.evaluate(async (days) => {
    const { store } = window.yuzhi;
    const [y, m, d] = store.today().split('-').map(Number);
    const firstDay = new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
    store.saveSettings({ firstDay });
    await store.flush();
  }, days);
  await openApp(page);
}

const notice = (page) => page.evaluate(() => ({
  visible: !document.getElementById('safetyNotice').hidden,
  text: document.getElementById('safetyTxt').textContent,
  go: document.getElementById('safetyGo').hidden ? null : document.getElementById('safetyGo').textContent,
  later: document.getElementById('safetyLater').textContent,
  state: JSON.parse(localStorage.getItem('yuzhi:data-safety') ?? '{}'),
}));

const browser = await chromium.launch({ channel: channel || undefined, headless: true });

try {
  // Desktop Chromium: no install hint, only persistence + backup reminder.
  {
    const context = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true });
    await context.addInitScript(countPersistRequests);
    const page = await context.newPage();
    // An installed Home Screen / Dock app starts empty; restoring a backup is
    // offered right on the welcome screen.
    let welcomeRestore = false;
    await openApp(page, async () => {
      welcomeRestore = await page.locator('#mdl [data-w="restore"]').isVisible();
    });
    assert(welcomeRestore, 'welcome screen does not offer restoring from a backup');

    const empty = await notice(page);
    assert(!empty.visible, `an empty island must not nag: ${JSON.stringify(empty)}`);
    assert(await page.evaluate(() => window.__persistCalls) === 0, 'persistent storage requested before there was anything to keep');

    await page.evaluate(() => window.yuzhi.actions.createProject(window.yuzhi.store, '数据安全验收'));
    await page.waitForFunction(() => window.__persistCalls === 1, undefined, { timeout });
    const fresh = await notice(page);
    assert(!fresh.visible, `a brand-new island is not due for a backup reminder: ${JSON.stringify(fresh)}`);

    await ageIsland(page, 20);
    const due = await notice(page);
    assert(due.visible && due.text.includes('还没有导出过备份') && due.go === '现在导出' && due.later === '稍后',
      `backup reminder missing after 20 days: ${JSON.stringify(due)}`);

    // Export from the notice goes through the normal privacy confirmation.
    await page.locator('#safetyGo').click();
    await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      page.locator('#mdl [data-ok]').click(),
    ]);
    assert(/^yuzhi-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `unexpected backup name ${download.suggestedFilename()}`);
    const exported = await notice(page);
    const today = await page.evaluate(() => window.yuzhi.store.today());
    assert(!exported.visible && exported.state.lastBackup === today, `export did not clear the reminder: ${JSON.stringify(exported)}`);

    // Settings explain this browser's state and offer an export.
    await page.locator('#moreBtn').click();
    await page.locator('#menu [data-m="settings"]').click();
    await page.waitForFunction(() => {
      const line = document.querySelector('#mdl [data-safety-storage]');
      return line && !line.textContent.includes('正在确认');
    }, undefined, { timeout });
    const settings = await page.evaluate(() => ({
      text: document.getElementById('mdl').textContent,
      exportVisible: !document.querySelector('#mdl [data-safety-export]').hidden,
    }));
    assert(settings.text.includes('数据安全') && settings.text.includes('本地存储') && settings.text.includes('上次在这个浏览器导出备份：今天'),
      `settings lack the data-safety section: ${settings.text}`);
    assert(settings.exportVisible, 'settings export button missing');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });

    // "Later" stays quiet across reloads.
    await page.evaluate(() => localStorage.removeItem('yuzhi:data-safety'));
    await openApp(page);
    assert((await notice(page)).visible, 'reminder did not return after the export record was cleared');
    await page.locator('#safetyLater').click();
    const snoozed = await notice(page);
    assert(!snoozed.visible && snoozed.state.snoozedUntil > today, `later did not snooze: ${JSON.stringify(snoozed)}`);
    await openApp(page);
    assert(!(await notice(page)).visible, 'snoozed reminder came back after reload');

    await context.close();
  }

  // iPhone: the Home Screen hint shows even right after a backup, and "got it" quiets it.
  {
    const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
    const page = await context.newPage();
    await openApp(page);
    await page.evaluate(() => window.yuzhi.actions.createProject(window.yuzhi.store, '手机上的岛'));
    await page.waitForFunction(() => !document.getElementById('safetyNotice').hidden, undefined, { timeout });
    const hint = await notice(page);
    // The installed app keeps its own storage, so the hint must explain the
    // export-then-import move and keep the export one tap away.
    assert(hint.text.includes('添加到主屏幕') && hint.text.includes('导入备份') && hint.go === '现在导出' && hint.later === '知道了',
      `iPhone install hint missing: ${JSON.stringify(hint)}`);
    await page.locator('#safetyLater').click();
    const quiet = await notice(page);
    assert(!quiet.visible && quiet.state.installHintUntil, `got it did not quiet the hint: ${JSON.stringify(quiet)}`);
    await context.close();
  }

  console.log('[data-safety] persistence, backup reminder and install hint passed');
} finally {
  await browser.close();
}
