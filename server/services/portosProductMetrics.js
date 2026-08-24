/**
 * PortOS product-engagement metrics.
 *
 * This is a read-only signal layer for surfaces that need to answer two
 * questions the generic CoS telemetry cannot: did the user exercise POST today,
 * and did they close the feedback loop on completed creative commissions?
 * The aggregate shape is deliberately safe to put in a reasoning prompt; the
 * user-facing action projection may additionally carry a deep link to the
 * oldest item needing attention.
 */

import { getPostSessions } from './meatspacePost.js';
import { getAllTrainingEntries } from './postTrainingLogStore.js';
import { listCommissions } from './creativeCommissions/store.js';
import { getProjectsByIds } from './creativeDirector/local.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { computeUnifiedStreak, recordDayKey, ymdShift, ymdToUTC } from '../lib/postStreak.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FEEDBACK_WINDOW_DAYS = 30;
const ACTION_PENDING_LIMIT = 8;
const SOURCE_MAX_CHARS = 8000;
const COMPLETED_PROJECT_STATUSES = new Set(['complete', 'completed']);
const NON_REVIEWABLE_RUN_STATUSES = new Set(['failed', 'skipped', 'cancelled', 'canceled', 'error']);

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);

function dateKey(value, timezone) {
  return recordDayKey(value, timezone);
}

function windowStart(today, days) {
  return ymdShift(today, -(days - 1));
}

function inWindow(date, today, days) {
  return Boolean(date && date >= windowStart(today, days) && date <= today);
}

function daysSinceDate(lastDate, today) {
  if (!lastDate) return null;
  const age = Math.floor((ymdToUTC(today) - ymdToUTC(lastDate)) / DAY_MS);
  return Math.max(0, age);
}

/**
 * Pure POST activity rollup. Scored sessions and training entries both count
 * as a daily exercise, while their separate counts remain visible for
 * evaluation instead of collapsing into one opaque total.
 */
export function summarizePostEngagement({ sessions = [], trainingEntries = [], today, timezone }) {
  if (typeof today !== 'string' || !today) {
    return { status: 'unavailable', reason: 'missing-local-day' };
  }

  const scored = asArray(sessions);
  const training = asArray(trainingEntries);
  const scoredDates = new Set(scored.map((record) => dateKey(record, timezone)).filter(Boolean));
  const trainingDates = new Set(training.map((record) => dateKey(record, timezone)).filter(Boolean));
  const activeDates = new Set([...scoredDates, ...trainingDates]);
  const lastActiveDate = [...activeDates].sort().at(-1) || null;
  const unified = computeUnifiedStreak(scored, training, today, timezone);

  const countRecent = (records, days) => records.filter((record) => inWindow(dateKey(record, timezone), today, days)).length;
  const activeDays = (days) => [...activeDates].filter((date) => inWindow(date, today, days)).length;

  return {
    status: 'ok',
    today,
    completedToday: activeDates.has(today),
    lastActiveDate,
    daysSinceActivity: daysSinceDate(lastActiveDate, today),
    currentStreak: unified.current,
    longestStreak: unified.longest,
    activeDaysLast7: activeDays(7),
    activeDaysLast30: activeDays(30),
    scoredSessionsLast7: countRecent(scored, 7),
    scoredSessionsLast30: countRecent(scored, 30),
    trainingEntriesLast7: countRecent(training, 7),
    trainingEntriesLast30: countRecent(training, 30),
  };
}

function feedbackIsUsable(feedback) {
  return feedback?.rating === 'up'
    || feedback?.rating === 'down'
    || (typeof feedback?.rating === 'number' && feedback.rating !== 0);
}

function feedbackTimestamp(feedback) {
  const value = Date.parse(feedback?.at || feedback?.updatedAt || '');
  return Number.isFinite(value) ? value : null;
}

function latestFeedbackByRun(feedback) {
  const latest = new Map();
  for (const entry of asArray(feedback)) {
    if (!entry?.runId || !feedbackIsUsable(entry)) continue;
    const previous = latest.get(entry.runId);
    const currentAt = feedbackTimestamp(entry) ?? 0;
    const previousAt = feedbackTimestamp(previous) ?? 0;
    if (!previous || currentAt >= previousAt) latest.set(entry.runId, entry);
  }
  return latest;
}

function runTimestamp(run) {
  const value = Date.parse(run?.ranAt || '');
  return Number.isFinite(value) ? value : null;
}

