/**
 * 点到小岛上的景物（树、山、田、小溪、空地、海）时显示的说明。
 * 纯函数：由景物和当天的天时生成文字，不碰 DOM。
 */
import type { Festival, Weather } from './ambience';
import type { TileType } from './map';
import type { CultivationKind, CultivationLevel } from '../logic/cultivation';
import { festivalName, getLocale, lightName, seasonName, t as tr, weatherName } from '../i18n';

export interface InfoContext {
  season: number;
  /** 当季进度 0–1 */
  progress: number;
  /** 积雪 0–1 */
  cover: number;
  weather: Weather;
  light: 'day' | 'dusk' | 'night';
  hour: number;
  fest: Festival[];
  /** 月相 0–1，0.5 为满月 */
  moon: number;
}

export type InfoTarget =
  | { kind: 'tree'; tree: 'pine' | 'round'; cherry: boolean; forest: boolean }
  | { kind: 'ground'; type: TileType; ring: number; site?: 'village' | 'landmark' }
  | { kind: 'sea' }
  | {
      kind: 'agenda';
      target: string;
      targetName?: string;
      phase: 'allday' | 'later' | 'soon' | 'live' | 'ended';
      title?: string;
      until?: string;
      start?: string;
      /** 定时状态不是互斥的：一场进行中时，另一场仍可能即将开始。 */
      live?: { title: string; end: string }[];
      soon?: { title: string; start: string }[];
      later: number;
      ended: number;
      banners: string[];
    }
  | { kind: 'drift'; title: string }
  | { kind: 'cultivation'; area: CultivationKind; level: CultivationLevel; score: number; summary: string };

export interface MapInfo {
  title: string;
  sub?: string;
  lines: string[];
}

export function moonName(p: number): string {
  if (p < 0.03 || p > 0.97) return tr('island.moon.new');
  if (p < 0.22) return tr('island.moon.waxingCrescent');
  if (p < 0.28) return tr('island.moon.firstQuarter');
  if (p < 0.47) return tr('island.moon.waxingGibbous');
  if (p < 0.53) return tr('island.moon.full');
  if (p < 0.72) return tr('island.moon.waningGibbous');
  if (p < 0.78) return tr('island.moon.lastQuarter');
  return tr('island.moon.waningCrescent');
}

function timeName(c: InfoContext): string {
  if (c.light === 'night') return lightName('night');
  if (c.light === 'dusk') return lightName('dusk');
  if (c.hour >= 5 && c.hour < 8) return tr('island.time.morning');
  return lightName('day');
}

function treeInfo(target: Extract<InfoTarget, { kind: 'tree' }>, c: InfoContext): MapInfo {
  const se = c.season;
  if (target.tree === 'pine') {
    const lines = [tr(c.cover > 0.2 ? 'island.pineSnow' : 'island.pineEvergreen')];
    if (c.fest.includes('christmas')) lines.push(tr('island.pineChristmas'));
    return { title: tr(target.forest ? 'island.pineForest' : 'island.pine'), lines };
  }
  if (target.cherry && se === 0) {
    return {
      title: tr('island.cherry'),
      lines: [tr(c.progress < 0.55 ? 'island.cherryBloom' : 'island.cherryLeaf')],
    };
  }
  const keys = [
    'island.leafSpring',
    'island.leafSummer',
    c.progress < 0.4 ? 'island.leafAutumnEarly' : c.progress < 0.85 ? 'island.leafAutumnPeak' : 'island.leafAutumnLate',
    'island.leafWinter',
  ] as const;
  return { title: tr(target.forest ? 'island.woods' : 'island.broadleaf'), lines: [tr(keys[se] ?? keys[0])] };
}

function groundInfo(target: Extract<InfoTarget, { kind: 'ground' }>, c: InfoContext): MapInfo {
  const se = c.season;
  const snowy = c.cover > 0.5;
  let info: MapInfo;
  if (target.site === 'village') {
    info = { title: tr('island.openGround'), lines: [tr('island.villageSite')] };
  } else if (target.site === 'landmark') {
    info = { title: tr('island.coastSite'), lines: [tr('island.coastSiteBody')] };
  } else {
    switch (target.type) {
      case 'field': {
        const keys = [
          'island.fieldSpring',
          'island.fieldSummer',
          c.progress < 0.5 ? 'island.fieldAutumnEarly' : 'island.fieldAutumnLate',
          snowy ? 'island.fieldWinterSnow' : 'island.fieldWinter',
        ] as const;
        info = { title: tr('island.field'), lines: [tr(keys[se] ?? keys[0])] };
        break;
      }
      case 'water':
        info = {
          title: tr('island.stream'),
          lines: [tr(c.cover > 0.6 ? 'island.streamFrozen' : c.weather === 'rain' ? 'island.streamRain' : 'island.streamFlow')],
        };
        break;
      case 'mountain':
        info = {
          title: tr('island.mountain'),
          lines: [tr(se === 3 ? 'island.mountainSnow' : 'island.mountainPatch'), tr('island.mountainArchive')],
        };
        break;
      case 'sand':
        info = { title: tr('island.beach'), lines: [tr('island.beachBody')] };
        break;
      case 'plaza':
        info = { title: tr('island.openGround'), lines: [tr('island.flatGround')] };
        break;
      default: {
        const keys = [
          'island.grassSpring',
          'island.grassSummer',
          'island.grassAutumn',
          snowy ? 'island.grassWinterSnow' : 'island.grassWinter',
        ] as const;
        info = {
          title: tr(target.type === 'forest' ? 'island.forestClearing' : 'island.grass'),
          lines: [tr(keys[se] ?? keys[0])],
        };
      }
    }
  }
  if (target.ring > 0) info.lines.push(tr('island.newRing', { ring: target.ring }));
  return info;
}

