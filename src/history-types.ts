export const HISTORY_EVENT_KEYS = [
  'history.reason.interrupted',
  'history.reason.noEnergy',
  'history.reason.notImportant',
  'history.reason.postponed',
  'history.reason.count',
  'history.reason.stalled',
  'history.chron.projectCreated',
  'history.chron.projectRestarted',
  'history.chron.projectTrimmed',
  'history.chron.projectClosed',
  'history.chron.projectReopened',
  'history.chron.projectCompletedLandmark',
  'history.chron.projectCompletedArchive',
  'history.chron.projectRestoredLandmark',
  'history.chron.projectArchivedLandmark',
  'history.chron.dayNoProgress',
  'history.chron.dayQuiet',
  'history.chron.dayDone',
  'history.chron.dayPartialAlso',
  'history.chron.dayPartialOnly',
  'history.chron.dayTopProject',
  'history.chron.stageRecovered',
  'history.chron.stageRecoveredSome',
  'history.chron.stageQuiet',
  'history.chron.stageDusty',
  'history.chron.stageLeaving',
  'history.chron.dayDropped',
  'history.chron.dayInterrupted',
  'history.chron.dayNoEnergy',
  'history.chron.dayArchived',
  'history.life.projectCreated',
  'history.life.projectRenamed',
  'history.life.projectRestarted',
  'history.life.projectReopened',
  'history.life.projectTrimmedDropped',
  'history.life.projectTrimmed',
  'history.life.projectClosedReason',
  'history.life.projectClosed',
  'history.life.projectClosedStalled',
  'history.life.taskCreated',
  'history.life.taskArrangedDate',
  'history.life.taskArranged',
  'history.life.taskRescheduledDate',
  'history.life.taskUnscheduled',
  'history.life.taskMovedOut',
  'history.life.taskMovedIn',
  'history.life.taskRenamed',
  'history.life.taskDroppedNotImportant',
  'history.life.taskDroppedTrim',
  'history.life.taskDroppedWithProject',
  'history.life.projectCompletedLandmark',
  'history.life.projectCompletedArchive',
  'history.life.projectRestoredLandmark',
  'history.life.projectArchivedLandmark',
  'history.life.diaryWritten',
  'history.life.diaryBackfilled',
  'history.life.diaryEdited',
  'history.life.diaryDateChanged',
  'history.life.diaryDeleted',
  'history.life.diaryExisting',
  'history.life.scheduleProjectChanged',
  'history.life.scheduleCreated',
  'history.life.scheduleEdited',
  'history.life.scheduleDeleted',
  'history.life.scheduleExisting',
  'history.life.settlementTaskDone',
  'history.life.settlementEventDone',
  'history.life.settlementPartial',
  'history.life.settlementSkipped',
  'history.life.settlementSkippedInterrupted',
  'history.life.settlementSkippedNoEnergy',
  'history.life.settlementSkippedNotImportant',
  'history.life.settlementSkippedPostponed',
  'history.life.stageNormal',
  'history.life.stageQuiet',
  'history.life.stageDusty',
  'history.life.stageLeaving',
] as const;

export type HistoryEventKey = typeof HISTORY_EVENT_KEYS[number];
export type HistoryParams = Record<string, string | number>;

export interface HistoryEvent {
  key: HistoryEventKey;
  params?: HistoryParams;
}

type ParamKind = 'string' | 'number' | 'date' | 'time';

interface HistoryEventContract {
  required?: Readonly<Record<string, ParamKind>>;
  optional?: Readonly<Record<string, ParamKind>>;
}

const NONE: HistoryEventContract = {};
const NAME = { required: { name: 'string' } } as const;
const TITLE = { required: { title: 'string' } } as const;
const COUNT = { required: { count: 'number' } } as const;
const STALLED = {
  optional: {
    interrupted: 'number',
    noEnergy: 'number',
    notImportant: 'number',
    postponed: 'number',
  },
} as const;

/**
 * Persisted history is an external-data boundary (backup/import), so every
 * semantic key declares exactly which parameters are accepted. This prevents a
 * syntactically valid but incomplete event from rendering empty placeholders.
 */