function runCanBeReviewed(run, project) {
  if (!run?.id || !run?.projectId || !isObject(project)) return false;
  if (NON_REVIEWABLE_RUN_STATUSES.has(run.status)) return false;
  return COMPLETED_PROJECT_STATUSES.has(project.status);
}

/**
 * Pure creative-feedback rollup. A render is reviewable only after its
 * Creative Director project reaches a terminal success state; an in-flight or
 * failed commission must never become a false overdue prompt.
 */
export function summarizeCreativeFeedback({ commissions = [], projects = [], now = new Date() }) {
  const projectById = new Map(asArray(projects).filter((project) => project?.id).map((project) => [project.id, project]));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const reviewable = [];

  for (const commission of asArray(commissions)) {
    if (!commission?.id || commission.deleted) continue;
    const feedbackByRun = latestFeedbackByRun(commission.feedback);
    for (const run of asArray(commission.runs)) {
      const ranAtMs = runTimestamp(run);
      const project = projectById.get(run?.projectId);
      if (!runCanBeReviewed(run, project) || ranAtMs === null || ranAtMs > effectiveNow) continue;
      const feedback = feedbackByRun.get(run.id) || null;
      reviewable.push({
        commissionId: commission.id,
        commissionName: typeof commission.name === 'string' && commission.name.trim()
          ? commission.name.trim().slice(0, 160)
          : 'Creative commission',
        runId: run.id,
        ranAt: new Date(ranAtMs).toISOString(),
        ageDays: Math.max(0, Math.floor((effectiveNow - ranAtMs) / DAY_MS)),
        reviewed: Boolean(feedback),
      });
    }
  }

  reviewable.sort((a, b) => Date.parse(a.ranAt) - Date.parse(b.ranAt));
  const recent = reviewable.filter((entry) => {
    const ageMs = effectiveNow - Date.parse(entry.ranAt);
    return ageMs >= 0 && ageMs <= FEEDBACK_WINDOW_DAYS * DAY_MS;
  });
  const pendingReviews = reviewable.filter((entry) => !entry.reviewed);
  const reviewedCount = reviewable.length - pendingReviews.length;
  const recentReviewedCount = recent.filter((entry) => entry.reviewed).length;
  const coverage = (reviewed, total) => total > 0 ? Math.round((reviewed / total) * 100) : null;

  return {
    status: 'ok',
    configuredCount: asArray(commissions).filter((commission) => commission && !commission.deleted).length,
    completedRenders: reviewable.length,
    completedRendersLast30: recent.length,
    reviewedRenders: reviewedCount,
    reviewedRendersLast30: recentReviewedCount,
    unreviewedRenders: pendingReviews.length,
    unreviewedRendersLast30: recent.filter((entry) => !entry.reviewed).length,
    oldestUnreviewedAgeDays: pendingReviews.length ? pendingReviews[0].ageDays : null,
    feedbackCoveragePercent: coverage(reviewedCount, reviewable.length),
    feedbackCoverageLast30Percent: coverage(recentReviewedCount, recent.length),
    pendingReviews: pendingReviews.slice(0, ACTION_PENDING_LIMIT),
  };
}

function unavailableMetrics(reason) {
  return { status: 'unavailable', reason };
}

