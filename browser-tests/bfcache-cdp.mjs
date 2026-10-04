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

function on(method, handler) {
  const handlers = listeners.get(method) ?? new Set();
  handlers.add(handler);
  listeners.set(method, handlers);
  return () => handlers.delete(handler);
}

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function diagnostics(notRestored) {
  return evaluate(
    "({ href: location.href, pagehidePersisted: sessionStorage.getItem('yuzhi-bfcache:pagehide:/'), pageshowPersisted: sessionStorage.getItem('yuzhi-bfcache:pageshow:/'), state: window.yuzhi?.session?.state ?? null, readOnly: window.yuzhi?.store?.isReadOnly ?? null, navigation: performance.getEntriesByType('navigation').map((entry) => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons ?? null })) })",
  ).then((state) => ({ state, cdpNotRestored: notRestored }));
}

async function writeDurableProject(id, name) {
  const expression =
    "(async () => {" +
    "const id=" + JSON.stringify(id) + ";" +
    "const name=" + JSON.stringify(name) + ";" +
    "const db = await new Promise((resolve, reject) => {" +
    "  const request = indexedDB.open('yuzhi');" +
    "  request.onsuccess = () => resolve(request.result);" +
    "  request.onerror = () => reject(request.error ?? new Error('open failed'));" +
    "});" +
    "try {" +
    "  await new Promise((resolve, reject) => {" +
    "    const tx = db.transaction('projects', 'readwrite');" +
    "    tx.objectStore('projects').put({ id, name, createdAt: '2026-10-04', status: 'active', islandSlot: 7 });" +
    "    tx.oncomplete = () => resolve();" +
    "    tx.onerror = () => reject(tx.error ?? new Error('durable write failed'));" +
    "    tx.onabort = () => reject(tx.error ?? new Error('durable write aborted'));" +
    "  });" +
    "} finally { db.close(); }" +
    "return true;" +
    "})()";
  await evaluate(expression, true);
}

const notRestored = [];
on('Page.backForwardCacheNotUsed', (params) => notRestored.push(params));

try {
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "(() => { const key = (name) => 'yuzhi-bfcache:' + name + ':' + location.pathname; addEventListener('pagehide', (event) => sessionStorage.setItem(key('pagehide'), String(event.persisted))); addEventListener('pageshow', (event) => sessionStorage.setItem(key('pageshow'), String(event.persisted))); })();",
  });

  const version = await send('Browser.getVersion');
  console.log('[bfcache-cdp] browser=' + version.product);

  let restored = false;
  let lastEviction;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptNotRestoredStart = notRestored.length;
    const durableId = 'bfcache-durable-' + attempt + '-' + Date.now();
    const durableName = 'BFCache durable refresh ' + attempt;

    await send('Page.navigate', { url: appURL });
    await waitFor(
      () => evaluate("Boolean(window.yuzhi?.store && window.yuzhi?.session)"),
      'app did not boot',
    );
    await waitFor(
      () => evaluate("window.yuzhi.session.state === 'writer' && window.yuzhi.store.isReadOnly === false"),
      'app did not become writer before BFCache attempt',
    );

    await evaluate(
      "sessionStorage.removeItem('yuzhi-bfcache:pagehide:/'); sessionStorage.removeItem('yuzhi-bfcache:pageshow:/'); true",
    );

    const history = await send('Page.getNavigationHistory');
    const appEntry = history.entries[history.currentIndex];
    assert(appEntry, 'missing application history entry');

    await send('Page.navigate', { url: appURL + '/favicon.svg?bfcache-cdp=' + attempt });
    await waitFor(
      () => evaluate("location.pathname === '/favicon.svg'"),
      'secondary navigation did not commit',
    );

    const pagehidePersisted = await evaluate("sessionStorage.getItem('yuzhi-bfcache:pagehide:/')");
    if (pagehidePersisted !== 'true') {
      const evidence = await diagnostics(notRestored.slice(attemptNotRestoredStart));
      throw new Error(
        'application did not enter BFCache on attempt ' + attempt + ': ' + JSON.stringify(evidence),
      );
    }

    // The app document is frozen now. Mutate IndexedDB through the same-origin
    // secondary document; the BFCache document cannot see this in memory.
    await writeDurableProject(durableId, durableName);

    await send('Page.navigateToHistoryEntry', { entryId: appEntry.id });
    await waitFor(
      () => evaluate("location.pathname === '/' && Boolean(window.yuzhi?.session)"),
      'back navigation did not return to the application',
    );

    try {
      await waitFor(
        () => evaluate("sessionStorage.getItem('yuzhi-bfcache:pageshow:/') === 'true'"),
        'restored pageshow did not report persisted=true',
        6000,
      );
    } catch (error) {
      // pagehide.persisted=true proves the application was eligible and was
      // actually inserted into BFCache. Failure to restore after that point is
      // a post-entry browser eviction, not an app eligibility failure. Retry a
      // bounded number of times, but never convert pagehide.persisted=false or
      // a product not-restored reason into success.
      lastEviction = {
        error: error instanceof Error ? error.message : String(error),
        evidence: await diagnostics(notRestored.slice(attemptNotRestoredStart)),
      };
      console.warn('[bfcache-cdp] cached page was evicted before restore on attempt ' + attempt + ': ' + JSON.stringify(lastEviction));
      if (attempt < maxAttempts) continue;
      break;
    }

    await waitFor(
      () => evaluate("window.yuzhi.session.state === 'writer' && window.yuzhi.store.isReadOnly === false"),
      'restored page did not resume writer duties',
    );

    const evidence = await evaluate(
      "({ pagehidePersisted: sessionStorage.getItem('yuzhi-bfcache:pagehide:/'), pageshowPersisted: sessionStorage.getItem('yuzhi-bfcache:pageshow:/'), state: window.yuzhi.session.state, readOnly: window.yuzhi.store.isReadOnly, durablePresent: window.yuzhi.store.data.projects.some((project) => project.id === " + JSON.stringify(durableId) + ") })",
    );

    assert(evidence.pagehidePersisted === 'true', 'BFCache entry evidence was lost');
    assert(evidence.pageshowPersisted === 'true', 'BFCache restore evidence was lost');
    assert(
      evidence.durablePresent,
      'restored page did not observe the project written to IndexedDB while it was cached',
    );

    console.log(
      '[bfcache-cdp] ok attempt=' + attempt +
      ' pagehide.persisted=' + evidence.pagehidePersisted +
      ' pageshow.persisted=' + evidence.pageshowPersisted +
      ' durableRefresh=true',
    );
    restored = true;
    break;
  }

  if (!restored) {
    throw new Error(
      'Chrome evicted all ' + maxAttempts + ' pages after confirmed BFCache entry; last=' + JSON.stringify(lastEviction),
    );
  }
} finally {
  try { await send('Page.close'); } catch {}
  socket.close();
}
