/**
 * Production-route locale smoke.
 *
 * This intentionally talks to wrangler dev rather than Vite preview so it
 * exercises the same Worker + Static Assets routing contract used in
 * production. Assertions inspect raw HTML before application JavaScript runs.
 */

const baseURL = process.env.WORKER_BASE_URL ?? 'http://127.0.0.1:8787';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchText(path) {
  const response = await fetch(baseURL + path, {
    headers: { accept: 'text/html' },
    redirect: 'error',
  });
  const text = await response.text();
  assert(response.ok, `${path} returned ${response.status}: ${text.slice(0, 200)}`);
  return { response, text };
}

function has(html, fragment, label) {
  assert(html.includes(fragment), `raw HTML missing ${label}: ${fragment}`);
}

const english = await fetchText('/en/');
assert(
  english.response.headers.get('x-yuzhi-locale-metadata') === 'en',
  'English HTML did not pass through the shared locale metadata rewriter',
);
has(english.text, '<html lang="en">', 'English document language');
has(english.text, '<title>Yuzhi | Grow an island from your real life</title>', 'English title');
has(
  english.text,
  '<meta name="description" content="Yuzhi is a personal journal, Todo, and calendar app that turns real-life progress, daily review, and reflection into a growing island.">',
  'English description',
);
has(english.text, '<meta property="og:locale" content="en_US">', 'English Open Graph locale');
has(english.text, '<meta property="og:locale:alternate" content="zh_CN">', 'alternate Open Graph locale');
has(english.text, '<meta property="og:url" content="https://yuzhi.orangely.xyz/en/">', 'English Open Graph URL');
has(english.text, '<meta property="og:image" content="https://yuzhi.orangely.xyz/brand/yuzhi-og-en.png">', 'English Open Graph image');
has(english.text, '<meta property="og:image:type" content="image/png">', 'English Open Graph image type');
has(english.text, '<meta name="twitter:image" content="https://yuzhi.orangely.xyz/brand/yuzhi-og-en.png">', 'English Twitter image');
has(english.text, '<link rel="canonical" href="https://yuzhi.orangely.xyz/en/">', 'English canonical');
has(english.text, '<link rel="manifest" href="/site-en.webmanifest">', 'English manifest');
has(english.text, '"inLanguage":"en"', 'English structured data');
has(english.text, '"url":"https://yuzhi.orangely.xyz/en/"', 'English structured-data URL');

const chinese = await fetchText('/');
assert(
  chinese.response.headers.get('x-yuzhi-locale-metadata') === 'zh-CN',
  'Chinese root HTML bypassed the shared locale metadata rewriter',
);
has(chinese.text, '<html lang="zh-CN">', 'Chinese document language');
has(chinese.text, '<link rel="canonical" href="https://yuzhi.orangely.xyz/">', 'Chinese canonical');
has(chinese.text, '<link rel="manifest" href="/site.webmanifest">', 'Chinese manifest');
has(chinese.text, '<meta property="og:image" content="https://yuzhi.orangely.xyz/brand/yuzhi-og.jpg">', 'Chinese Open Graph image');
has(chinese.text, '<meta property="og:image:type" content="image/jpeg">', 'Chinese Open Graph image type');
has(chinese.text, '<meta name="twitter:image" content="https://yuzhi.orangely.xyz/brand/yuzhi-og.jpg">', 'Chinese Twitter image');
assert(!chinese.text.includes('<meta property="og:locale" content="en_US">'), 'root HTML was unexpectedly rewritten as English');

const [zhManifestResponse, enManifestResponse, zhImageResponse, enImageResponse, revisionResponse] = await Promise.all([
  fetch(baseURL + '/site.webmanifest'),
  fetch(baseURL + '/site-en.webmanifest'),
  fetch(baseURL + '/brand/yuzhi-og.jpg'),
  fetch(baseURL + '/brand/yuzhi-og-en.png'),
  fetch(baseURL + '/__yuzhi-build/revision.json'),
]);
assert(zhManifestResponse.ok && enManifestResponse.ok, 'locale manifests must both be served');
assert(revisionResponse.ok, 'build revision marker must be served with static assets');
const revisionMetadata = await revisionResponse.json();
assert(
  /^[0-9a-f]{40}$/.test(revisionMetadata.revision),
  `invalid build revision marker: ${JSON.stringify(revisionMetadata)}`,
);
assert(
  zhImageResponse.ok
    && enImageResponse.ok
    && zhImageResponse.headers.get('content-type')?.includes('image/jpeg')
    && enImageResponse.headers.get('content-type')?.includes('image/png'),
  'localized social images must both be served with their declared media types',
);
const [zhManifest, enManifest] = await Promise.all([
  zhManifestResponse.json(),
  enManifestResponse.json(),
]);
assert(zhManifest.id === '/' && enManifest.id === '/', 'locale manifests must share the stable root PWA id');
assert(zhManifest.start_url === '/' && enManifest.start_url === '/en/', 'locale manifests lost their locale-specific launch URLs');

console.log('[worker-locale] raw Worker metadata and shared PWA identity passed');