export function buildProductActions({ post, creativeCommissions }) {
  const actions = [];

  if (post?.status === 'ok' && !post.completedToday) {
    const daysSince = post.daysSinceActivity;
    const detail = daysSince === null
      ? 'No POST activity is recorded yet — take the daily brain exercise.'
      : `No POST activity today${daysSince > 0 ? `; the last exercise was ${daysSince} day${daysSince === 1 ? '' : 's'} ago` : ''}.`;
    actions.push({
      id: 'daily-post',
      type: 'post_engagement',
      severity: daysSince === null || daysSince >= 2 ? 'high' : 'medium',
      title: 'Daily POST is waiting',
      detail,
      link: '/post/launcher',
      featureId: 'post',
      featureLabel: 'POST',
      metadata: {
        completedToday: false,
        daysSinceActivity: daysSince,
        activeDaysLast7: post.activeDaysLast7,
        currentStreak: post.currentStreak,
      },
    });
  }

  if (creativeCommissions?.status === 'ok' && creativeCommissions.unreviewedRenders > 0) {
    const oldest = creativeCommissions.pendingReviews?.[0];
    const link = oldest
      ? `/creative-commission/${encodeURIComponent(oldest.commissionId)}?run=${encodeURIComponent(oldest.runId)}`
      : '/creative-commission';
    const name = oldest?.commissionName && oldest.commissionName !== 'Creative commission'
      ? `: ${oldest.commissionName}`
      : '';
    const age = creativeCommissions.oldestUnreviewedAgeDays;
    actions.push({
      id: `creative-feedback:${oldest?.commissionId || 'pending'}:${oldest?.runId || 'latest'}`,
      type: 'commission_feedback',
      severity: age !== null && age >= 3 ? 'high' : 'medium',
      title: `Creative feedback overdue${name}`,
      detail: `${creativeCommissions.unreviewedRenders} completed render${creativeCommissions.unreviewedRenders === 1 ? '' : 's'} ${age > 0 ? 'awaiting review' : 'awaiting your rating'}${age > 0 ? ` for up to ${age} days` : ''}.`,
      link,
      metadata: {
        unreviewedRenders: creativeCommissions.unreviewedRenders,
        oldestUnreviewedAgeDays: age,
        feedbackCoveragePercent: creativeCommissions.feedbackCoveragePercent,
      },
    });
  }

  return actions;
}

export function toProductMetricsAggregate(metrics) {
  const { pendingReviews: _pendingReviews, ...creative } = metrics.creativeCommissions || {};
  const aggregate = {
    today: metrics.today,
    creativeCommissions: creative,
  };
  // A disabled feature is not a metric. Keep the explicit disabled sentinel in
  // the full result for user-facing callers, but do not hand it to Layered
  // Intelligence as a product signal to interpret or improve.
  if (metrics.post?.status !== 'disabled') aggregate.post = metrics.post;
  return aggregate;
}

/**
 * Read all product signals. Each feature has an explicit unavailable sentinel,
 * so a failed read cannot masquerade as an empty history and trigger a false
 * user reminder or a misleading LI recommendation.
 */
export async function getProductEngagement({ now = new Date(), timezone: configuredTimezone } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const timezoneResult = configuredTimezone
    ? Promise.resolve(configuredTimezone)
    : getUserTimezone().catch(() => null);
  const [timezone, postEnabled] = await Promise.all([
    timezoneResult,
    isInstanceFeatureEnabled('post'),
  ]);
  const today = timezone ? todayInTimezone(timezone, nowDate) : null;

  const postPromise = postEnabled && timezone && today
    ? Promise.all([
      getPostSessions(undefined, undefined, { strict: true }),
      getAllTrainingEntries({ strict: true }),
    ])
      .then(([sessions, trainingEntries]) => summarizePostEngagement({ sessions, trainingEntries, today, timezone }))
      .catch(() => null)
    : Promise.resolve(null);

  const creativePromise = listCommissions({ strict: true })
    .then(async (commissions) => {
      const projectIds = [...new Set(asArray(commissions).flatMap((commission) => asArray(commission?.runs)
        .map((run) => run?.projectId)
        .filter(Boolean)))];
      const projects = projectIds.length ? await getProjectsByIds(projectIds) : [];
      return summarizeCreativeFeedback({ commissions, projects, now: nowDate });
    })
    .catch(() => null);

  const [postData, creativeData] = await Promise.all([postPromise, creativePromise]);
  const metrics = {
    today,
    post: postEnabled
      ? postData || unavailableMetrics('post-read-failed')
      : { status: 'disabled', reason: 'instance-feature-disabled' },
    creativeCommissions: creativeData || unavailableMetrics('creative-read-failed'),
  };
  return {
    ...metrics,
    actions: buildProductActions(metrics),
    checkedAt: nowDate.toISOString(),
    timezone: timezone || null,
  };
}

/** Return only aggregate metrics suitable for a Layered Intelligence prompt. */
export async function getProductMetricsSource(options = {}) {
  const result = await getProductEngagement(options);
  return JSON.stringify(toProductMetricsAggregate(result)).slice(0, SOURCE_MAX_CHARS);
}

/** Return the user-facing daily action projection for the dashboard/toast. */
export async function getDailyActions(options = {}) {
  const result = await getProductEngagement(options);
  return {
    today: result.today,
    actions: result.actions,
    metrics: toProductMetricsAggregate(result),
    checkedAt: result.checkedAt,
  };
}
