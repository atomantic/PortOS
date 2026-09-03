/**
 * POST "what to practice next" orchestration.
 *
 * Imports the shared POST helpers from the persistence service and the derived
 * aggregates from the stats module, each named at its declaring module, so
 * persistence and recommendation policy stay independently loadable.
 */
import {
  getPostConfig,
  getPostSessions,
  getMultiplicationProgress,
  getPowersProgress,
  getCognitiveProgress,
  weakestSkillsFromStats,
  stalledProgressions,
  isRecDrillRunnable,
  memoryItemIdFromReview,
  composePostRecommendations,
  practicedTodayFromActivity,
  recentPracticeFromActivity,
} from './meatspacePost.js';
import { getPostStats } from './meatspacePostStats.js';
import { orderByRecencyRotation } from '../lib/postRotation.js';
import { MASTERY_DEFAULTS } from '../lib/postMultiplicationLadder.js';
import { isMemoryItemEnabled, resolveTopicForDrillType } from '../lib/postTopics.js';
import { getDueMemoryItems } from './meatspacePostMemory.js';
import { getDueReviews } from './meatspacePostReview.js';
import { getAllTrainingEntries } from './postTrainingLogStore.js';
import { getMorseProgress, MAX_KOCH_LEVEL } from './meatspacePostMorse.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

const RECOMMENDATION_LIMIT = 5;
const recModuleForDrillType = (type, fallback) => {
  const topic = resolveTopicForDrillType(type);
  return topic ? (topic.module || topic.id) : fallback;
};

export async function getPostRecommendations({ limit = RECOMMENDATION_LIMIT } = {}) {
  const atDate = new Date();
  const [dueMemoryItems, dueReviews, stats, mulProgress, powersProgress, cogProgress, morse, sessions, config, training, timezone] = await Promise.all([
    getDueMemoryItems(),
    getDueReviews(new Date(), Infinity),
    getPostStats(MASTERY_DEFAULTS.windowDays),
    getMultiplicationProgress(),
    getPowersProgress(),
    getCognitiveProgress(),
    getMorseProgress(MASTERY_DEFAULTS.windowDays),
    getPostSessions(),
    getPostConfig(),
    getAllTrainingEntries(),
    getUserTimezone(),
  ]);
  const todayStr = todayInTimezone(timezone, atDate);

  // Multi-day window that varies the HEURISTIC tiers only (issue #5319). The
  // schedule-driven tiers below never consult it — a genuinely due item still
  // wins the top slot even when it was practiced yesterday.
  const recentPractice = recentPracticeFromActivity(sessions, training, todayStr, timezone);
  const practicedRecently = (drillType) => Boolean(drillType) && recentPractice.drillTypes.has(drillType);

  // Every ranked candidate is filtered for runnability BEFORE selection, so a
  // disabled or module-excluded weakest drill no longer sinks the whole tier —
  // the next eligible one takes its place (issue #5319).
  const runnableWeakest = weakestSkillsFromStats(stats)
    .filter((skill) => isRecDrillRunnable(config, skill.module, skill.type))
    .map((skill) => ({ ...skill, deepLink: skill.module === 'memory' ? '/post/memory' : '/post/launcher' }));
  const weakestSkill = orderByRecencyRotation(runnableWeakest, {
    dayKey: recentPractice.dayKey,
    isRecent: (skill) => practicedRecently(skill.type),
    // Accuracy IS the priority here — rotation only breaks ties between drills
    // the user is equally weak at, so a genuinely weaker skill still leads.
    rank: (skill) => skill.accuracy,
  })[0] || null;

  const enabledDueMemoryItems = dueMemoryItems
    .filter((item) => isMemoryItemEnabled(config, item.id));
  const enabledDueReviews = dueReviews.filter((review) => {
    if (review.kind === 'memory') return isMemoryItemEnabled(config, memoryItemIdFromReview(review));
    return isRecDrillRunnable(config, recModuleForDrillType(review.drillType, 'cognitive'), review.drillType);
  });
  const runnableStalled = stalledProgressions(mulProgress, powersProgress, cogProgress, {
    kochLevel: morse?.kochLevel,
    kochLevelSet: morse?.kochLevelSet,
    maxKochLevel: MAX_KOCH_LEVEL,
  }).filter((stall) => isRecDrillRunnable(config, recModuleForDrillType(stall.drillType, 'cognitive'), stall.drillType));
  // Every stalled ladder is equally "N reps from the next rung", so this tier
  // has no intrinsic priority — it used to resolve to ladder-construction order
  // and pin one drill. Recency first, then a day rotation across the rest.
  const stalled = orderByRecencyRotation(runnableStalled, {
    dayKey: recentPractice.dayKey,
    isRecent: (stall) => practicedRecently(stall.drillType),
  });

  return {
    recommendations: composePostRecommendations({
      dueMemoryItems: enabledDueMemoryItems,
      dueReviews: enabledDueReviews,
      weakestSkill,
      stalled,
      hasHistory: sessions.length > 0,
      practicedToday: practicedTodayFromActivity(sessions, training, todayStr, timezone),
      limit,
    }),
    // The client's Quick-session composer rotates its own domain picks off the
    // same window and day key, so both surfaces agree on what counts as
    // "already practiced lately". Sets are serialized as arrays for JSON.
    recentPractice: {
      dayKey: recentPractice.dayKey,
      drillTypes: [...recentPractice.drillTypes],
      memoryItemIds: [...recentPractice.memoryItemIds],
    },
  };
}
