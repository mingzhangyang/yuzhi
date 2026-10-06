import { uiEn, uiZh } from './i18n-ui';
import { trackerEn, trackerZh } from './i18n-tracker';
import { islandEn, islandZh } from './i18n-island';
import { errorEn, errorZh } from './i18n-errors';
import { historyEn, historyZh } from './i18n-history';
import {
  DEFAULT_LOCALE,
  canonicalUrl,
  localeFromPath,
  localeMetadata,
  localePath,
  normalizeLocalePreference,
  socialImageUrl,
  structuredDataForLocale,
  type Locale,
} from '../shared/locale';

export type { Locale } from '../shared/locale';

export type MessageVars = Record<string, string | number>;

const zh = {
  'app.title': localeMetadata['zh-CN'].title,
  'language.switch': 'EN',
  'language.switchAria': 'Switch to English',
  'shell.tagline': '一座由现实生活培育出来的岛。你记录 Todo、日程和日记，小岛负责生长、提醒和讲故事。',
  'shell.new': '＋ 新建',
  'shell.calendar': '日历',
  'shell.more': '更多',
  'shell.settle': '晚间结算',
  'shell.settleDay': '结算',
  'shell.catchUp': '补上记录',
  'shell.readOnly': '屿志已在另一个标签页打开；此页暂时只读。',
  'shell.readOnlyUnsupported': '此浏览器不支持安全的多标签页写入协调；为保护本地数据，此页保持只读。',
  'shell.takeOver': '接管写权限',
  'shell.myIsland': '我的小岛',
  'shell.mapDefault': '项目是村落，任务是住在里面的人。',
  'shell.mapAria': '小岛地图：点村落看项目，点小人看 Todo，点培育区看现实行为如何映射，点日程标记看安排，点漂流瓶归类事件，点码头安排新任务；键盘可浏览地图说明',
  'shell.mapKeyboard': '键盘操作：聚焦地图后，按回车或空格开始浏览景物、日程标记和漂流瓶；使用方向键切换；按 Esc 关闭说明。',
  'shell.zoomIn': '放大',
  'shell.zoomOut': '缩小',
  'shell.zoomReset': '复位',
  'shell.mapTip': '点村落、小人或码头看看',
  'shell.chronicle': '编年史',
  'shell.tracker': '追踪栏',
  'shell.how': '小岛如何运转',
  'shell.how1': '屿志不能直接经营。你可以接入外部日历，也可以自己创建日程、Todo 和日记；这些现实输入会自动映射到岛上。项目仍是一座座村落；另外有四个公共培育区：真实推进 Todo 会耕作农田，经过结算的日程会培育果园，认真结算过的日子会让鱼塘恢复生气，写日记的日子会让花园开起来。',
  'shell.how2': '晚上点「晚间结算」，小岛进入黄昏。今天的事件和任务排成一列：右滑是做了，变成一块砖飞进村落；左滑是没做，可以选一个原因；轻点是做了一部分。过去的事不会默认算完成，要你确认。忘了结算的日子，小岛会被海雾笼罩；补上就散。超过 3 天还没结算，自动归档为「未记录」，不产生任何后果。',
  'shell.how3': '村落按距上次真实推进的天数变化：一周没动会安静下来，两周屋顶蒙灰，四周开始有居民搬离，这时小岛会问你：重新启动、缩小规模，还是正式关闭。每有一天真实推进，村落就回退一个阶段——荒了一个月的村落，认真两三天就能恢复热闹。「推到明天」单次无后果，同一件事推 3 次起村落会加重一档；「没精力」不伤害村落，只让粮仓少一点；「不重要了」是好的取舍，不算惩罚。',
  'shell.how4': '一个项目做完时，点「完成项目 · 落成仪式」：小岛暂停，翻开它的一生之书小结——用时、推迟次数、主要卡点、关键转折——然后由你决定它的去处：立为海岸上的地标，或收进山顶灯塔里的档案馆。地标越多，岛会向外长出新的陆地，像年轮。选择以后可以反悔。',
  'shell.how5': '培育区没有浇水、施肥、喂鱼、修剪或收获按钮；它们只是现实事实的 read model。所有数据只存在这个浏览器里（IndexedDB），包括日记和本地日程；可以在「⋯」里导出 / 导入 JSON 备份。完整备份是未加密的 JSON，会包含日记全文及任务、日程等个人记录，请妥善保存。',
  'menu.settings': '工作时段与外观',
  'menu.export': '导出备份（JSON）',
  'menu.import': '导入备份…',
  'menu.archive': '档案馆（山顶的灯塔）',
  'menu.demo': '放几个示例村落',
  'date.today': '今天',
  'date.yesterday': '昨天',
  'date.tomorrow': '明天',
  'date.dayBeforeYesterday': '前天',
  'date.dayAfterTomorrow': '后天',
  'season.spring': '春',
  'season.summer': '夏',
  'season.autumn': '秋',
  'season.winter': '冬',
  'light.day': '白天',
  'light.dusk': '黄昏',
  'light.night': '夜里',
  'weather.clear': '晴',
  'weather.cloudy': '多云',
  'weather.rain': '小雨',
  'weather.snow': '小雪',
  'festival.newyear': '元旦',
  'festival.chunjie': '春节',
  'festival.yuanxiao': '元宵',
  'festival.duanwu': '端午',
  'festival.zhongqiu': '中秋',
  'festival.guoqing': '国庆',
  'festival.christmas': '圣诞',
  'legend.project': '村落 = 项目',
  'legend.todo': '小人 = 没做完的 Todo',
  'legend.dock': '船 = 码头上待安排的 Todo',
  'legend.granary': '粮仓 = 今天的可用时间',
  'legend.fog': '海雾 = 没结算的日子',
  'legend.cultivation': '农田 / 果园 / 鱼塘 / 花园 = 现实生活培育区',
  'legend.agenda': '告示牌、灯和条幅 = 日程此刻层',
  'legend.drift': '漂流瓶 = 待归类日程',
  'map.allDayMore': '，另外 {count} 件',
  'map.weather': '{season}季 · {light} · {weather}{festival}{fog}',
  'map.fogSuffix': ' · 海雾 {count} 天',
  'map.fogTitle': '海雾笼罩着小岛',
  'map.fogBody': '{days}还没结算。补上记录，雾就散了；超过 3 天会自动归档为「未记录」。',
  'map.descActive': '{count} 座村落。Todo、日程、日记和结算会自动培育岛上的四个公共区域。',
  'map.descEmpty': '项目是村落；现实里的 Todo、日程、日记和结算会继续把小岛培育起来。',
  'map.driftReadOnly': '只读标签页无法归类',
  'map.driftClassify': '捞起并归类',
  'common.close': '关闭',
  'chron.empty': '每天结算后，这里会自动多一行。',
  'chron.count': '共 {count} 条',
  'stats.granary': '粮仓',
  'stats.progress': '推进度',
  'stats.backlog': '积压',
  'stats.condition': '状态',
  'stats.hours': '小时',
  'stats.items7d': '件 / 7天',
  'stats.items': '件',
  'stats.workHours': '工作时段 {start}–{end}',
  'stats.scheduledTired': '日历已排 {scheduled} 小时；近 7 天没精力 {count} 次，少排一些',
  'stats.scheduled': '日历已排 {scheduled} 小时（{events} 个事件），共 {hours} 小时',
  'stats.today': '今天 {value}',
  'stats.progressFoot': '近 7 天确认做了的条目，做了一部分算半件',
  'stats.backlogRight': '码头 {dock}　过期 {overdue}',
  'stats.backlogFoot': '码头上待安排的 + 过了日期还没做完的',
  'stats.backlogEmpty': '码头清空，没有过期的事',
  'stats.settled': '{good} / {settled} 条',
  'stats.noSettlements': '还没有结算记录',
  'stats.conditionFoot': '近 7 天已结算条目里，做了和做了一部分的占比',
  'daily.archived': '{days}没有记录，已归档。不算做了，也不算没做。',
  ...historyZh,
  ...uiZh,
  ...trackerZh,
  ...islandZh,
  ...errorZh,
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  'app.title': localeMetadata.en.title,
  'language.switch': '中文',
  'language.switchAria': '切换到中文',
  'shell.tagline': 'An island cultivated by real life. You record todos, schedules, and journals; the island grows, reminds, and tells the story.',
  'shell.new': '+ New',
  'shell.calendar': 'Calendar',
  'shell.more': 'More',
  'shell.settle': 'Evening review',
  'shell.settleDay': 'Review',
  'shell.catchUp': 'Catch up',
  'shell.readOnly': 'Yuzhi is open in another tab; this tab is temporarily read-only.',
  'shell.readOnlyUnsupported': 'This browser cannot safely coordinate editing across tabs, so this tab remains read-only to protect your local data.',
  'shell.takeOver': 'Take over editing',
  'shell.myIsland': 'My island',
  'shell.mapDefault': 'Projects become villages; tasks become the people who live there.',
  'shell.mapAria': 'Island map: select villages for projects, people for todos, cultivation areas for real-life mappings, schedule markers for plans, drift bottles to classify events, or the dock to arrange new tasks. Keyboard navigation is available.',
  'shell.mapKeyboard': 'Keyboard: focus the map, then press Enter or Space to browse scenery, schedule markers, and drift bottles. Use arrow keys to move and Escape to close details.',
  'shell.zoomIn': 'Zoom in',
  'shell.zoomOut': 'Zoom out',
  'shell.zoomReset': 'Reset view',
  'shell.mapTip': 'Select a village, person, or the dock',
  'shell.chronicle': 'Chronicle',
  'shell.tracker': 'Tracker',
  'shell.how': 'How the island works',
  'shell.how1': 'You do not manage Yuzhi directly. Connect an external calendar or create schedules, todos, and journals here; those real-life inputs are projected onto the island. Projects remain villages, while four shared cultivation areas reflect real activity: progressing todos works the field, reviewed schedules grow the orchard, honestly reviewed days revive the pond, and journal days make the garden bloom.',
  'shell.how2': 'In the evening, open the review and the island enters dusk. Today’s events and tasks line up: swipe right for done, left for not done with a reason, or tap for partly done. Past items are never assumed complete; you confirm them. Days you forget to review are covered in sea fog. Catch up and it clears. After more than three days, an unresolved day is archived as unrecorded with no consequence.',
  'shell.how3': 'Villages change with the time since their last real progress: after a week they quiet down, after two weeks roofs gather dust, and after four weeks residents begin to leave. At that point Yuzhi asks whether to restart, reduce scope, or formally close the project. Each day of real progress reverses one stage. A single postpone has no penalty; repeated postponement can deepen decline. No energy does not damage a village, but reduces available time. Not important anymore is treated as a healthy choice, not a punishment.',
  'shell.how4': 'When a project is complete, start its completion ceremony. The island pauses and opens a Life Book summary covering duration, postponements, blockers, and turning points. Then choose its place: a coastal landmark or the lighthouse archive. More landmarks grow new land outward like tree rings. You can change that choice later.',
  'shell.how5': 'Cultivation areas have no water, fertilize, feed, prune, or harvest controls; they are read models of real facts. All data stays in this browser in IndexedDB, including journals and local schedules. Use the More menu to export or import a JSON backup. Full backups are unencrypted and contain journal text plus tasks, schedules, and other personal records, so store them carefully.',
  'menu.settings': 'Work hours & appearance',
  'menu.export': 'Export backup (JSON)',
  'menu.import': 'Import backup…',
  'menu.archive': 'Archive (hilltop lighthouse)',
  'menu.demo': 'Add sample villages',
  'date.today': 'Today',
  'date.yesterday': 'Yesterday',
  'date.tomorrow': 'Tomorrow',
  'date.dayBeforeYesterday': 'Two days ago',
  'date.dayAfterTomorrow': 'In two days',
  'season.spring': 'Spring',
  'season.summer': 'Summer',
  'season.autumn': 'Autumn',
  'season.winter': 'Winter',
  'light.day': 'Day',
  'light.dusk': 'Dusk',
  'light.night': 'Night',
  'weather.clear': 'Clear',
  'weather.cloudy': 'Cloudy',
  'weather.rain': 'Light rain',
  'weather.snow': 'Light snow',
  'festival.newyear': 'New Year',
  'festival.chunjie': 'Lunar New Year',
  'festival.yuanxiao': 'Lantern Festival',
  'festival.duanwu': 'Dragon Boat Festival',
  'festival.zhongqiu': 'Mid-Autumn Festival',
  'festival.guoqing': 'National Day',
  'festival.christmas': 'Christmas',
  'legend.project': 'Village = project',
  'legend.todo': 'Person = unfinished todo',
  'legend.dock': 'Boat = unscheduled todo at the dock',
  'legend.granary': 'Granary = today’s available time',
  'legend.fog': 'Sea fog = days not reviewed',
  'legend.cultivation': 'Field / orchard / pond / garden = real-life cultivation',
  'legend.agenda': 'Signs, lamps, and banners = what is happening now',
  'legend.drift': 'Drift bottle = schedule item to classify',
  'map.allDayMore': ', plus {count} more',
  'map.weather': '{season} · {light} · {weather}{festival}{fog}',
  'map.fogSuffix': ' · Sea fog {count}d',
  'map.fogTitle': 'Sea fog covers the island',
  'map.fogBody': 'Pending review: {days}. Catch up to clear the fog; after three days they are archived as unrecorded.',
  'map.descActive': '{count} {count|village|villages}. Todos, schedules, journals, and daily reviews cultivate the island’s four shared areas.',
  'map.descEmpty': 'Projects become villages; real-life todos, schedules, journals, and reviews keep cultivating the island.',
  'map.driftReadOnly': 'Cannot classify in a read-only tab',
  'map.driftClassify': 'Pick up & classify',
  'common.close': 'Close',
  'chron.empty': 'A new line appears here after each daily review.',
  'chron.count': '{count} {count|entry|entries}',
  'stats.granary': 'Granary',
  'stats.progress': 'Progress',
  'stats.backlog': 'Backlog',
  'stats.condition': 'Condition',
  'stats.hours': 'hours',
  'stats.items7d': 'items / 7d',
  'stats.items': 'items',
  'stats.workHours': 'Work hours {start}–{end}',
  'stats.scheduledTired': '{scheduled} {scheduled|hour|hours} scheduled; low energy {count} {count|time|times} in 7 days, so plan less',
  'stats.scheduled': '{scheduled} {scheduled|hour|hours} scheduled ({events} {events|event|events}), {hours} work {hours|hour|hours} total',
  'stats.today': 'Today {value}',
  'stats.progressFoot': 'Confirmed progress in the last 7 days; partial completion counts as half',
  'stats.backlogRight': 'Dock {dock}　Overdue {overdue}',
  'stats.backlogFoot': 'Unscheduled dock items + dated tasks still unfinished',
  'stats.backlogEmpty': 'Dock clear, nothing overdue',
  'stats.settled': '{good} / {settled} {settled|item|items}',
  'stats.noSettlements': 'No review records yet',
  'stats.conditionFoot': 'Share of reviewed items done or partly done in the last 7 days',
  'daily.archived': 'Archived as unrecorded: {days}. These dates count as neither done nor not done.',
  ...historyEn,
  ...uiEn,
  ...trackerEn,
  ...islandEn,
  ...errorEn,
};

