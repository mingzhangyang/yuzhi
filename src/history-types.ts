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

const HISTORY_EVENT_KEY_SET = new Set<string>(HISTORY_EVENT_KEYS);

export function historyEvent(key: HistoryEventKey, params?: HistoryParams): HistoryEvent {
  return params && Object.keys(params).length ? { key, params } : { key };
}

export function isHistoryEvent(value: unknown): value is HistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== 'string' || !HISTORY_EVENT_KEY_SET.has(row.key)) return false;
  if (row.params === undefined) return true;
  if (!row.params || typeof row.params !== 'object' || Array.isArray(row.params)) return false;
  return Object.values(row.params as Record<string, unknown>).every(
    (item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
  );
}
