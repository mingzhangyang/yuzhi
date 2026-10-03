/** 本地日期，格式 YYYY-MM-DD，按用户本地时区计算 */
export type ISODate = string;

export type ProjectStatus = 'active' | 'closed' | 'done';

export interface Project {
  id: string;
  name: string;
  createdAt: ISODate;
  status: ProjectStatus;
  /** 在岛上的位置（村落槽位） */
  islandSlot: number;
  closedAt?: ISODate;
  closeReason?: string;
  /** 用户做出「重新启动 / 缩小规模」时写入，衰败从这里重新起算 */
  resets?: { date: ISODate; neglect: number; kind: 'restart' | 'trim' }[];
  /** 「搬离」询问被暂缓到这一天 */
  promptSnoozeUntil?: ISODate;
  /** 落成（完成）的日期 */
  doneAt?: ISODate;
  /** 完成后的去处：海岸上的地标，或山顶灯塔里的档案馆 */
  resting?: 'landmark' | 'archive';
  /** 地标位编号（越小越靠里的年轮） */
  landmarkIndex?: number;
}

export interface Task {
  id: string;
  /** 没有则停在码头 */
  projectId?: string;
  title: string;
  scheduledFor?: ISODate;
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
  /** 来源 id + 事件 UID（重复事件再加原本的开始时间），改期后不变；见 ics.ts 的 eventId */
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
  /** 首次结算时分配并保持不变；与 OperationEvent.seq 共用同一事实顺序。 */
  seq: number;
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

export type ChronicleKind = 'day' | 'event' | 'quiet' | 'recover' | 'landmark';

export interface ChronicleLine {
  id: string;
  date: ISODate;
  /** 由规则生成，例如「今天推进了 3 件事，团队村落恢复了热闹」 */
  text: string;
  kind: ChronicleKind;
}

export type OperationKind =
  | 'project-created'
  | 'project-renamed'
  | 'project-restarted'
  | 'project-trimmed'
  | 'project-closed'
  | 'project-completed'
  | 'project-resting-changed'
  | 'task-created'
  | 'task-arranged'
  | 'task-rescheduled'
  | 'task-moved'
  | 'task-dropped'
  | 'task-state-baseline'
  | 'migration-boundary'
  | 'legacy-life';

export interface OperationLifeSnapshot {
  projectId?: string;
  taskId?: string;
  text: string;
  kind: LifeKind;
  reason?: SkipReason;
}

export interface OperationPayload extends Record<string, unknown> {
  /** 一生之书 read model 所需的当时叙述快照；不再另写一份 life 业务事实。 */
  life?: OperationLifeSnapshot[];
  /** v1 迁移来源；用于让兼容 life 行与 operation read model 去重。 */
  legacyLifeId?: string;
}

/** 用户主动操作事实；seq 与 SettlementEntry 共用同一单调递增事实顺序。 */
export interface OperationEvent {
  id: string;
  seq: number;
  date: ISODate;
  kind: OperationKind;
  projectId?: string;
  taskId?: string;
  payload?: OperationPayload;
}

export type LifeKind = 'start' | 'task' | 'done' | 'partial' | 'skip' | 'stage' | 'close' | 'restart' | 'trim' | 'drop' | 'event' | 'complete';

/** 一生之书里的一行 */
export interface LifeEntry {
  id: string;
  date: ISODate;
  /** Read-model-only order shared by settlement and operation facts on the same day. */
  factSeq?: number;
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

/** 每天积压数的快照，用来画真正的历史走势（当天最后一次的值） */
export interface BacklogSnapshot {
  date: ISODate;
  /** 码头上未安排 + 过期未完成 */
  backlog: number;
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
  operations: OperationEvent[];
  chronicle: ChronicleLine[];
  life: LifeEntry[];
  snapshots: BacklogSnapshot[];
  settings: Settings;
}
