/**
 * Production acceptance for the deployed Yuzhi origin.
 *
 * Cloudflare deploys main independently from PR CI, so this validates the
 * public origin after deployment rather than treating local preview as proof.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = (process.env.BASE_URL ?? 'https://yuzhi.orangely.xyz').replace(/\/+$/, '');
const expectedOrigin = process.env.EXPECTED_ORIGIN ?? 'https://yuzhi.orangely.xyz';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const shotDir = process.env.SHOT_DIR;
const timeout = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function has(text, fragment, label) {
  assert(text.includes(fragment), `missing ${label}: ${fragment}`);
}
async function getText(path, accept = 'text/html') {
  const response = await fetch(baseURL + path, { headers: { accept }, redirect: 'error' });
  const text = await response.text();
  assert(response.ok, `${path} returned ${response.status}: ${text.slice(0, 240)}`);
  return text;
}
async function checkImage(path, mediaType, minBytes) {
  const response = await fetch(baseURL + path, { redirect: 'error' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(response.ok, `${path} returned ${response.status}`);
  assert(response.headers.get('content-type')?.includes(mediaType),
    `${path} has unexpected content type: ${response.headers.get('content-type')}`);
  assert(bytes.byteLength >= minBytes, `${path} is unexpectedly small: ${bytes.byteLength} bytes`);
}
async function dismissWelcome(page) {
  if (!(await page.locator('#mdl').isVisible())) return;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('mdl')?.hidden === true, undefined, { timeout });
}
async function shot(page, name) {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, name), fullPage: true });
}

const [zh, en, robots, sitemap, zhManifestResponse, enManifestResponse] = await Promise.all([
  getText('/'),
  getText('/en/'),
  getText('/robots.txt', 'text/plain'),
  getText('/sitemap.xml', 'application/xml'),
  fetch(baseURL + '/site.webmanifest', { redirect: 'error' }),
  fetch(baseURL + '/site-en.webmanifest', { redirect: 'error' }),
]);

has(zh, '<html lang="zh-CN">', 'Chinese document language');
has(zh, `<link rel="canonical" href="${expectedOrigin}/">`, 'Chinese canonical');
has(zh, `<link rel="alternate" hreflang="en" href="${expectedOrigin}/en/">`, 'Chinese English hreflang');
has(zh, '<meta property="og:locale" content="zh_CN">', 'Chinese Open Graph locale');
has(zh, `<meta property="og:image" content="${expectedOrigin}/brand/yuzhi-og.jpg">`, 'Chinese Open Graph image');
has(zh, '<meta property="og:image:type" content="image/jpeg">', 'Chinese Open Graph image type');
has(zh, `<meta name="twitter:image" content="${expectedOrigin}/brand/yuzhi-og.jpg">`, 'Chinese Twitter image');
has(zh, '<link rel="manifest" href="/site.webmanifest">', 'Chinese manifest');

has(en, '<html lang="en">', 'English document language');
has(en, '<title>Yuzhi | Grow an island from your real life</title>', 'English title');
has(en, `<link rel="canonical" href="${expectedOrigin}/en/">`, 'English canonical');
has(en, `<link rel="alternate" hreflang="zh-CN" href="${expectedOrigin}/">`, 'English Chinese hreflang');
has(en, '<meta property="og:locale" content="en_US">', 'English Open Graph locale');
has(en, `<meta property="og:image" content="${expectedOrigin}/brand/yuzhi-og-en.png">`, 'English Open Graph image');
has(en, '<meta property="og:image:type" content="image/png">', 'English Open Graph image type');
has(en, `<meta name="twitter:image" content="${expectedOrigin}/brand/yuzhi-og-en.png">`, 'English Twitter image');
has(en, '<link rel="manifest" href="/site-en.webmanifest">', 'English manifest');
has(en, `"image":"${expectedOrigin}/brand/yuzhi-og-en.png"`, 'English structured-data image');

has(robots, `Sitemap: ${expectedOrigin}/sitemap.xml`, 'robots sitemap');
has(sitemap, `<loc>${expectedOrigin}/</loc>`, 'Chinese sitemap URL');
has(sitemap, `<loc>${expectedOrigin}/en/</loc>`, 'English sitemap URL');
has(sitemap, 'hreflang="zh-CN"', 'Chinese sitemap hreflang');
has(sitemap, 'hreflang="en"', 'English sitemap hreflang');

assert(zhManifestResponse.ok && enManifestResponse.ok, 'both locale manifests must be available');
const [zhManifest, enManifest] = await Promise.all([zhManifestResponse.json(), enManifestResponse.json()]);
assert(
  zhManifest.id === '/'
    && enManifest.id === '/'
    && zhManifest.lang === 'zh-CN'
    && enManifest.lang === 'en'
    && zhManifest.start_url === '/'
    && enManifest.start_url === '/en/',
  `manifest locale contract changed: ${JSON.stringify({ zhManifest, enManifest })}`,
);

await Promise.all([
  checkImage('/brand/yuzhi-og.jpg', 'image/jpeg', 5_000),
  checkImage('/brand/yuzhi-og-en.png', 'image/png', 20_000),
]);

const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  const mobile = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await mobile.newPage();
    await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.yuzhi?.store), undefined, { timeout });
    await dismissWelcome(page);

    const initial = await page.evaluate(() => ({
      path: location.pathname,
      lang: document.documentElement.lang,
      switchText: document.getElementById('langBtn')?.textContent,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      ogImageType: document.querySelector('meta[property="og:image:type"]')?.getAttribute('content'),
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert(
      initial.path === '/en/'
        && initial.lang === 'en'
        && initial.switchText === '中文'
        && initial.canonical === expectedOrigin + '/en/'
        && initial.ogImage === expectedOrigin + '/brand/yuzhi-og-en.png'
        && initial.ogImageType === 'image/png'
        && initial.twitterImage === expectedOrigin + '/brand/yuzhi-og-en.png',
      `English production bootstrap mismatch: ${JSON.stringify(initial)}`,
    );
    assert(initial.scrollWidth <= initial.innerWidth + 1,
      `English mobile shell overflows horizontally: ${JSON.stringify(initial)}`);
    await shot(page, 'en-mobile.png');

    await page.locator('#langBtn').click();
    await page.waitForFunction(() => location.pathname === '/' && document.documentElement.lang === 'zh-CN', undefined, { timeout });
    const chinese = await page.evaluate(() => ({
      stored: localStorage.getItem('yuzhi.locale'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      ogImageType: document.querySelector('meta[property="og:image:type"]')?.getAttribute('content'),
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
    }));
    assert(
      chinese.stored === 'zh-CN'
        && chinese.canonical === expectedOrigin + '/'
        && chinese.ogImage === expectedOrigin + '/brand/yuzhi-og.jpg'
        && chinese.ogImageType === 'image/jpeg'
        && chinese.twitterImage === expectedOrigin + '/brand/yuzhi-og.jpg',
      `Chinese production switch mismatch: ${JSON.stringify(chinese)}`,
    );
    await shot(page, 'zh-mobile.png');

    await page.goto(baseURL + '/en/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.yuzhi?.store), undefined, { timeout });
    const explicitEnglish = await page.evaluate(() => ({
      path: location.pathname,
      lang: document.documentElement.lang,
      stored: localStorage.getItem('yuzhi.locale'),
    }));
    assert(
      explicitEnglish.path === '/en/'
        && explicitEnglish.lang === 'en'
        && explicitEnglish.stored === 'zh-CN',
      `explicit English URL lost precedence or rewrote preference: ${JSON.stringify(explicitEnglish)}`,
    );
  } finally {
    await mobile.close();
  }

  const desktop = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  try {
    const page = await desktop.newPage();
    await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.yuzhi?.store), undefined, { timeout });
    await dismissWelcome(page);
    const state = await page.evaluate(() => ({
      path: location.pathname,
      lang: document.documentElement.lang,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert(state.path === '/' && state.lang === 'zh-CN',
      `Chinese desktop bootstrap mismatch: ${JSON.stringify(state)}`);
    assert(state.scrollWidth <= state.innerWidth + 1,
      `Chinese desktop shell overflows: ${JSON.stringify(state)}`);
    await shot(page, 'zh-desktop.png');
  } finally {
    await desktop.close();
  }
} finally {
  await browser.close();
}

console.log('[production-acceptance] deployed locale, metadata, assets, and viewport contract passed');
