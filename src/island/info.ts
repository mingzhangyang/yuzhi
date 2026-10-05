/**
 * 点到小岛上的景物（树、山、田、小溪、空地、海）时显示的说明。
 * 纯函数：由景物和当天的天时生成文字，不碰 DOM。
 */
import { FESTIVAL_NAMES, type Festival, type Weather } from './ambience';
import type { TileType } from './map';
import type { CultivationKind, CultivationLevel } from '../logic/cultivation';

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

const SEASON = ['春', '夏', '秋', '冬'];
const SKY: Record<Weather, string> = { clear: '晴', cloudy: '多云', rain: '小雨', snow: '小雪' };

export function moonName(p: number): string {
  if (p < 0.03 || p > 0.97) return '新月';
  if (p < 0.22) return '蛾眉月';
  if (p < 0.28) return '上弦月';
  if (p < 0.47) return '盈凸月';
  if (p < 0.53) return '满月';
  if (p < 0.72) return '亏凸月';
  if (p < 0.78) return '下弦月';
  return '残月';
}

function timeName(c: InfoContext): string {
  if (c.light === 'night') return '夜里';
  if (c.light === 'dusk') return '黄昏';
  if (c.hour >= 5 && c.hour < 8) return '清晨';
  return '白天';
}

function treeInfo(t: Extract<InfoTarget, { kind: 'tree' }>, c: InfoContext): MapInfo {
  const se = c.season;
  if (t.tree === 'pine') {
    const lines = [c.cover > 0.2 ? '枝头压着雪，一年四季都是绿的。' : '一年四季都是绿的。'];
    if (c.fest.includes('christmas')) lines.push('圣诞节，松枝上挂起了彩灯。');
    return { title: t.forest ? '松林' : '松树', lines };
  }
  if (t.cherry && se === 0) {
    return { title: '樱花树', lines: [c.progress < 0.55 ? '樱花正开，风一吹就落下一阵花瓣。' : '花期过了，长出了新叶。'] };
  }
  const line = [
    '新叶刚长出来。',
    '枝叶正茂，树荫很密。',
    c.progress < 0.4 ? '叶子开始变黄。' : c.progress < 0.85 ? '满树红叶，落叶铺了一地。' : '叶子快落光了。',
    '叶子落光了，等着春天发芽。',
  ][se];
  return { title: t.forest ? '树林' : '阔叶树', lines: [line] };
}

function groundInfo(t: Extract<InfoTarget, { kind: 'ground' }>, c: InfoContext): MapInfo {
  const se = c.season;
  const snowy = c.cover > 0.5;
  let info: MapInfo;
  if (t.site === 'village') {
    info = { title: '空地', lines: ['这里留着一座村落的位置。新建一个项目，这里就会长出一座村落。'] };
  } else if (t.site === 'landmark') {
    info = { title: '海岸空地', lines: ['项目落成后可以在这里立一座地标。地标越多，小岛会向外长出新的一圈陆地。'] };
  } else {
    switch (t.type) {
      case 'field':
        info = {
          title: '田',
          lines: [
            [
              '刚出苗，一行行整整齐齐。',
              '庄稼正在长高。',
              c.progress < 0.5 ? '稻穗金黄，快到收割的时候了。' : '已经收割，田里堆着草垛。',
              snowy ? '田地休耕，盖着一层雪。' : '田地休耕，等开春再种。',
            ][se],
          ],
        };
        break;
      case 'water':
        info = { title: '小溪', lines: [c.cover > 0.6 ? '溪面结了冰。' : c.weather === 'rain' ? '下着雨，溪水涨了一些。' : '从山脚流下来，一路向西南。'] };
        break;
      case 'mountain':
        info = {
          title: '山',
          lines: [se === 3 ? '山上积着厚厚的雪。' : '山尖有一点残雪。', '山顶的灯塔是档案馆，点它可以翻看落成和关闭的项目。'],
        };
        break;
      case 'sand':
        info = { title: '沙滩', lines: ['码头边的沙滩。没有归属村落的新任务，会先乘船停在码头。'] };
        break;
      case 'plaza':
        info = { title: '空地', lines: ['一块平整的空地。'] };
        break;
      default:
        info = {
          title: t.type === 'forest' ? '林间空地' : '草地',
          lines: [['开着零星的野花。', '草长得正高。', '草色转黄，落了些叶子。', snowy ? '盖着一层雪。' : '草色枯黄。'][se]],
        };
    }
  }
  if (t.ring > 0) info.lines.push(`这里是后来长出的新陆地（第 ${t.ring} 圈年轮）。`);
  return info;
}

