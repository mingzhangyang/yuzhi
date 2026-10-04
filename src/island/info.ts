/**
 * 点到小岛上的景物（树、山、田、小溪、空地、海）时显示的说明。
 * 纯函数：由景物和当天的天时生成文字，不碰 DOM。
 */
import { FESTIVAL_NAMES, type Festival, type Weather } from './ambience';
import type { TileType } from './map';

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
  | { kind: 'sea' };

export interface MapInfo {
  title: string;
  sub?: string;
  lines: string[];
}

const SEASON = ['春', '夏', '秋', '冬'];
const SKY: Record<Weather, string> = { clear: '晴', cloudy: '多云', rain: '小雨', snow: '小雪' };

export function moonName(p: number): string {
  if (p < 0.03 || p > 0.97) return '新月';
  if (p < 0.22) return '峨眉月';
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

export function describe(target: InfoTarget, c: InfoContext): MapInfo {
  if (target.kind === 'tree') return treeInfo(target, c);
  if (target.kind === 'ground') return groundInfo(target, c);
  return seaInfo(c);
}