const catalog: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zh, en };
const STORAGE_KEY = 'yuzhi.locale';
let locale: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

const pluralRules: Record<Locale, Intl.PluralRules> = {
  'zh-CN': new Intl.PluralRules('zh-CN'),
  en: new Intl.PluralRules('en'),
};

function interpolate(template: string, vars: MessageVars = {}, target: Locale = 'zh-CN'): string {
  const pluralized = template.includes('|')
    ? template.replace(
        /\{([A-Za-z0-9_]+)\|([^{}|]*)\|([^{}|]*)\}/g,
        (whole, name: string, one: string, other: string) => {
          const value = Number(vars[name]);
          return Number.isFinite(value) ? (pluralRules[target].select(value) === 'one' ? one : other) : whole;
        },
      )
    : template;
  return pluralized.replace(/\{([A-Za-z0-9_]+)\}/g, (_whole, name: string) => String(vars[name] ?? ''));
}

export function resolveLocale(preferred?: string | null, languages: readonly string[] = []): Locale {
  for (const candidate of [preferred, ...languages]) {
    const resolved = normalizeLocalePreference(candidate);
    if (resolved) return resolved;
  }
  return DEFAULT_LOCALE;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function browserPathname(): string | null {
  return typeof location === 'undefined' ? null : location.pathname;
}

function syncLocalePath(target: Locale): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const pathname = localePath(target);
  if (location.pathname === pathname) return;
  try {
    history.replaceState(history.state, '', `${pathname}${location.search}${location.hash}`);
  } catch {
    // URL synchronization is a progressive enhancement (for example, it is
    // unavailable on opaque origins used by some test/browser environments).
  }
}

function storedLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function initI18n(
  options: { detectBrowser?: boolean; pathname?: string | null; syncPath?: boolean } = {},
): Locale {
  const pathLocale = localeFromPath(options.pathname ?? browserPathname());
  locale = pathLocale ?? resolveLocale(
    storedLocale(),
    options.detectBrowser === false ? [] : browserLanguages(),
  );
  if (options.syncPath !== false) syncLocalePath(locale);
  applyDocumentTranslations();
  return locale;
}

export function getLocale(): Locale {
  return locale;
}

export function message(target: Locale, key: MessageKey, vars?: MessageVars): string {
  return interpolate(catalog[target][key], vars, target);
}

export function t(key: MessageKey, vars?: MessageVars): string {
  return message(locale, key, vars);
}

export function setLocale(next: Locale, persist = true): void {
  if (next === locale) return;
  locale = next;
  if (persist) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Locale persistence is optional; even accessing storage may be blocked.
    }
  }
  syncLocalePath(locale);
  applyDocumentTranslations();
  for (const listener of listeners) listener();
}

export function toggleLocale(): void {
  setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN');
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setMetaContent(selector: string, value: string): void {
  document.querySelector<HTMLMetaElement>(selector)?.setAttribute('content', value);
}

function setLinkHref(selector: string, value: string): void {
  document.querySelector<HTMLLinkElement>(selector)?.setAttribute('href', value);
}

function applyDocumentMetadata(target: Locale): void {
  const meta = localeMetadata[target];
  document.title = meta.title;
  setMetaContent('meta[name="description"]', meta.description);
  setMetaContent('meta[name="application-name"]', meta.applicationName);
  setMetaContent('meta[name="apple-mobile-web-app-title"]', meta.appleTitle);
  setMetaContent('meta[property="og:locale"]', meta.ogLocale);
  setMetaContent('meta[property="og:locale:alternate"]', meta.ogLocaleAlternate);
  setMetaContent('meta[property="og:site_name"]', meta.siteName);
  setMetaContent('meta[property="og:title"]', meta.title);
  setMetaContent('meta[property="og:description"]', meta.socialDescription);
  setMetaContent('meta[property="og:url"]', canonicalUrl(target));
  setMetaContent('meta[property="og:image"]', socialImageUrl(target));
  setMetaContent('meta[property="og:image:type"]', meta.socialImageType);
  setMetaContent('meta[property="og:image:alt"]', meta.imageAlt);
  setMetaContent('meta[name="twitter:title"]', meta.title);
  setMetaContent('meta[name="twitter:description"]', meta.socialDescription);
  setMetaContent('meta[name="twitter:image"]', socialImageUrl(target));
  setLinkHref('link[rel="canonical"]', canonicalUrl(target));
  setLinkHref('link[rel="manifest"]', meta.manifestHref);
  const structured = document.querySelector<HTMLScriptElement>('#appStructuredData');
  if (structured) structured.textContent = JSON.stringify(structuredDataForLocale(target));
}

export function applyDocumentTranslations(root?: ParentNode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  applyDocumentMetadata(locale);
  const scope = root ?? document;
  scope.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n as MessageKey | undefined;
    if (key && key in catalog[locale]) node.textContent = t(key);
  });
  scope.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((node) => {
    const key = node.dataset.i18nAriaLabel as MessageKey | undefined;
    if (key && key in catalog[locale]) node.setAttribute('aria-label', t(key));
  });
}

function dateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  return [year, month, day];
}

export function formatCalendarDay(date: string, target: Locale = locale): string {
  const [, month, day] = dateParts(date);
  if (target === 'zh-CN') return String(month) + '月' + String(day) + '日';
  const dt = new Date(Date.UTC(2000, month - 1, day));
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dt);
}

export function formatFullDate(date: string, target: Locale = locale): string {
  const [year, month, day] = dateParts(date);
  if (target === 'zh-CN') return String(year) + '年' + String(month) + '月' + String(day) + '日';
  const dt = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dt);
}

export function formatWeekday(date: string, target: Locale = locale): string {
  const [year, month, day] = dateParts(date);
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const zhWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const enWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return target === 'zh-CN' ? zhWeek[index] : enWeek[index];
}

export function seasonName(index: number): string {
  const keys: MessageKey[] = ['season.spring', 'season.summer', 'season.autumn', 'season.winter'];
  return t(keys[index] ?? 'season.spring');
}

export function lightName(value: 'day' | 'dusk' | 'night'): string {
  return t(('light.' + value) as MessageKey);
}

export function weatherName(value: 'clear' | 'cloudy' | 'rain' | 'snow'): string {
  return t(('weather.' + value) as MessageKey);
}

export function festivalName(value: string): string {
  const key = ('festival.' + value) as MessageKey;
  return key in catalog[locale] ? t(key) : value;
}
