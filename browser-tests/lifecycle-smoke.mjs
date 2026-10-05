import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const timeout = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openApp(page) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => Boolean(window.yuzhi?.store && window.yuzhi?.actions && window.yuzhi?.session),
    undefined,
    { timeout },
  );
}

async function waitReadOnly(page, expected) {
  await page.waitForFunction(
    (value) => document.body.dataset.readOnly === value,
    expected ? 'true' : 'false',
    { timeout },
  );
}

async function runScenario(name, fn) {
  process.stdout.write(`\n[browser-smoke] ${name} ... `);
  await fn();
  console.log('ok');
}

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? 'chrome',
  headless: true,
});

try {
  await runScenario('real multi-tab writer handoff drains accepted writes', async () => {
    const context = await browser.newContext();
    try {
      const writer = await context.newPage();
      await openApp(writer);
      await waitReadOnly(writer, false);

      const reader = await context.newPage();
      await openApp(reader);
      await waitReadOnly(reader, true);
      assert(await reader.locator('#tabNotice').isVisible(), 'reader did not expose the read-only tab notice');

      // Put one unclassified event in the shared snapshot and open its drift
      // inspection while this tab is still a reader. The action is correctly
      // disabled now, but that permission snapshot must not survive takeover.
      await writer.evaluate(async () => {
        const app = window.yuzhi;
        const now = app.store.clock().getTime();
        app.store.put('events', {
          id: 'browser-reader-drift',
          sourceId: 'browser-smoke',
          uid: 'browser-reader-drift',
          title: '接管前漂流瓶',
          start: new Date(now + 2 * 60 * 60_000).toISOString(),
          end: new Date(now + 3 * 60 * 60_000).toISOString(),
          allDay: false,
          classified: false,
        });
        await app.store.flush();
      });
      await reader.waitForFunction(
        () => window.yuzhi.renderer.scene.drifting.some((item) => item.title === '接管前漂流瓶'),
        undefined,
        { timeout },
      );
      await reader.locator('#map').focus();
      let readerDriftCard = false;
      for (let i = 0; i < 240; i++) {
        await reader.keyboard.press('ArrowRight');
        readerDriftCard = await reader.locator('#mapinfo .mi-action').isVisible().catch(() => false);
        if (readerDriftCard) break;
      }
      assert(readerDriftCard, 'reader never exposed the drift inspection');
      assert(!(await reader.locator('#mapinfo .mi-action').isEnabled()), 'reader drift action was unexpectedly enabled');

      await writer.evaluate(async () => {
        const app = window.yuzhi;
        app.actions.createProject(app.store, 'Browser writer A');
        await app.store.flush();
      });

      await reader.waitForFunction(
        () => window.yuzhi.store.data.projects.some((project) => project.name === 'Browser writer A'),
        undefined,
        { timeout },
      );
      await waitReadOnly(reader, true);

      // Simulate a visible reader missing BroadcastChannel delivery. The
      // authoritative takeover reload must recover the event without replaying
      // the stale scene -> fresh scene transition as a new cue.
      await reader.evaluate(() => {
        window.yuzhi.session.tabs.suspendNotifications();
      });
      await writer.evaluate(async () => {
        const app = window.yuzhi;
        const project = app.store.data.projects.find((row) => row.name === 'Browser writer A');
        if (!project) throw new Error('seed project missing');
        const now = app.store.clock().getTime();
        app.store.put('events', {
          id: 'browser-takeover-soon',
          sourceId: 'browser-smoke',
          uid: 'browser-takeover-soon',
          title: '接管前提醒',
          start: new Date(now + 10 * 60_000).toISOString(),
          end: new Date(now + 70 * 60_000).toISOString(),
          allDay: false,
          projectId: project.id,
          classified: true,
        });
        await app.store.flush();
      });
      const stale = await reader.evaluate(() => ({
        hasEvent: window.yuzhi.store.data.events.some((event) => event.id === 'browser-takeover-soon'),
        hasSoon: window.yuzhi.renderer.scene.villages.some((village) =>
          village.agenda?.soon?.some((event) => event.eventId === 'browser-takeover-soon')),
      }));
      assert(!stale.hasEvent && !stale.hasSoon, `reader unexpectedly received the missed broadcast: ${JSON.stringify(stale)}`);

      const release = await writer.evaluate(async () => {
        const app = window.yuzhi;
        app.store.batch(() => {
          for (let i = 0; i < 1200; i++) {
            app.store.put('chronicle', {
              id: `browser-drain|${i}`,
              date: app.store.today(),
              text: `browser drain ${i}`,
              kind: 'event',
            });
          }
        });

        // suspendForCache revokes new actions synchronously, then waits for the
        // already accepted IndexedDB transaction before releasing the Web Lock.
        const suspending = app.session.suspendForCache();
        let blocked = '';
        try {
          app.actions.createProject(app.store, 'must not commit after release');
        } catch (error) {
          blocked = error instanceof Error ? error.message : String(error);
        }
        await suspending;
        return {
          blocked,
          state: app.session.state,
          readOnly: app.store.isReadOnly,
        };
      });

      assert(release.readOnly, 'released writer remained writable');
      assert(release.state === 'reader', `released writer ended in ${release.state}, expected reader`);
      assert(release.blocked.includes('只读'), `new action after revocation was not blocked: ${release.blocked}`);

      // Notifications are intentionally still suspended: the reader must stay
      // stale until takeover, then recover both the drained writes and the
      // missed soon event from the authoritative durable snapshot.
      const beforeTakeover = await reader.evaluate(() => ({
        drained: window.yuzhi.store.data.chronicle.filter((row) => row.id.startsWith('browser-drain|')).length,
        hasSoon: window.yuzhi.renderer.scene.villages.some((village) =>
          village.agenda?.soon?.some((event) => event.eventId === 'browser-takeover-soon')),
      }));
      assert(beforeTakeover.drained === 0 && !beforeTakeover.hasSoon,
        `reader did not remain stale after notifications were suspended: ${JSON.stringify(beforeTakeover)}`);

      await reader.locator('#tabTakeover').click();
      await waitReadOnly(reader, false);
      await reader.waitForFunction(
        () => window.yuzhi.renderer.scene.villages.some((village) =>
          village.agenda?.soon?.some((event) => event.eventId === 'browser-takeover-soon')),
        undefined,
        { timeout },
      );
      const fresh = await reader.evaluate(() => ({
        state: window.yuzhi.session.state,
        projectNames: window.yuzhi.store.data.projects.map((project) => project.name),
        drained: window.yuzhi.store.data.chronicle.filter((row) => row.id.startsWith('browser-drain|')).length,
        hasSoon: window.yuzhi.renderer.scene.villages.some((village) =>
          village.agenda?.soon?.some((event) => event.eventId === 'browser-takeover-soon')),
        bellHandled: window.yuzhi.renderer.belled.has('browser-takeover-soon'),
        bellRipples: window.yuzhi.renderer.bellRipples.length,
        stageCues: window.yuzhi.renderer.stageCues.length,
        pulses: window.yuzhi.renderer.pulses.length,
      }));
      assert(fresh.state === 'writer', `takeover ended in ${fresh.state}`);
      assert(fresh.projectNames.includes('Browser writer A'), 'takeover opened before loading the final writer snapshot');
      assert(fresh.drained === 1200, `takeover missed accepted writes: ${fresh.drained}/1200`);
      assert(fresh.hasSoon, 'takeover did not install the missed soon event');
      assert(!fresh.bellHandled && fresh.bellRipples === 0 && fresh.stageCues === 0 && fresh.pulses === 0,
        `takeover replayed stale cues: ${JSON.stringify(fresh)}`);
      assert(await reader.locator('#mapinfo').isHidden(),
        'takeover left the reader-era drift inspection visible with stale permissions');

      await reader.evaluate(async () => {
        const app = window.yuzhi;
        app.actions.createProject(app.store, 'Browser writer B');
        await app.store.flush();
      });
      const names = await reader.evaluate(() => window.yuzhi.store.data.projects.map((project) => project.name));
      assert(names.includes('Browser writer B'), 'new writer could not persist after takeover');
    } finally {
      await context.close();
    }
  });

  await runScenario('interrupted visibility refreshes release every cue-suppression scope', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openApp(page);
      await waitReadOnly(page, false);

      await page.evaluate(() => {
        const app = window.yuzhi;
        let visibility = 'hidden';
        const waiters = [];
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => visibility,
        });
        app.session.whenIdle = () => new Promise((resolve) => { waiters.push(resolve); });
        window.__visibilityCueTest = {
          set(value) {
            visibility = value;
            document.dispatchEvent(new Event('visibilitychange'));
          },
          resolve(index) { waiters[index]?.(); },
          pending() { return waiters.length; },
          depth() { return app.renderer.cueSuppressionDepth; },
        };
      });

      await page.evaluate(() => {
        window.__visibilityCueTest.set('hidden');
        window.__visibilityCueTest.set('visible');
      });
      await page.waitForFunction(() => window.__visibilityCueTest.pending() === 1 && window.__visibilityCueTest.depth() === 1, undefined, { timeout });

      await page.evaluate(() => {
        window.__visibilityCueTest.set('hidden');
        window.__visibilityCueTest.set('visible');
      });
      await page.waitForFunction(() => window.__visibilityCueTest.pending() === 2 && window.__visibilityCueTest.depth() === 2, undefined, { timeout });

      await page.evaluate(() => window.__visibilityCueTest.resolve(0));
      await page.waitForFunction(() => window.__visibilityCueTest.depth() === 1, undefined, { timeout });
      await page.evaluate(() => window.__visibilityCueTest.resolve(1));
      await page.waitForFunction(() => window.__visibilityCueTest.depth() === 0, undefined, { timeout });
    } finally {
      await context.close();
    }
  });

  await runScenario('real IndexedDB versionchange upgrades and old client stays fail-closed', async () => {
    const context = await browser.newContext();
    try {
      const appPage = await context.newPage();
      await openApp(appPage);
      await waitReadOnly(appPage, false);

      const upgrader = await context.newPage();
      await upgrader.goto(`${baseURL}/browser-smoke-secondary.html?schema-upgrade=1`, { waitUntil: 'load' });
      const upgradedVersion = await upgrader.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('yuzhi', 9);
        request.onupgradeneeded = () => {};
        request.onsuccess = () => {
          const db = request.result;
          const version = db.version;
          db.close();
          resolve(version);
        };
        request.onblocked = () => reject(new Error('schema upgrade blocked by an old IndexedDB connection'));
        request.onerror = () => reject(request.error ?? new Error('schema upgrade failed'));
      }));
      assert(upgradedVersion === 9, `external schema upgrade reached ${upgradedVersion}, expected 9`);

      await waitReadOnly(appPage, true);
      await appPage.waitForFunction(
        () => window.yuzhi.session.state === 'reader',
        undefined,
        { timeout },
      );

      const refusal = await appPage.evaluate(async () => {
        const app = window.yuzhi;
        let actionError = '';
        let takeoverError = '';
        try {
          app.actions.createProject(app.store, 'must stay blocked on schema 9');
        } catch (error) {
          actionError = error instanceof Error ? error.message : String(error);
        }
        try {
          await app.session.requestTakeover();
        } catch (error) {
          takeoverError = error instanceof Error ? error.message : String(error);
        }
        return {
          actionError,
          takeoverError,
          state: app.session.state,
          readOnly: app.store.isReadOnly,
        };
      });

      assert(refusal.readOnly, 'old client became writable after incompatible schema upgrade');
      assert(refusal.state === 'reader', `old client ended in ${refusal.state}, expected reader`);
      assert(refusal.actionError.includes('只读'), `old client accepted a new action: ${refusal.actionError}`);
      assert(
        refusal.takeoverError.includes('schema 9') || refusal.takeoverError.includes('更新版本'),
        `takeover did not report the incompatible schema: ${refusal.takeoverError}`,
      );
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}
