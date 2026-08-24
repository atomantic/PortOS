/**
 * POST "what to practice next" orchestration.
 *
 * The public service re-exports this entry point. It imports the shared POST
 * helpers from that service so persistence and recommendation policy remain
 * independently testable without changing callers.
 */
import {
  getPostConfig,
  getPostSessions,
  getPostStats,
  getMultiplicationProgress,
  getPowersProgress,
  getCognitiveProgress,
  weakestSkillFromStats,
  stalledProgressions,
  isRecDrillRunnable,
  memoryItemIdFromReview,
  composePostRecommendations,
  practicedTodayFromActivity,
} from './meatspacePost.js';
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

  let weakestSkill = weakestSkillFromStats(stats);
  if (weakestSkill) {
    weakestSkill = isRecDrillRunnable(config, weakestSkill.module, weakestSkill.type)
      ? { ...weakestSkill, deepLink: weakestSkill.module === 'memory' ? '/post/memory' : '/post/launcher' }
      : null;
  }

  const enabledDueMemoryItems = dueMemoryItems
    .filter((item) => isMemoryItemEnabled(config, item.id));
  const enabledDueReviews = dueReviews.filter((review) => {
    if (review.kind === 'memory') return isMemoryItemEnabled(config, memoryItemIdFromReview(review));
    return isRecDrillRunnable(config, recModuleForDrillType(review.drillType, 'cognitive'), review.drillType);
  });
  const stalled = stalledProgressions(mulProgress, powersProgress, cogProgress, {
    kochLevel: morse?.kochLevel,
    kochLevelSet: morse?.kochLevelSet,
    maxKochLevel: MAX_KOCH_LEVEL,
  }).filter((stall) => isRecDrillRunnable(config, recModuleForDrillType(stall.drillType, 'cognitive'), stall.drillType));

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
  };
}
