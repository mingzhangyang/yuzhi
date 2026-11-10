/**
 * Data-safety regression smoke.
 *
 * Yuzhi keeps the only copy of the island in this browser. This checks the
 * real page: persistent storage is requested once the island holds data,
 * never-exported keepsake data prompts a first backup immediately, and later
 * reminders recur 14 days after an export. "Later" snoozes the reminder;
 * Apple WebKit users get the Home Screen hint, and settings report the state.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // Headless Chrome cannot interact with the native picker, so emulate the
    // file handle while keeping the app's real export and reminder behavior.
    await context.addInitScript(() => {
      window.__backupPicker = { mode: 'success', attempts: [], finishClose: null };
      window.showSaveFilePicker = async function ({ suggestedName }) {
        if (this !== window) throw new Error('file picker called without Window receiver');
        const mode = window.__backupPicker.mode;
        if (mode === 'cancel') throw new DOMException('Picker cancelled', 'AbortError');
        const entry = { name: suggestedName, text: '', closeStarted: false, closed: false, aborted: false };
        window.__backupPicker.attempts.push(entry);
        return {
          createWritable: async () => ({
            write: async (text) => { entry.text = String(text); },
            close: async () => {
              entry.closeStarted = true;
              if (mode === 'close-error') throw new Error('Injected close failure');
              if (mode === 'pending') {
                await new Promise((resolve) => { window.__backupPicker.finishClose = resolve; });
              }
              entry.closed = true;
            },
            abort: async () => { entry.aborted = true; },
          }),
        };
      };
    });
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
    await page.waitForFunction(() => !document.getElementById('safetyNotice').hidden, undefined, { timeout });
    const fresh = await notice(page);
    assert(fresh.visible && fresh.text.includes('还没有导出过备份') && fresh.go === '现在导出',
      `never-exported keepsake data should prompt a first backup immediately: ${JSON.stringify(fresh)}`);

    await ageIsland(page, 20);
    const due = await notice(page);
    assert(due.visible && due.text.includes('还没有导出过备份') && due.go === '现在导出' && due.later === '稍后',
      `backup reminder missing after 20 days: ${JSON.stringify(due)}`);

    // The real privacy prompt precedes the picker; only a closed writable
    // stream may update lastBackup. Cancelling or failing must keep reminders.
    const exportFromNotice = async () => {
      await page.locator('#safetyGo').click();
      await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
      await page.locator('#mdl [data-ok]').click();
    };

    await page.evaluate(() => { window.__backupPicker.mode = 'cancel'; });
    await exportFromNotice();
    const cancelledPicker = await notice(page);
    assert(cancelledPicker.visible && !cancelledPicker.state.lastBackup,
      'cancelling the picker counted as a backup: ' + JSON.stringify(cancelledPicker));

    await page.evaluate(() => { window.__backupPicker.mode = 'close-error'; });
    await exportFromNotice();
    await page.waitForFunction(() => window.__backupPicker.attempts.some((entry) => entry.aborted), undefined, { timeout });
    const failedPicker = await notice(page);
    assert(failedPicker.visible && !failedPicker.state.lastBackup,
      'a failed file close counted as a backup: ' + JSON.stringify(failedPicker));

    await page.evaluate(() => { window.__backupPicker.mode = 'pending'; });
    await exportFromNotice();
    await page.waitForFunction(() => window.__backupPicker.attempts.at(-1)?.closeStarted, undefined, { timeout });
    const beforeClose = await notice(page);
    assert(beforeClose.visible && !beforeClose.state.lastBackup,
      'a still-open file stream cleared the backup reminder: ' + JSON.stringify(beforeClose));
    await page.evaluate(() => {
      if (!window.__backupPicker.finishClose) throw new Error('picker close was never awaited');
      window.__backupPicker.finishClose();
    });
    await page.waitForFunction(() =>
      JSON.parse(localStorage.getItem('yuzhi:data-safety') ?? '{}').lastBackup === window.yuzhi.store.today(),
    undefined, { timeout });
    const saved = await page.evaluate(() => window.__backupPicker.attempts.at(-1));
    const savedBackup = JSON.parse(saved.text);
    assert(/^yuzhi-backup-\d{4}-\d{2}-\d{2}\.json$/.test(saved.name)
      && saved.closed && !saved.aborted && savedBackup.format === 'yuzhi-backup' && savedBackup.projects.length === 1,
    'the picker did not close a valid backup: ' + JSON.stringify(saved));
    const exported = await notice(page);
    const today = await page.evaluate(() => window.yuzhi.store.today());
    assert(!exported.visible && exported.state.lastBackup === today,
      'the completed save did not clear the reminder: ' + JSON.stringify(exported));

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
    // Without a native picker, a browser download is an unverified handoff.
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    await page.locator('#safetyGo').click();
    await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
    const [fallbackDownload] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      page.locator('#mdl [data-ok]').click(),
    ]);
    assert(/^yuzhi-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fallbackDownload.suggestedFilename()),
      'unexpected fallback download name: ' + fallbackDownload.suggestedFilename());
    await page.waitForFunction(() =>
      document.getElementById('mdlT')?.textContent === '确认备份文件已保存', undefined, { timeout });
    assert(!(await notice(page)).state.lastBackup, 'unverified download cleared the reminder');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
    const unconfirmed = await notice(page);
    assert(unconfirmed.visible && !unconfirmed.state.lastBackup,
      'dismissing handoff confirmation counted as a backup: ' + JSON.stringify(unconfirmed));
    await page.locator('#safetyLater').click();
    const snoozed = await notice(page);
    assert(!snoozed.visible && snoozed.state.snoozedUntil > today, `later did not snooze: ${JSON.stringify(snoozed)}`);
    await openApp(page);
    assert(!(await notice(page)).visible, 'snoozed reminder came back after reload');

    await context.close();
  }

  // iPhone: the first-backup reminder includes the Home Screen hint; after
  // a successful export, "got it" can dismiss the standalone install hint.
  {
    const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
    // Record what reaches the system share sheet instead of opening it.
    await context.addInitScript(() => {
      window.__shared = [];
      window.__shareMode = 'save';
      navigator.canShare = (data) => Boolean(data?.files?.length);
      navigator.share = async (data) => {
        const file = data.files[0];
        const entry = { name: file.name, type: file.type, text: await file.text(), done: false };
        window.__shared.push(entry);
        // Settle in a later task so the app's continuation has run before
        // the test reads its result.
        setTimeout(() => { entry.done = true; }, 0);
        if (window.__shareMode === 'cancel') throw new DOMException('Share canceled', 'AbortError');
      };
    });
    const page = await context.newPage();
    await openApp(page);
    await page.evaluate(() => window.yuzhi.actions.createProject(window.yuzhi.store, '手机上的岛'));
    await page.waitForFunction(() => !document.getElementById('safetyNotice').hidden, undefined, { timeout });
    const hint = await notice(page);
    // First-time data protection takes priority but includes the installation
    // instructions (the Home Screen copy has separate storage).
    assert(hint.text.includes('还没有导出过备份') && hint.text.includes('添加到主屏幕')
      && hint.text.includes('导入备份') && hint.go === '现在导出' && hint.later === '稍后',
      `iPhone first-backup/install guidance missing: ${JSON.stringify(hint)}`);
    await page.locator('#safetyLater').click();
    const quiet = await notice(page);
    assert(!quiet.visible && quiet.state.snoozedUntil && !quiet.state.lastBackup,
      `later did not snooze the first-backup reminder: ${JSON.stringify(quiet)}`);

    // A share-sheet result only confirms handoff. Cancelling, dismissing the
    // verification prompt, and explicitly confirming are distinct outcomes.
    const exportFromMenu = async () => {
      await page.locator('#moreBtn').click();
      await page.locator('#menu [data-m="export"]').click();
      await page.waitForFunction(() => !document.getElementById('mdl').hidden, undefined, { timeout });
      await page.locator('#mdl [data-ok]').click();
    };
    const waitForVerification = () => page.waitForFunction(() =>
      document.getElementById('mdlT')?.textContent === '确认备份文件已保存', undefined, { timeout });
    const today = await page.evaluate(() => window.yuzhi.store.today());

    await page.evaluate(() => { window.__shareMode = 'cancel'; });
    await exportFromMenu();
    await page.waitForFunction(() => window.__shared.length === 1 && window.__shared[0].done, undefined, { timeout });
    const cancelled = await page.evaluate(() => ({
      shared: window.__shared.length,
      state: JSON.parse(localStorage.getItem('yuzhi:data-safety') ?? '{}'),
    }));
    assert(cancelled.shared === 1 && !cancelled.state.lastBackup,
      'a cancelled share counted as a backup: ' + JSON.stringify(cancelled));

    await page.evaluate(() => { window.__shareMode = 'save'; });
    await exportFromMenu();
    await page.waitForFunction(() => window.__shared.length === 2 && window.__shared[1].done, undefined, { timeout });
    await waitForVerification();
    assert(!(await notice(page)).state.lastBackup, 'share handoff cleared the backup reminder before confirmation');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
    assert(!(await notice(page)).state.lastBackup, 'dismissing share verification counted as a backup');

    await exportFromMenu();
    await page.waitForFunction(() => window.__shared.length === 3 && window.__shared[2].done, undefined, { timeout });
    await waitForVerification();
    assert(!(await notice(page)).state.lastBackup, 'unconfirmed share cleared the backup reminder');
    await page.locator('#mdl [data-ok]').click();
    await page.waitForFunction((today) =>
      JSON.parse(localStorage.getItem('yuzhi:data-safety') ?? '{}').lastBackup === today,
    today, { timeout });
    const shared = await page.evaluate(() => ({
      last: window.__shared.at(-1),
      state: JSON.parse(localStorage.getItem('yuzhi:data-safety') ?? '{}'),
    }));
    const sharedBackup = JSON.parse(shared.last.text);
    assert(shared.last.name === 'yuzhi-backup-' + today + '.json' && shared.last.type === 'application/json'
      && sharedBackup.format === 'yuzhi-backup' && sharedBackup.projects.length === 1 && shared.state.lastBackup === today,
      'confirmed share-sheet export failed: ' + JSON.stringify({ name: shared.last.name, state: shared.state }));

    // Export clears the backup snooze. The Home Screen hint must still be
    // shown independently, with an export shortcut for moving the island.
    await page.waitForFunction(() => !document.getElementById('safetyNotice').hidden
      && document.getElementById('safetyLater').textContent === '知道了', undefined, { timeout });
    const installAfterBackup = await notice(page);
    assert(installAfterBackup.text.includes('添加到主屏幕')
      && installAfterBackup.text.includes('导入备份')
      && !installAfterBackup.text.includes('还没有导出过备份')
      && installAfterBackup.go === '现在导出' && installAfterBackup.later === '知道了',
      `standalone iPhone install hint missing after export: ${JSON.stringify(installAfterBackup)}`);
    await page.locator('#safetyLater').click();
    const dismissed = await notice(page);
    assert(!dismissed.visible && dismissed.state.installHintUntil,
      `got it did not quiet the install hint: ${JSON.stringify(dismissed)}`);
    await context.close();
  }

  // Desktop Chromium: automatic backup into a picked folder. The native picker
  // cannot run headless, so it returns a real Origin Private File System
  // folder; permission prompts are scripted through the handle prototype.
  // This needs an ordinary on-disk profile: Chromium tears down an
  // off-the-record context when a stored FileSystemHandle is read back from
  // IndexedDB, and Playwright's default contexts are off-the-record.
  const profile = await mkdtemp(join(tmpdir(), 'yuzhi-auto-backup-'));
  try {
    const context = await chromium.launchPersistentContext(profile, { channel: channel || undefined, headless: true, locale: 'zh-CN' });
    await context.addInitScript(() => {
      // Init scripts also run in contexts without the File System Access API.
      if (typeof FileSystemHandle === 'undefined') return;
      window.__requested = 0;
      const permission = () => sessionStorage.getItem('yuzhi-test-permission') ?? 'granted';
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
      FileSystemHandle.prototype.queryPermission = async () => permission();
      FileSystemHandle.prototype.requestPermission = async () => {
        window.__requested += 1;
        sessionStorage.setItem('yuzhi-test-permission', 'granted');
        return 'granted';
      };
    });
    const page = await context.newPage();
    await openApp(page);
    const today = await page.evaluate(() => window.yuzhi.store.today());
    const todayFile = `yuzhi-auto-${today}.json`;
    const folder = () => page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
      const files = {};
      for await (const [name, handle] of dir.entries()) {
        // Skip the browser's in-flight swap files; they vanish when a stream closes or aborts.
        if (name.endsWith('.crswap')) continue;
        try { files[name] = await (await handle.getFile()).text(); } catch { /* removed meanwhile */ }
      }
      return files;
    });
    const setDeviceLastDate = (date) => page.evaluate((date) => new Promise((resolve, reject) => {
      const open = indexedDB.open('yuzhi-device', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kv', 'readwrite');
        const kv = tx.objectStore('kv');
        const get = kv.get('autoBackup');
        get.onsuccess = () => kv.put({ ...get.result, lastDate: date }, 'autoBackup');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }), date);
    const openSettings = async () => {
      await page.locator('#moreBtn').click();
      await page.locator('#menu [data-m="settings"]').click();
      await page.waitForFunction(() => document.querySelector('#mdl [data-auto-backup] .btnrow'), undefined, { timeout });
    };
    const closeSettings = async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.getElementById('mdl').hidden, undefined, { timeout });
    };

    await page.evaluate(() => window.yuzhi.actions.createProject(window.yuzhi.store, '自动备份验收'));
    await openSettings();
    await page.locator('#mdl [data-auto="choose"]').click();
    await page.waitForFunction(() => document.querySelector('#mdl [data-auto-backup]')?.textContent.includes('正在自动备份到「picked」，上次：今天'), undefined, { timeout });
    let files = await folder();
    const first = JSON.parse(files[todayFile] ?? 'null');
    assert(first?.format === 'yuzhi-backup' && first.projects.length === 1, `choosing a folder did not write today's backup: ${Object.keys(files)}`);
    assert((await notice(page)).state.lastBackup === today, 'automatic backup did not count as a backup');
    assert(await page.evaluate(() => document.querySelector('#mdl [data-safety-last]')?.textContent === '上次在这个浏览器导出备份：今天。'),
      'settings still show the pre-backup state after an automatic backup');
    await closeSettings();

    // An evening review refreshes today's file.
    await page.evaluate(() => {
      const { store, actions } = window.yuzhi;
      const project = store.data.projects[0];
      actions.createTask(store, { title: '结算后应进入备份', projectId: project.id, scheduledFor: store.today() });
    });
    await page.locator('#settleBtn').click();
    await page.locator('#settle [data-act="commit"]').click();
    await page.waitForFunction(async (name) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
      // The file is swapped into place atomically; a read can race that swap.
      try { return (await (await (await dir.getFileHandle(name)).getFile()).text()).includes('结算后应进入备份'); } catch { return false; }
    }, todayFile, { timeout });

    // Only our own files are pruned, down to the newest 30.
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
      const write = async (name) => {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write('{}');
        await writable.close();
      };
      for (let day = 1; day <= 31; day++) await write(`yuzhi-auto-2025-01-${String(day).padStart(2, '0')}.json`);
      await write('keep-me.txt');
      await write('yuzhi-backup-2025-01-01.json');
    });
    await openSettings();
    await page.locator('#mdl [data-auto="run"]').click();
    await page.waitForFunction(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
      let auto = 0;
      for await (const name of dir.keys()) if (/^yuzhi-auto-/.test(name)) auto++;
      return auto === 30;
    }, undefined, { timeout });
    files = await folder();
    assert(files['keep-me.txt'] !== undefined && files['yuzhi-backup-2025-01-01.json'] !== undefined && files[todayFile] && !files['yuzhi-auto-2025-01-01.json'],
      `pruning touched the wrong files: ${Object.keys(files).sort()}`);
    await closeSettings();

    const settleWithTask = async (title) => {
      await page.evaluate((title) => {
        const { store, actions } = window.yuzhi;
        actions.createTask(store, { title, projectId: store.data.projects[0].id, scheduledFor: store.today() });
      }, title);
      await page.locator('#settleBtn').click();
      await page.locator('#settle [data-act="commit"]').click();
      await page.waitForFunction(() => document.getElementById('settle').hidden !== false || !document.querySelector('#settle [data-act="commit"]'), undefined, { timeout }).catch(() => {});
      await page.waitForTimeout(500);
    };

    // Losing the writer lease mid-write aborts the stream: the existing file
    // is never replaced by a tab that is no longer the writer (PR #37 review).
    const beforeLoss = (await folder())[todayFile];
    await page.evaluate(() => {
      const original = FileSystemWritableFileStream.prototype.write;
      FileSystemWritableFileStream.prototype.write = async function (...args) {
        await original.apply(this, args);
        FileSystemWritableFileStream.prototype.write = original;
        window.yuzhi.store.setReadOnly(true);
      };
    });
    await settleWithTask('失去写权限后不应写入');
    await page.evaluate(() => window.yuzhi.store.setReadOnly(false));
    assert((await folder())[todayFile] === beforeLoss, 'a tab that lost the writer lease still replaced the backup file');

    // A folder choice stopped in another tab is honoured, not resurrected.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('yuzhi-device', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('autoBackup');
        tx.oncomplete = () => { open.result.close(); resolve(); };
      };
    }));
    await page.evaluate(async (name) => (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')).removeEntry(name), todayFile);
    await settleWithTask('停用后不应写入');
    const stopped = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('yuzhi-device', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('kv').objectStore('kv').get('autoBackup');
        get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
      };
    }));
    assert(!(await folder())[todayFile] && stopped === null, 'stale folder settings were used after another tab stopped automatic backup');

    // Re-enable for the remaining checks.
    await openSettings();
    await page.locator('#mdl [data-auto="choose"]').click();
    await page.waitForFunction(() => document.querySelector('#mdl [data-auto-backup]')?.textContent.includes('正在自动备份到「picked」'), undefined, { timeout });
    await closeSettings();

    // A new day's first opening writes a fresh copy on its own.
    await page.evaluate(async (name) => (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')).removeEntry(name), todayFile);
    await setDeviceLastDate('2025-12-31');
    await openApp(page);
    await page.waitForFunction(async (name) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
      try { await dir.getFileHandle(name); return true; } catch { return false; }
    }, todayFile, { timeout });

    // Without remembered permission nothing is written silently; the notice
    // asks once and a click both re-grants and backs up.
    await page.evaluate(async (name) => {
      sessionStorage.setItem('yuzhi-test-permission', 'prompt');
      await (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')).removeEntry(name);
    }, todayFile);
    await setDeviceLastDate('2025-12-31');
    await openApp(page);
    await page.waitForFunction(() => !document.getElementById('safetyNotice').hidden, undefined, { timeout });
    const ask = await notice(page);
    assert(ask.text.includes('需要你再允许一次写入') && ask.go === '允许并备份' && ask.later === '今天先不',
      `missing permission notice: ${JSON.stringify(ask)}`);
    assert(!(await folder())[todayFile], 'wrote a backup without permission');
    await page.locator('#safetyGo').click();
    await page.waitForFunction(() => document.getElementById('safetyNotice').hidden, undefined, { timeout });
    assert(await page.evaluate(() => window.__requested) === 1 && (await folder())[todayFile], 'allow-and-back-up did not write today\'s backup');
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }

  console.log('[data-safety] persistence, reminders, install hint, share-sheet export and folder auto-backup passed');
} finally {
  await browser.close();
}