function seaInfo(c: InfoContext): MapInfo {
  const lines = [
    tr('island.seaSummary', { season: seasonName(c.season), time: timeName(c), weather: weatherName(c.weather) }),
  ];
  lines.push(
    tr('island.moonLine', {
      moon: moonName(c.moon),
      reflection: c.light !== 'day' && c.weather !== 'rain' && c.weather !== 'snow' ? tr('island.moonReflection') : '',
    }),
  );
  if (c.fest.length) {
    const separator = getLocale() === 'zh-CN' ? '、' : ', ';
    lines.push(tr('island.festivalLine', { festivals: c.fest.map((festival) => festivalName(festival)).join(separator) }));
  }
  lines.push(tr('island.ambienceBody'));
  return { title: tr('island.sea'), sub: tr('island.islandTime'), lines };
}

function timeOf(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const d = new Date(stamp);
  if (!Number.isFinite(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function agendaInfo(target: Extract<InfoTarget, { kind: 'agenda' }>): MapInfo {
  const chores = target.target === '__chores__';
  const name = target.targetName ?? (chores ? tr('common.chores') : tr('island.projectSchedule'));
  const consequence = tr(chores ? 'island.choresConsequence' : 'island.projectConsequence');
  const lines: string[] = [];
  const live = target.live?.[0] ?? (target.phase === 'live' ? { title: target.title ?? name, end: target.until ?? '' } : undefined);
  const soon = target.soon?.[0] ?? (target.phase === 'soon' ? { title: target.title ?? name, start: target.start ?? '' } : undefined);
  if (live) {
    const end = timeOf(live.end);
    lines.push(tr('island.live', { title: live.title, until: end ? tr('island.until', { time: end }) : '' }));
    lines.push(consequence);
  }
  if (soon) {
    const start = timeOf(soon.start);
    lines.push(tr('island.soon', { title: soon.title, start: start ? tr('island.startsAt', { time: start }) : '' }));
    lines.push(tr('island.reminderOnly'));
  }
  if (target.later) {
    lines.push(tr('island.laterSchedules', { name, count: target.later }));
    if (!live && !soon) lines.push(tr('island.signOnly'));
  }
  if (target.ended) {
    lines.push(tr('island.endedSchedules', { name, count: target.ended }));
    if (!live) lines.push(tr(chores ? 'island.choresEndedConsequence' : 'island.projectEndedConsequence'));
  }
  if (target.banners.length) {
    const separator = getLocale() === 'zh-CN' ? '、' : ', ';
    const extra = target.banners.length > 2 ? tr('island.bannerExtra', { count: target.banners.length - 2 }) : '';
    lines.push(tr('island.allDay', { titles: target.banners.slice(0, 2).join(separator), extra }));
  }
  return { title: name, sub: tr('island.scheduleNow'), lines };
}

const CULTIVATION_NAME_KEYS = {
  field: 'cultivation.field',
  orchard: 'cultivation.orchard',
  pond: 'cultivation.pond',
  garden: 'cultivation.garden',
} as const;

const CULTIVATION_SOURCE_KEYS = {
  field: 'island.cultivationFieldSource',
  orchard: 'island.cultivationOrchardSource',
  pond: 'island.cultivationPondSource',
  garden: 'island.cultivationGardenSource',
} as const;

function cultivationInfo(target: Extract<InfoTarget, { kind: 'cultivation' }>): MapInfo {
  return {
    title: tr(CULTIVATION_NAME_KEYS[target.area]),
    sub: tr('island.cultivationSub', { level: target.level }),
    lines: [
      target.summary,
      tr(CULTIVATION_SOURCE_KEYS[target.area]),
      tr('island.cultivationNoDirect'),
    ],
  };
}

function driftInfo(target: Extract<InfoTarget, { kind: 'drift' }>): MapInfo {
  return {
    title: tr('island.driftBottle'),
    sub: target.title,
    lines: [tr('island.driftBody')],
  };
}

export function describe(target: InfoTarget, c: InfoContext): MapInfo {
  if (target.kind === 'tree') return treeInfo(target, c);
  if (target.kind === 'ground') return groundInfo(target, c);
  if (target.kind === 'agenda') return agendaInfo(target);
  if (target.kind === 'drift') return driftInfo(target);
  if (target.kind === 'cultivation') return cultivationInfo(target);
  return seaInfo(c);
}