function seaInfo(c: InfoContext): MapInfo {
  const lines = [`${SEASON[c.season]}季 · ${timeName(c)} · ${SKY[c.weather]}`];
  lines.push(`月相：${moonName(c.moon)}${c.light !== 'day' && c.weather !== 'rain' && c.weather !== 'snow' ? '，倒映在海面上' : ''}`);
  if (c.fest.length) lines.push(`今天是${c.fest.map((f) => FESTIVAL_NAMES[f]).join('、')}。`);
  lines.push('光线随现实的时刻变化，天气每天不同，季节跟着日期走。');
  return { title: '海', sub: '小岛的天时', lines };
}

function timeOf(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const d = new Date(stamp);
  if (!Number.isFinite(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function agendaInfo(t: Extract<InfoTarget, { kind: 'agenda' }>): MapInfo {
  const chores = t.target === 'chores';
  const name = t.targetName ?? (chores ? '杂务' : '项目日程');
  const consequence = chores
    ? '结算时确认做了，才会计入柴堆。'
    : '结算时确认做了，才会烧成一块砖。';
  const lines: string[] = [];
  const live = t.live?.[0] ?? (t.phase === 'live' ? { title: t.title ?? name, end: t.until ?? '' } : undefined);
  const soon = t.soon?.[0] ?? (t.phase === 'soon' ? { title: t.title ?? name, start: t.start ?? '' } : undefined);
  if (live) {
    lines.push(`「${live.title}」进行中${timeOf(live.end) ? `，到 ${timeOf(live.end)}` : ''}。`);
    lines.push(consequence);
  }
  if (soon) {
    lines.push(`「${soon.title}」即将开始${timeOf(soon.start) ? `，${timeOf(soon.start)} 开始` : ''}。`);
    lines.push('这是此刻的提醒，还没有产生任何后果。');
  }
  // 稍后和待结算互不遮挡：同时有的话两句都写
  if (t.later) {
    lines.push(`${name}今天稍后还有 ${t.later} 场日程。`);
    if (!live && !soon) lines.push('告示牌只表示安排，不表示已经完成。');
  }
  if (t.ended) {
    lines.push(`${name}今天有 ${t.ended} 场已经结束，等待晚间结算。`);
    if (!live) {
      lines.push(chores
        ? '结算时确认做了，才会计入柴堆；没做不会提前改变杂务小屋。'
        : '结算时确认做了，才会留下砖；没做不会提前改变村落。');
    }
  }
  if (t.banners.length) {
    const extra = t.banners.length > 2 ? `，另外 ${t.banners.length - 2} 件` : '';
    lines.push(`今天全天：${t.banners.slice(0, 2).join('、')}${extra}。全天事件不需要结算，也不影响村落。`);
  }
  return { title: name, sub: '日程 · 此刻层', lines };
}

const CULTIVATION_NAMES: Record<CultivationKind, string> = {
  field: '农田',
  orchard: '果园',
  pond: '鱼塘',
  garden: '花园',
};

const CULTIVATION_SOURCES: Record<CultivationKind, string> = {
  field: 'Todo / 任务的真实推进会培育这里。',
  orchard: '只有经过晚间结算的定时日程才会培育这里；未来安排和仅仅创建的日程不会直接加分。',
  pond: '认真结算过的一天会让这里恢复生气；“没做”也可以是诚实记录。',
  garden: '写下日记的日子会培育这里；一天写很多篇也不会重复加速。',
};

function cultivationInfo(t: Extract<InfoTarget, { kind: 'cultivation' }>): MapInfo {
  return {
    title: CULTIVATION_NAMES[t.area],
    sub: `培育区 · 长势 ${t.level}/4`,
    lines: [
      t.summary,
      CULTIVATION_SOURCES[t.area],
      '这里不能直接经营。继续过真实生活，小岛会根据事实自己变化。',
    ],
  };
}

function driftInfo(t: Extract<InfoTarget, { kind: 'drift' }>): MapInfo {
  return {
    title: '漂流瓶',
    sub: t.title,
    lines: ['这组日历事件还没有归类。捞起后会打开归类对话框；归类不会替你完成结算。'],
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
