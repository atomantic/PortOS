/**
 * Task Learning Service — barrel
 *
 * Tracks patterns from completed tasks to improve future task execution.
 * Learns from success/failure rates, duration patterns, and error categories
 * to provide smarter task prioritization and model selection.
 *
 * The implementation is split by concern:
 *   - store.js                — shared persistence, cache, mutex, pure helpers
 *   - metrics.js              — recording completions + rebuilding aggregates
 *   - routing.js              — heuristic routing, cooldown, skip, confidence
 *   - durations.js            — duration estimates + queue completion
 *   - insights.js             — insights view, recommendations, dismissals
 *   - promptRecommendations.js — prompt-improvement suggestions
 *   - lifecycle.js            — init wiring + history backfill
 *
 * This barrel preserves the original public API of `taskLearning.js` so
 * every existing importer is unaffected.
 */

export {
  clearLearningCache,
  extractTaskType,
  classifyUntypedTask,
  isSandboxedTaskType,
  EXTERNAL_UNTYPED_TASK_TYPE
} from './store.js';

export {
  recordTaskCompletion,
  buildTaskTelemetryContext,
  computeLatencySplit,
  recordFailureSignature,
  resetTaskTypeLearning,
  recalculateModelTierMetrics,
  recalculateDurationStats
} from './metrics.js';

export {
  getTaskTypePriorityMultiplier,
  suggestModelTier,
  deriveFailureSignalAvoidance,
  getRoutingAccuracy,
  getPerformanceSummary,
  getAdaptiveCooldownMultiplier,
  getSkippedTaskTypes,
  shouldSkipTaskType,
  checkAndRehabilitateSkippedTasks,
  getSkippedTaskTypesWithStatus,
  getTaskTypeConfidence,
  getConfidenceLevels
} from './routing.js';

export {
  getTaskDurationEstimate,
  getAllTaskDurations,
  estimateQueueCompletion
} from './durations.js';

export {
  getLearningInsights,
  dismissRecommendation,
  restoreRecommendation,
  clearDismissedRecommendations,
  getDismissedRecommendations,
  recordLearningInsight,
  getRecentInsights,
  getLearningSummary
} from './insights.js';

export {
  getPromptImprovementRecommendations,
  getAllPromptRecommendations
} from './promptRecommendations.js';

export {
  initTaskLearning,
  backfillFromHistory
} from './lifecycle.js';
