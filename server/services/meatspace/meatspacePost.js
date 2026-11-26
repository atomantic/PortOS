/** Compatibility exports for POST configuration, sessions, benchmarks, analytics, and drills. */

export { computePostStreaks } from '../../lib/postStreak.js';
export { postConfigEvents, getPostConfig, updatePostConfig } from './postConfig.js';
export {
  POST_BENCHMARK_PROTOCOL,
  getPostBenchmarkForm,
  getPostBenchmarkProtocol,
  benchmarkCompatibility,
} from './postBenchmark.js';
export {
  MATH_MODULE,
  generateDoublingChain,
  generateSerialSubtraction,
  generateMultiplication,
  generatePowers,
  generateEstimation,
  generateDrill,
  computeExpectedFromPrompt,
  scoreDrill,
} from './postDrillGenerators.js';
export { getPostSessions, getPostSession } from './postSessionHistory.js';
export { submitPostSession } from './postSessions.js';
export {
  getAppliedNumeracyProgress,
  getMasteredSkills,
  getSessionSkillContext,
  syncReviewScheduleForSession,
  getPostProgress,
  getMultiplicationLevelStats,
  getPowersLevelStats,
  getMultiplicationProgress,
  getPowersProgress,
  getCognitiveLevelStats,
  getCognitiveProgress,
} from './postProgress.js';
export {
  getPostReviewReps,
  weakestSkillsFromStats,
  stalledProgressions,
  memoryPracticeDeepLink,
  memoryItemIdFromReview,
  practicedTodayFromActivity,
  RECENT_PRACTICE_WINDOW_DAYS,
  recentPracticeFromActivity,
  composePostRecommendations,
  isRecDrillRunnable,
} from './postRecommendations.js';
export { nBackBalancedAccuracy } from '../../lib/postScoring.js';
export {
  deriveTaskAccuracy,
  deriveTaskCompletion,
  deriveTaskAvgResponseMs,
  summarizeSkillEvidence,
} from './postSkillEvidence.js';
