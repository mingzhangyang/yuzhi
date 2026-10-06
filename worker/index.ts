import { handleIcsRequest } from '../shared/icsProxy';
import {
  DEFAULT_LOCALE,
  canonicalUrl,
  localeFromPath,
  localeMetadata,
  socialImageUrl,
  structuredDataForLocale,
  type Locale,
} from '../shared/locale';

interface Env {
  ASSETS: Fetcher;
}

type RewriterHandler = Parameters<HTMLRewriter['on']>[1];

function localizedHtml(response: Response, locale: Locale): Response {
  const meta = localeMetadata[locale];
  const setContent = (value: string): RewriterHandler => ({
    element(element) {
      element.setAttribute('content', value);
    },
  });
  const setHref = (value: string): RewriterHandler => ({
    element(element) {
      element.setAttribute('href', value);
    },
  });

  const rewritten = new HTMLRewriter()
    .on('html', {
      element(element) {
        element.setAttribute('lang', meta.htmlLang);
      },
    })
    .on('title', {
      element(element) {
        element.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', setContent(meta.description))
    .on('meta[name="application-name"]', setContent(meta.applicationName))
    .on('meta[name="apple-mobile-web-app-title"]', setContent(meta.appleTitle))
    .on('meta[property="og:locale"]', setContent(meta.ogLocale))
    .on('meta[property="og:locale:alternate"]', setContent(meta.ogLocaleAlternate))
    .on('meta[property="og:site_name"]', setContent(meta.siteName))
    .on('meta[property="og:title"]', setContent(meta.title))
    .on('meta[property="og:description"]', setContent(meta.socialDescription))
    .on('meta[property="og:url"]', setContent(canonicalUrl(locale)))
    .on('meta[property="og:image"]', setContent(socialImageUrl(locale)))
    .on('meta[property="og:image:type"]', setContent(meta.socialImageType))
    .on('meta[property="og:image:alt"]', setContent(meta.imageAlt))
    .on('meta[name="twitter:title"]', setContent(meta.title))
    .on('meta[name="twitter:description"]', setContent(meta.socialDescription))
    .on('meta[name="twitter:image"]', setContent(socialImageUrl(locale)))
    .on('link[rel="canonical"]', setHref(canonicalUrl(locale)))
    .on('link[rel="manifest"]', setHref(meta.manifestHref))
    .on('#appStructuredData', {
      element(element) {
        element.setInnerContent(JSON.stringify(structuredDataForLocale(locale)));
      },
    })
    .transform(response);

  const headers = new Headers(rewritten.headers);
  headers.set('x-yuzhi-locale-metadata', meta.htmlLang);
  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}

// Cloudflare Worker (with Static Assets): APIs run here; both public locale
// entry routes run Worker-first so raw crawler/social metadata comes from the
// shared locale policy rather than the static HTML fallback.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ics') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
      return handleIcsRequest(request.url);
    }

    const asset = await env.ASSETS.fetch(request);
    const requestedLocale = localeFromPath(url.pathname)
      ?? (url.pathname === '/' ? DEFAULT_LOCALE : null);
    if (!requestedLocale || !asset.headers.get('content-type')?.includes('text/html')) return asset;
    return localizedHtml(asset, requestedLocale);
  },
} satisfies ExportedHandler<Env>;
