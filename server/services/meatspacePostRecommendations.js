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
  memoryPracticeDeepLink,
  recentPracticeFromActivity,
} from './meatspacePost.js';
import { getPostStats } from './meatspacePostStats.js';
import { orderByRecencyRotation, shuffleForDay } from '../lib/postRotation.js';
import { MASTERY_DEFAULTS } from '../lib/postMultiplicationLadder.js';
import { POST_TOPICS, isMemoryItemEnabled, resolveTopicForDrillType } from '../lib/postTopics.js';
import { getDueMemoryItems, getMemoryItems, isMemoryItemDue } from './meatspacePostMemory.js';
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

  // Build the daily set independently of mastery signals. Keep items practiced
  // today in the pool after their due date advances, so completion cannot swap
  // another challenge into the day's fixed five slots.
  const practicedToday = practicedTodayFromActivity(sessions, training, todayStr, timezone);
  const memoryItems = await getMemoryItems();
  const dailyPool = POST_TOPICS.filter(topic => topic.module !== 'memory').flatMap(topic =>
    topic.drillTypes.filter(type => isRecDrillRunnable(config, topic.module || topic.id, type)).map(type => ({
      id: `daily:${type}`, kind: 'daily-mix',
      title: type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      detail: "Today's challenge mix", drillType: type,
      deepLink: topic.id === 'morse' ? `/post/morse/${type.replace('morse-', '')}` : '/post/launcher',
      practicedToday: practicedToday.drillTypes.has(type),
    })));
  dailyPool.push(...memoryItems.filter(item =>
    isRecDrillRunnable(config, 'memory', item.id === 'elements-song' ? 'memory-element-flash' : 'memory-sequence', item.id)
    && (isMemoryItemDue(item, atDate) || practicedToday.memoryItemIds.has(item.id))
  ).map(item => ({
    id: `daily:memory:${item.id}`, kind: 'daily-mix', title: `Practice "${item.title}"`,
    detail: 'Spaced-repetition practice', memoryItemId: item.id, drillType: null,
    deepLink: memoryPracticeDeepLink(item.id),
    practicedToday: practicedToday.memoryItemIds.has(item.id),
  })));
  const dailyRecommendations = shuffleForDay(dailyPool.sort((a, b) => a.id.localeCompare(b.id)), todayStr)
    .slice(0, RECOMMENDATION_LIMIT)
    .sort((a, b) => Number(a.practicedToday) - Number(b.practicedToday))
    .slice(0, Math.max(1, limit))
    .map((rec, priority) => ({ ...rec, priority }));

  return {
    dailyRecommendations,
    recommendations: composePostRecommendations({
      dueMemoryItems: enabledDueMemoryItems,
      dueReviews: enabledDueReviews,
      weakestSkill,
      stalled,
      hasHistory: sessions.length > 0,
      practicedToday,
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
