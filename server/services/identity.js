// Identity service barrel.
//
// The identity domain was split into focused submodules under ./identity/ to
// keep each concern small and testable. This file preserves the original
// public API surface — every importer of '../services/identity.js' keeps
// working unchanged (both `import * as identityService` and named imports).
//
//   identity/store.js      — shared file I/O, paths, defaults, goal normalization
//   identity/markers.js    — genomic marker definitions, extraction, life expectancy
//   identity/chronotype.js — chronotype derivation + energy schedule
//   identity/longevity.js  — longevity/cardiovascular derivation
//   identity/goals.js      — goal CRUD, tree, AI phases/organize/check-in, velocity
//   identity/todos.js      — per-goal todo CRUD
//   identity/insights.js   — cross-domain insight rules engine
//   identity/status.js     — aggregate identity dashboard status

// Pure marker functions (exported for testing)
export {
  extractSleepMarkers,
  extractCaffeineMarkers,
  extractLongevityMarkers,
  extractCardiovascularMarkers,
  computeLifeExpectancy
} from './identity/markers.js';

// Chronotype
export {
  computeChronotype,
  computeRecommendations,
  getChronotype,
  deriveChronotype,
  updateChronotypeBehavioral,
  getEnergySchedule
} from './identity/chronotype.js';

// Longevity
export { getLongevity, deriveLongevity } from './identity/longevity.js';

// Goals
export {
  computeGoalFeasibility,
  computeGoalUrgency,
  computeGoalVelocity,
  computeTimeTracking,
  getGoals,
  setBirthDate,
  createGoal,
  updateGoal,
  deleteGoal,
  getGoalsTree,
  linkActivity,
  unlinkActivity,
  addMilestone,
  addProgressEntry,
  deleteProgressEntry,
  completeMilestone,
  linkCalendarToGoal,
  unlinkCalendarFromGoal,
  getGoalCalendarEvents,
  generateGoalPhases,
  acceptGoalPhases,
  decomposeGoal,
  acceptGoalDecomposition,
  completeMilestoneTask,
  organizeGoals,
  applyGoalOrganization,
  checkInGoal,
  updateGoalProgress
} from './identity/goals.js';

// Todos
export { addTodo, updateTodo, deleteTodo } from './identity/todos.js';

// Cross-insights
export { getCrossInsights } from './identity/insights.js';

// Aggregate status
export { getIdentityStatus } from './identity/status.js';
