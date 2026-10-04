/** Project-domain action surface. The implementation remains behind the
 * public action barrel so callers cannot bypass Store.batch. */
export {
  closeProject,
  completeProject,
  createProject,
  freeLandmarkIndex,
  islandRings,
  projectsNeedingPrompt,
  reopenProject,
  renameProject,
  restartProject,
  setResting,
  snoozePrompt,
  trimProject,
} from '../actions';
