export type Locale = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const SITE_ORIGIN = 'https://yuzhi.orangely.xyz';

export interface LocaleMetadata {
  htmlLang: string;
  title: string;
  description: string;
  applicationName: string;
  appleTitle: string;
  ogLocale: string;
  ogLocaleAlternate: string;
  siteName: string;
  socialDescription: string;
  imageAlt: string;
  socialImagePath: string;
  socialImageType: string;
  manifestHref: string;
}

export const localeMetadata: Record<Locale, LocaleMetadata> = {
  'zh-CN': {
    htmlLang: 'zh-CN',
    title: '屿志 Yuzhi｜把日记、待办与日程种成一座小岛',
    description: '屿志是一款把日记、待办和日程映射成会生长的小岛的个人记录应用。真实生活中的推进、结算与书写，会持续改变你的岛屿。',
    applicationName: '屿志 Yuzhi',
    appleTitle: '屿志',
    ogLocale: 'zh_CN',
    ogLocaleAlternate: 'en_US',
    siteName: '屿志 Yuzhi',
    socialDescription: '把日记、待办与日程，种成一座会生长的小岛。',
    imageAlt: '屿志 Yuzhi：把日记、待办与日程，种成一座会生长的小岛',
    socialImagePath: '/brand/yuzhi-og.jpg',
    socialImageType: 'image/jpeg',
    manifestHref: '/site.webmanifest',
  },
  en: {
    htmlLang: 'en',
    title: 'Yuzhi | Grow an island from your real life',
    description: 'Yuzhi is a personal journal, Todo, and calendar app that turns real-life progress, daily review, and reflection into a growing island.',
    applicationName: 'Yuzhi',
    appleTitle: 'Yuzhi',
    ogLocale: 'en_US',
    ogLocaleAlternate: 'zh_CN',
    siteName: 'Yuzhi',
    socialDescription: 'Turn your journal, Todos, and schedule into a living island shaped by your real life.',
    imageAlt: 'Yuzhi: turn your journal, Todos, and schedule into a growing island',
    socialImagePath: '/brand/yuzhi-og-en.png',
    socialImageType: 'image/png',
    manifestHref: '/site-en.webmanifest',
  },
};

export function normalizeLocalePreference(value?: string | null): Locale | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  return null;
}

export function localeFromPath(pathname?: string | null): Locale | null {
  if (!pathname) return null;
  const normalized = pathname.toLowerCase();
  return normalized === '/en' || normalized.startsWith('/en/') ? 'en' : null;
}

export function localePath(locale: Locale): string {
  return locale === 'en' ? '/en/' : '/';
}

export function canonicalUrl(locale: Locale): string {
  return `${SITE_ORIGIN}${localePath(locale)}`;
}

export function socialImageUrl(locale: Locale): string {
  return `${SITE_ORIGIN}${localeMetadata[locale].socialImagePath}`;
}

export function structuredDataForLocale(locale: Locale): Record<string, unknown> {
  const meta = localeMetadata[locale];
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: locale === 'en' ? 'Yuzhi' : '屿志',
    alternateName: locale === 'en' ? '屿志' : 'Yuzhi',
    url: canonicalUrl(locale),
    description: meta.socialDescription,
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'Web',
    inLanguage: meta.htmlLang,
    image: socialImageUrl(locale),
  };
}
