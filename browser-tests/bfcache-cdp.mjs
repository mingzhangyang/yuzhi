const cdpBase = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const appURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const timeout = 20000;
const maxAttempts = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, message, limit = timeout) {
  const deadline = Date.now() + limit;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  throw new Error(message + '; last=' + (last instanceof Error ? last.message : JSON.stringify(last)));
}

async function createClient() {
  const created = await fetch(cdpBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  if (!created.ok) throw new Error('cannot create CDP target: ' + created.status + ' ' + await created.text());
  const target = await created.json();

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    const handlers = listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) handler(message.params);
  });

  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  };

  const on = (method, handler) => {
    const handlers = listeners.get(method) ?? new Set();
    handlers.add(handler);
    listeners.set(method, handlers);
    return () => handlers.delete(handler);
  };

  const close = async () => {
    try { await send('Page.close'); } catch {}
    socket.close();
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "(() => { const key = (name) => 'yuzhi-bfcache:' + name + ':' + location.pathname; addEventListener('pagehide', (event) => sessionStorage.setItem(key('pagehide'), String(event.persisted))); addEventListener('pageshow', (event) => sessionStorage.setItem(key('pageshow'), String(event.persisted))); })();",
  });

  return { send, evaluate, on, close };
}

async function writeDurableMarker(evaluate, id, text) {
  const expression =
    "(async () => {" +
    "const id=" + JSON.stringify(id) + ";" +
    "const text=" + JSON.stringify(text) + ";" +
    "const db = await new Promise((resolve, reject) => {" +
    "  const request = indexedDB.open('yuzhi');" +
    "  request.onsuccess = () => resolve(request.result);" +
    "  request.onerror = () => reject(request.error ?? new Error('open failed'));" +
    "});" +
    "try {" +
    "  await new Promise((resolve, reject) => {" +
    "    const tx = db.transaction('chronicle', 'readwrite');" +
    "    tx.objectStore('chronicle').put({ id, date: '2026-10-04', text, kind: 'event' });" +
    "    tx.oncomplete = () => resolve();" +
    "    tx.onerror = () => reject(tx.error ?? new Error('durable write failed'));" +
    "    tx.onabort = () => reject(tx.error ?? new Error('durable write aborted'));" +
    "  });" +
    "} finally { db.close(); }" +
    "return true;" +
    "})()";
  await evaluate(expression, true);
}

