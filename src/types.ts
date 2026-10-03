/** 本地日期，格式 YYYY-MM-DD，按用户本地时区计算 */
export type ISODate = string;

export type ProjectStatus = 'active' | 'closed' | 'done';

export interface Project {
  id: string;
  name: string;
  createdAt: ISODate;
  /** 最近一次确认「做了」或「做了一部分」的日期 */
  lastProgressAt?: ISODate;
  status: ProjectStatus;
  /** 在岛上的位置（村落槽位） */
  islandSlot: number;
  closedAt?: ISODate;
  closeReason?: string;
  /** 用户做出「重新启动 / 缩小规模」时写入，衰败从这里重新起算 */
  resets?: { date: ISODate; neglect: number; kind: 'restart' | 'trim' }[];
  /** 「搬离」询问被暂缓到这一天 */
  promptSnoozeUntil?: ISODate;
  /** 上一次记录在一生之书里的阶段，用于发现阶段变化 */
  lastStage?: number;
}

export interface Task {
  id: string;
  /** 没有则停在码头 */
  projectId?: string;
  title: string;
  scheduledFor?: ISODate;
  postponeCount: number;
  status: 'open' | 'done' | 'dropped';
  createdAt: ISODate;
  closedAt?: ISODate;
}

export interface CalendarSource {
  id: string;
  name: string;
  /** 订阅链接；上传的文件没有 */
  icsUrl?: string;
  lastFetchedAt?: string;
  lastError?: string;
}

export interface CalendarEvent {
  /** 来源 id + 事件 UID + 开始时间，保证重复事件每次唯一 */
  id: string;
  sourceId: string;
  uid: string;
  title: string;
  /** ISO 时间戳 */
  start: string;
  end: string;
  allDay: boolean;
  /** 由归类规则或用户指定；CHORES 表示杂务 */
  projectId?: string;
  /** 是否已经归过类（包括归到杂务） */
  classified: boolean;
}

/** 归到「杂务」时使用的特殊项目 id */
export const CHORES = 'chores';

export interface ClassifyRule {
  id: string;
  /** 标题包含的文字 */
  contains: string;
  /** 项目 id，或 CHORES */
  projectId: string;
}

export type Outcome = 'done' | 'partial' | 'skipped';
export type SkipReason = 'interrupted' | 'no_energy' | 'not_important' | 'postponed';

export interface SettlementEntry {
  /** `${date}|${itemType}|${itemId}` */
  id: string;
  date: ISODate;
  itemType: 'task' | 'event';
  itemId: string;
  outcome: Outcome;
  reason?: SkipReason;
  /** 结算时的快照，便于日后回看 */
  projectId?: string;
  title: string;
}

export interface DayRecord {
  date: ISODate;
  /** settled：用户结算过；unrecorded：超过期限自动归档为「未记录」 */
  status: 'settled' | 'unrecorded';
}

export type ChronicleKind = 'day' | 'event' | 'quiet' | 'recover';

export interface ChronicleLine {
  id: string;
  date: ISODate;
  /** 由规则生成，例如「今天推进了 3 件事，团队村落恢复了热闹」 */
  text: string;
  kind: ChronicleKind;
}

export type LifeKind = 'start' | 'task' | 'done' | 'partial' | 'skip' | 'stage' | 'close' | 'restart' | 'trim' | 'drop' | 'event';

/** 一生之书里的一行 */
export interface LifeEntry {
  id: string;
  date: ISODate;
  projectId?: string;
  taskId?: string;
  text: string;
  kind: LifeKind;
  reason?: SkipReason;
}

/** 码头上的「打断记录」 */
export interface Interruption {
  id: string;
  date: ISODate;
  itemType: 'task' | 'event';
  itemId: string;
  title: string;
  projectId?: string;
}

export interface Settings {
  /** 工作时段，HH:MM */
  workStart: string;
  workEnd: string;
  /** 第一次打开的日子，结算从这里开始算 */
  firstDay: ISODate;
  theme: 'auto' | 'light' | 'dark';
}

export interface Data {
  projects: Project[];
  tasks: Task[];
  sources: CalendarSource[];
  events: CalendarEvent[];
  rules: ClassifyRule[];
  entries: SettlementEntry[];
  days: DayRecord[];
  chronicle: ChronicleLine[];
  life: LifeEntry[];
  interruptions: Interruption[];
  settings: Settings;
}
