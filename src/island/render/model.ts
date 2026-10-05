import type { Stage } from '../../logic/config';
import type { ISODate } from '../../types';
import type { Festival, Weather } from '../ambience';
import type { InfoTarget, MapInfo } from '../info';
import type { Tile } from '../map';

export interface WalkerView {
  id: string;
  title: string;
}

export interface VillageView {
  slot: number;
  projectId: string;
  name: string;
  roof: string;
  stage: Stage;
  houses: number;
  walkers: WalkerView[];
  /** 没画出来的任务数 */
  extra: number;
  openCount: number;
  agenda?: AgendaView;
  /** 今天结算为做了 / 做了一部分的日程数；只用于烧窑转场 */
  firedToday?: number;
}

export interface AgendaView {
  /** allday：只有全天条幅，没有任何定时场次 */
  phase: 'allday' | 'later' | 'soon' | 'live' | 'ended';
  title?: string;
  until?: string;
  /** 即将开始那一场的开始时间 */
  start?: string;
  later: number;
  ended: number;
  banners: string[];
  live?: { eventId: string; title: string; end: string }[];
  soon?: { eventId: string; title: string; start: string }[];
}

export interface ChoresView {
  /** 近 7 天结算为做了 / 做了一部分的杂务数 */
  count: number;
  woodpile: 0 | 1 | 2 | 3;
  live?: { title: string; until: string };
  soon?: { title: string; start: string };
  later: number;
  ended: number;
}

export interface LandmarkView {
  projectId: string;
  name: string;
  roof: string;
  /** 地标位编号 */
  index: number;
  /** 规模：由村落当年的房子数决定，1–10 */
  size: number;
}

export type Light = 'day' | 'dusk' | 'night';

export interface Scene {
  season: 0 | 1 | 2 | 3;
  light: Light;
  /** 今天（本地日期），决定天气、节日、季节进度 */
  date: ISODate;
  /** 本地时刻（小时，可带小数），决定光线和月亮 */
  hour: number;
  /** 构建场景时的精确时间戳（毫秒）；钟声冷却按它计算，hour 会丢掉秒 */
  now: number;
  villages: VillageView[];
  dockShips: number;
  /** 兼容旧调用方；新 UI 从 chores.count 读取。 */
  choresCount: number;
  chores: ChoresView;
  drifting: { title: string }[];
  lighthouseBanners: string[];
  granaryBusy: boolean;
  /** 0–1 */
  granaryRatio: number;
  granaryLabel: string;
  /** 0–1 */
  fog: number;
  selected: Selection | null;
  /** 地标越多，岛向外长出的年轮越多 */
  rings: number;
  landmarks: LandmarkView[];
}

export type Selection =
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'dock' }
  | { kind: 'granary' }
  | { kind: 'chores' }
  | { kind: 'archive' };

export type Hit = Selection | { kind: 'agenda'; target: string } | { kind: 'drift'; title: string } | null;

export type SceneryFocus = { i: number; j: number; tree?: [number, number, number] };

export interface SceneryInspection {
  info: MapInfo;
  x: number;
  y: number;
  /** 可从说明卡执行的对象；目前只有漂流瓶需要动作。 */
  target?: Extract<InfoTarget, { kind: 'drift' }>;
}

export interface SceneryCandidate extends SceneryInspection {
  focus: SceneryFocus | null;
}

export interface Walker {
  id: string;
  title: string;
  slot: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  color: string;
  leaving: boolean;
  skin: string;
  hair: string;
  /** 朝向：1 向右，-1 向左 */
  face: number;
  /** 走路的步伐相位 */
  walk: number;
  moving: boolean;
  /** 0–1 的个人随机数：决定帽子之类的小差异 */
  r: number;
}

export interface Drift {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
}

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  /** 还没炸开的火箭 */
  rocket: boolean;
  /** 炸开瞬间的闪光 */
  flash?: boolean;
  burstAt: number;
}

export interface BellRipple {
  at: Tile;
  t: number;
}

export interface StageCue {
  projectId: string;
  from: Stage;
  to: Stage;
  t: number;
}

export interface PickedBottle {
  x: number;
  y: number;
  title: string;
  index: number;
  t: number;
}

export interface Ambience {
  date: string;
  season: number;
  progress: number;
  weather: Weather;
  cover: number;
  fest: Set<Festival>;
  fireworks: boolean;
}

export type Glow = [number, number, number, string];
