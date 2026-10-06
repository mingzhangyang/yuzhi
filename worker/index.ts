import { handleIcsRequest } from '../shared/icsProxy';
import {
  canonicalUrl,
  localeFromPath,
  localeMetadata,
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

  return new HTMLRewriter()
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
    .on('meta[property="og:image:alt"]', setContent(meta.imageAlt))
    .on('meta[name="twitter:title"]', setContent(meta.title))
    .on('meta[name="twitter:description"]', setContent(meta.socialDescription))
    .on('link[rel="canonical"]', setHref(canonicalUrl(locale)))
    .on('link[rel="manifest"]', setHref(meta.manifestHref))
    .on('#appStructuredData', {
      element(element) {
        element.setInnerContent(JSON.stringify(structuredDataForLocale(locale)));
      },
    })
    .transform(response);
}

// Cloudflare Worker (with Static Assets): APIs run here; the English route also
// runs Worker-first so crawlers/social previews receive localized head metadata.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ics') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
      return handleIcsRequest(request.url);
    }

    const asset = await env.ASSETS.fetch(request);
    const requestedLocale = localeFromPath(url.pathname);
    if (requestedLocale !== 'en' || !asset.headers.get('content-type')?.includes('text/html')) return asset;
    return localizedHtml(asset, requestedLocale);
  },
} satisfies ExportedHandler<Env>;