const HISTORY_EVENT_CONTRACTS = {
  'history.reason.interrupted': NONE,
  'history.reason.noEnergy': NONE,
  'history.reason.notImportant': NONE,
  'history.reason.postponed': NONE,
  'history.reason.count': { required: { reason: 'string', count: 'number' } },
  'history.reason.stalled': STALLED,
  'history.chron.projectCreated': NAME,
  'history.chron.projectRestarted': NAME,
  'history.chron.projectTrimmed': NAME,
  'history.chron.projectClosed': NAME,
  'history.chron.projectReopened': NAME,
  'history.chron.projectCompletedLandmark': NAME,
  'history.chron.projectCompletedArchive': NAME,
  'history.chron.projectRestoredLandmark': NAME,
  'history.chron.projectArchivedLandmark': NAME,
  'history.chron.dayNoProgress': NONE,
  'history.chron.dayQuiet': NONE,
  'history.chron.dayDone': COUNT,
  'history.chron.dayPartialAlso': COUNT,
  'history.chron.dayPartialOnly': COUNT,
  'history.chron.dayTopProject': NAME,
  'history.chron.stageRecovered': NAME,
  'history.chron.stageRecoveredSome': NAME,
  'history.chron.stageQuiet': NAME,
  'history.chron.stageDusty': NAME,
  'history.chron.stageLeaving': NAME,
  'history.chron.dayDropped': COUNT,
  'history.chron.dayInterrupted': COUNT,
  'history.chron.dayNoEnergy': NONE,
  'history.chron.dayArchived': { required: { date: 'date' } },
  'history.life.projectCreated': NAME,
  'history.life.projectRenamed': { required: { from: 'string', to: 'string' } },
  'history.life.projectRestarted': NONE,
  'history.life.projectReopened': NONE,
  'history.life.projectTrimmedDropped': COUNT,
  'history.life.projectTrimmed': NONE,
  'history.life.projectClosedReason': { required: { reason: 'string' } },
  'history.life.projectClosed': NONE,
  'history.life.projectClosedStalled': STALLED,
  'history.life.taskCreated': TITLE,
  'history.life.taskArrangedDate': { required: { title: 'string', date: 'date' } },
  'history.life.taskArranged': TITLE,
  'history.life.taskRescheduledDate': { required: { title: 'string', date: 'date' } },
  'history.life.taskUnscheduled': TITLE,
  'history.life.taskMovedOut': TITLE,
  'history.life.taskMovedIn': TITLE,
  'history.life.taskRenamed': { required: { from: 'string', to: 'string' } },
  'history.life.taskDroppedNotImportant': TITLE,
  'history.life.taskDroppedTrim': TITLE,
  'history.life.taskDroppedWithProject': TITLE,
  'history.life.projectCompletedLandmark': NONE,
  'history.life.projectCompletedArchive': NONE,
  'history.life.projectRestoredLandmark': NONE,
  'history.life.projectArchivedLandmark': NONE,
  'history.life.diaryWritten': NONE,
  'history.life.diaryBackfilled': { required: { date: 'date' } },
  'history.life.diaryEdited': NONE,
  'history.life.diaryDateChanged': { required: { date: 'date' } },
  'history.life.diaryDeleted': NONE,
  'history.life.diaryExisting': NONE,
  'history.life.scheduleProjectChanged': NONE,
  'history.life.scheduleCreated': {
    required: { title: 'string', date: 'date', start: 'time', end: 'time' },
  },
  'history.life.scheduleEdited': TITLE,
  'history.life.scheduleDeleted': NONE,
  'history.life.scheduleExisting': NONE,
  'history.life.settlementTaskDone': TITLE,
  'history.life.settlementEventDone': TITLE,
  'history.life.settlementPartial': TITLE,
  'history.life.settlementSkipped': TITLE,
  'history.life.settlementSkippedInterrupted': TITLE,
  'history.life.settlementSkippedNoEnergy': TITLE,
  'history.life.settlementSkippedNotImportant': TITLE,
  'history.life.settlementSkippedPostponed': TITLE,
  'history.life.stageNormal': NONE,
  'history.life.stageQuiet': NONE,
  'history.life.stageDusty': NONE,
  'history.life.stageLeaving': NONE,
} as const satisfies Record<HistoryEventKey, HistoryEventContract>;

const HISTORY_EVENT_KEY_SET = new Set<string>(HISTORY_EVENT_KEYS);
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validParam(value: unknown, kind: ParamKind): boolean {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (kind === 'date') return ISO_DATE.test(value);
  if (kind === 'time') return HM.test(value);
  return true;
}

export function historyEvent(key: HistoryEventKey, params?: HistoryParams): HistoryEvent {
  return params && Object.keys(params).length ? { key, params } : { key };
}

export function isHistoryEvent(value: unknown): value is HistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== 'string' || !HISTORY_EVENT_KEY_SET.has(row.key)) return false;

  const key = row.key as HistoryEventKey;
  const contract: HistoryEventContract = HISTORY_EVENT_CONTRACTS[key];
  const rawParams = row.params;
  if (rawParams !== undefined && (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams))) return false;
  const params = (rawParams ?? {}) as Record<string, unknown>;

  const required = contract.required ?? {};
  const optional = contract.optional ?? {};
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  if (Object.keys(params).some((name) => !allowed.has(name))) return false;

  for (const [name, kind] of Object.entries(required)) {
    if (!validParam(params[name], kind)) return false;
  }
  for (const [name, kind] of Object.entries(optional)) {
    if (params[name] !== undefined && !validParam(params[name], kind)) return false;
  }
  return true;
}
