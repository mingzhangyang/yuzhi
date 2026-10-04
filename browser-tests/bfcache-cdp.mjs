const cdpBase = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const appURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const timeout = 20000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, message) {
  const deadline = Date.now() + timeout;
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

  await send('Page.navigate', { url: appURL });
  await waitFor(
    () => evaluate("Boolean(window.yuzhi?.store && window.yuzhi?.session)"),
    'app did not boot',
  );

  await evaluate(
    "(async () => { const app = window.yuzhi; app.actions.createProject(app.store, 'BFCache CDP evidence'); await app.store.flush(); return true; })()",
    true,
  );

  const history = await send('Page.getNavigationHistory');
  const appEntry = history.entries[history.currentIndex];
  assert(appEntry, 'missing application history entry');

  await send('Page.navigate', { url: appURL + '/favicon.svg?bfcache-cdp=1' });
  await waitFor(
    () => evaluate("location.pathname === '/favicon.svg'"),
    'secondary navigation did not commit',
  );

  await send('Page.navigateToHistoryEntry', { entryId: appEntry.id });
  await waitFor(
    () => evaluate("location.pathname === '/' && Boolean(window.yuzhi?.session)"),
    'back navigation did not restore the application',
  );

  // The preserved document becomes observable through Runtime before Chrome
  // necessarily dispatches the restored pageshow event. Wait on the lifecycle
  // evidence itself instead of treating URL restoration as the event barrier.
  try {
    await waitFor(
      () => evaluate("sessionStorage.getItem('yuzhi-bfcache:pageshow:/') === 'true'"),
      'restored pageshow did not report persisted=true',
    );
  } catch (error) {
    const diagnostics = await evaluate("({ href: location.href, pagehidePersisted: sessionStorage.getItem('yuzhi-bfcache:pagehide:/'), pageshowPersisted: sessionStorage.getItem('yuzhi-bfcache:pageshow:/'), state: window.yuzhi?.session?.state ?? null, readOnly: window.yuzhi?.store?.isReadOnly ?? null, navigation: performance.getEntriesByType('navigation').map((entry) => ({ type: entry.type, notRestoredReasons: entry.notRestoredReasons ?? null })) })");
    throw new Error((error instanceof Error ? error.message : String(error)) + '; diagnostics=' + JSON.stringify(diagnostics) + '; cdpNotRestored=' + JSON.stringify(notRestored));
  }
  await waitFor(
    () => evaluate("window.yuzhi.session.state === 'writer' && window.yuzhi.store.isReadOnly === false"),
    'restored page did not resume writer duties',
  );

  const evidence = await evaluate("({ pagehidePersisted: sessionStorage.getItem('yuzhi-bfcache:pagehide:/'), pageshowPersisted: sessionStorage.getItem('yuzhi-bfcache:pageshow:/'), state: window.yuzhi.session.state, readOnly: window.yuzhi.store.isReadOnly, projects: window.yuzhi.store.data.projects.map((project) => project.name) })");

  if (evidence.pagehidePersisted !== 'true' || evidence.pageshowPersisted !== 'true') {
    throw new Error('BFCache was not used: evidence=' + JSON.stringify(evidence) + ', notRestored=' + JSON.stringify(notRestored));
  }

  assert(
    evidence.projects.includes('BFCache CDP evidence'),
    'BFCache-restored page lost the durable snapshot',
  );

  console.log('[bfcache-cdp] ok pagehide.persisted=' + evidence.pagehidePersisted + ' pageshow.persisted=' + evidence.pageshowPersisted);
} finally {
  try { await send('Page.close'); } catch {}
  socket.close();
}