async function runAttempt(attempt) {
  const client = await createClient();
  const { send, evaluate, on } = client;
  const notRestored = [];
  let appPath = '/';
  on('Page.backForwardCacheNotUsed', (params) => notRestored.push(params));

  const storageKey = (name) => 'yuzhi-bfcache:' + name + ':' + appPath;
  const diagnostics = async () => {
    const state = await evaluate(
      "({ href: location.href, pagehidePersisted: sessionStorage.getItem(" + JSON.stringify(storageKey('pagehide')) + "), pageshowPersisted: sessionStorage.getItem(" + JSON.stringify(storageKey('pageshow')) + "), state: window.yuzhi?.session?.state ?? null, readOnly: window.yuzhi?.store?.isReadOnly ?? null, navigation: performance.getEntriesByType('navigation').map((entry) => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons ?? null })) })",
    );
    return { appPath, state, cdpNotRestored: notRestored };
  };

  try {
    const durableId = 'bfcache-durable-' + attempt + '-' + Date.now();
    const durableText = 'BFCache durable refresh ' + attempt;

    await send('Page.navigate', { url: appURL });
    await waitFor(
      () => evaluate("Boolean(window.yuzhi?.store && window.yuzhi?.session)"),
      'app did not boot',
    );
    await waitFor(
      () => evaluate("window.yuzhi.session.state === 'writer' && window.yuzhi.store.isReadOnly === false"),
      'app did not become writer before BFCache attempt',
    );
    appPath = await evaluate("location.pathname");

    await evaluate(
      "sessionStorage.removeItem(" + JSON.stringify(storageKey('pagehide')) + "); sessionStorage.removeItem(" + JSON.stringify(storageKey('pageshow')) + "); true",
    );

    const history = await send('Page.getNavigationHistory');
    const appEntry = history.entries[history.currentIndex];
    assert(appEntry, 'missing application history entry');

    await send('Page.navigate', { url: appURL + '/browser-smoke-secondary.html?bfcache-cdp=' + attempt });
    await waitFor(
      () => evaluate("location.pathname === '/browser-smoke-secondary.html'"),
      'secondary navigation did not commit',
    );

    const pagehidePersisted = await evaluate(
      "sessionStorage.getItem(" + JSON.stringify(storageKey('pagehide')) + ")",
    );
    if (pagehidePersisted !== 'true') {
      throw new Error(
        'application did not enter BFCache on attempt ' + attempt + ': ' + JSON.stringify(await diagnostics()),
      );
    }

    // The app document is frozen now. Mutate IndexedDB through the same-origin
    // secondary document; the BFCache document cannot see this in memory.
    await writeDurableMarker(evaluate, durableId, durableText);

    await send('Page.navigateToHistoryEntry', { entryId: appEntry.id });
    await waitFor(
      () => evaluate("location.pathname === " + JSON.stringify(appPath) + " && Boolean(window.yuzhi?.session)"),
      'back navigation did not return to the application',
    );

    try {
      await waitFor(
        () => evaluate(
          "sessionStorage.getItem(" + JSON.stringify(storageKey('pageshow')) + ") === 'true'",
        ),
        'restored pageshow did not report persisted=true',
        6000,
      );
    } catch (error) {
      // pagehide.persisted=true proves this target entered BFCache. If Chrome
      // evicts it afterwards without reporting an app eligibility blocker,
      // retry in a fresh target so the retry cannot inherit lifecycle state
      // from the evicted document.
      const evidence = await diagnostics();
      if (notRestored.length > 0) {
        throw new Error(
          (error instanceof Error ? error.message : String(error)) +
          '; browser reported not-restored reasons=' + JSON.stringify(evidence),
        );
      }
      return {
        status: 'evicted',
        evidence: {
          error: error instanceof Error ? error.message : String(error),
          ...evidence,
        },
      };
    }

    try {
      await waitFor(
        () => evaluate("window.yuzhi.session.state === 'writer' && window.yuzhi.store.isReadOnly === false"),
        'restored page did not resume writer duties',
      );
    } catch (error) {
      throw new Error(
        (error instanceof Error ? error.message : String(error)) +
        '; restored state=' + JSON.stringify(await diagnostics()),
      );
    }

    const evidence = await evaluate(
      "({ appPath: location.pathname, pagehidePersisted: sessionStorage.getItem(" + JSON.stringify(storageKey('pagehide')) + "), pageshowPersisted: sessionStorage.getItem(" + JSON.stringify(storageKey('pageshow')) + "), state: window.yuzhi.session.state, readOnly: window.yuzhi.store.isReadOnly, durablePresent: window.yuzhi.store.data.chronicle.some((row) => row.id === " + JSON.stringify(durableId) + ") })",
    );

    assert(evidence.pagehidePersisted === 'true', 'BFCache entry evidence was lost');
    assert(evidence.pageshowPersisted === 'true', 'BFCache restore evidence was lost');
    assert(
      evidence.durablePresent,
      'restored page did not observe the durable chronicle marker written to IndexedDB while it was cached',
    );

    return { status: 'restored', evidence };
  } finally {
    await client.close();
  }
}

const versionClient = await createClient();
try {
  const version = await versionClient.send('Browser.getVersion');
  console.log('[bfcache-cdp] browser=' + version.product);
} finally {
  await versionClient.close();
}

let restored = false;
let lastEviction;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const result = await runAttempt(attempt);
  if (result.status === 'restored') {
    console.log(
      '[bfcache-cdp] ok attempt=' + attempt +
      ' pagehide.persisted=' + result.evidence.pagehidePersisted +
      ' pageshow.persisted=' + result.evidence.pageshowPersisted +
      ' durableRefresh=true',
    );
    restored = true;
    break;
  }

  lastEviction = result.evidence;
  console.warn(
    '[bfcache-cdp] cached page was evicted before restore on attempt ' + attempt +
    ': ' + JSON.stringify(lastEviction),
  );
  if (attempt < maxAttempts) await sleep(100);
}

if (!restored) {
  throw new Error(
    'Chrome evicted all ' + maxAttempts + ' fresh BFCache targets after confirmed cache entry; last=' +
    JSON.stringify(lastEviction),
  );
}
