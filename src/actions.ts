/**
 * Public mutation surface.
 *
 * UI and external callers import from this file. Implementations live in the
 * domain modules under ./actions so domain code never depends back on this
 * barrel and Store.batch boundaries stay owned by the public actions.
 */
export { ActionError, REASON_TEXT } from './actions/shared';

export {
  closeProject,
  closeStalledProject,
  createProject,
  projectsNeedingPrompt,
  reopenProject,
  renameProject,
  restartProject,
  snoozePrompt,
  trimProject,
} from './actions/projects';

export {
  arrangeTask,
  createTask,
  declineTask,
  dropTask,
  editTaskPlan,
  markTaskDone,
  moveTask,
  pullIntoDay,
  renameTask,
  rescheduleTask,
} from './actions/tasks';

export type { Decision } from './actions/settlement';
export {
  archiveOldDays,
  recordBacklogSnapshot,
  refreshStages,
  settleDay,
} from './actions/settlement';

export {
  classifyEvents,
  deleteRule,
  mergeEvents,
  removeSource,
  setEventProject,
  createSchedule,
  editSchedule,
  deleteSchedule,
} from './actions/calendar';

export {
  createDiary,
  editDiary,
  deleteDiary,
} from './actions/diary';

export {
  completeProject,
  freeLandmarkIndex,
  islandRings,
  setResting,
} from './actions/completion';
