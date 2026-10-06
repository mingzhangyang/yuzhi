/**
 * English rollout regression smoke.
 *
 * Covers browser-language selection, visible language switching, stable locale
 * URLs, persistence precedence, and runtime SEO metadata.
 */
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const timeout = 20_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForApp(page) {
  await page.waitForFunction(() => Boolean(window.yuzhi?.store), undefined, { timeout });
}

async function dismissWelcomeIfOpen(page) {
  if (!(await page.locator('#mdl').isVisible())) return;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('mdl')?.hidden === true, undefined, { timeout });
}

const browser = await chromium.launch({ channel: channel || undefined, headless: true });

try {
  const english = await browser.newContext({ locale: 'en-US' });
  try {
    const page = await english.newPage();
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await dismissWelcomeIfOpen(page);

    const initial = await page.evaluate(() => ({
      path: location.pathname,
      lang: document.documentElement.lang,
      title: document.title,
      newText: document.getElementById('newBtn')?.textContent,
      switchText: document.getElementById('langBtn')?.textContent,
      switchHidden: document.getElementById('langBtn')?.hidden,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      ogLocale: document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      ogImageType: document.querySelector('meta[property="og:image:type"]')?.getAttribute('content'),
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
      structured: JSON.parse(document.getElementById('appStructuredData')?.textContent ?? '{}'),
    }));

    assert(initial.path === '/en/', `English browser did not receive stable /en/ URL: ${JSON.stringify(initial)}`);
    assert(initial.lang === 'en' && initial.title.startsWith('Yuzhi |'), `English document metadata missing: ${JSON.stringify(initial)}`);
    assert(initial.newText === '+ New' && initial.switchText === '中文' && initial.switchHidden === false,
      `English shell or language switch not exposed: ${JSON.stringify(initial)}`);
    assert(initial.canonical === 'https://yuzhi.orangely.xyz/en/' && initial.manifest === '/site-en.webmanifest',
      `English canonical/manifest mismatch: ${JSON.stringify(initial)}`);
    assert(
      initial.ogLocale === 'en_US'
        && initial.ogImage === 'https://yuzhi.orangely.xyz/brand/yuzhi-og-en.png'
        && initial.ogImageType === 'image/png'
        && initial.twitterImage === 'https://yuzhi.orangely.xyz/brand/yuzhi-og-en.png'
        && initial.structured.inLanguage === 'en'
        && initial.structured.image === 'https://yuzhi.orangely.xyz/brand/yuzhi-og-en.png',
      `English social/structured metadata mismatch: ${JSON.stringify(initial)}`,
    );

    await page.locator('#langBtn').click();
    await page.waitForFunction(() => location.pathname === '/' && document.documentElement.lang === 'zh-CN', undefined, { timeout });
    const chineseChoice = await page.evaluate(() => ({
      stored: localStorage.getItem('yuzhi.locale'),
      path: location.pathname,
      switchText: document.getElementById('langBtn')?.textContent,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
      ogImageType: document.querySelector('meta[property="og:image:type"]')?.getAttribute('content'),
      twitterImage: document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
    }));
    assert(chineseChoice.stored === 'zh-CN' && chineseChoice.path === '/' && chineseChoice.switchText === 'EN',
      `explicit Chinese choice did not persist: ${JSON.stringify(chineseChoice)}`);
    assert(
      chineseChoice.canonical === 'https://yuzhi.orangely.xyz/'
        && chineseChoice.ogImage === 'https://yuzhi.orangely.xyz/brand/yuzhi-og.jpg'
        && chineseChoice.ogImageType === 'image/jpeg'
        && chineseChoice.twitterImage === 'https://yuzhi.orangely.xyz/brand/yuzhi-og.jpg',
      `Chinese canonical/social metadata did not restore: ${JSON.stringify(chineseChoice)}`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    assert(await page.evaluate(() => document.documentElement.lang) === 'zh-CN',
      'persisted Chinese preference lost to browser auto-detection after reload');

    await page.goto(`${baseURL}/en/`, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const explicitEnglish = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      path: location.pathname,
      stored: localStorage.getItem('yuzhi.locale'),
    }));
    assert(explicitEnglish.lang === 'en' && explicitEnglish.path === '/en/',
      `explicit /en/ route did not win over stored preference: ${JSON.stringify(explicitEnglish)}`);
    assert(explicitEnglish.stored === 'zh-CN',
      `visiting a shared /en/ URL unexpectedly rewrote the user's stored preference: ${JSON.stringify(explicitEnglish)}`);
  } finally {
    await english.close();
  }

  const chinese = await browser.newContext({ locale: 'zh-CN' });
  try {
    const page = await chinese.newPage();
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const state = await page.evaluate(() => ({
      path: location.pathname,
      lang: document.documentElement.lang,
      switchText: document.getElementById('langBtn')?.textContent,
      switchHidden: document.getElementById('langBtn')?.hidden,
    }));
    assert(state.path === '/' && state.lang === 'zh-CN' && state.switchText === 'EN' && state.switchHidden === false,
      `Chinese rollout baseline changed unexpectedly: ${JSON.stringify(state)}`);
  } finally {
    await chinese.close();
  }
} finally {
  await browser.close();
}
