/**
 * CoS Learning and Weekly Digest Routes
 */

import { Router } from 'express';
import * as taskLearning from '../services/taskLearning.js';
import * as weeklyDigest from '../services/weeklyDigest.js';
import { loadState } from '../services/cos/cosState.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { recordLearningInsightSchema, dismissRecommendationSchema, restoreRecommendationSchema, generateWeeklyDigestSchema } from '../lib/cos/cosValidation.js';
import { validateRequest } from '../lib/validateRequest.js';
import { limitQuerySchema, parsePagination } from '../lib/queryValidation.js';

const router = Router();

// GET /api/cos/learning - Get learning insights
router.get('/learning', asyncHandler(async (req, res) => {
  const insights = await taskLearning.getLearningInsights();
  res.json(insights);
}));

// GET /api/cos/learning/durations - Get all task type duration estimates
router.get('/learning/durations', asyncHandler(async (req, res) => {
  const durations = await taskLearning.getAllTaskDurations();
  res.json(durations);
}));

// POST /api/cos/learning/backfill - Backfill learning data from history
router.post('/learning/backfill', asyncHandler(async (req, res) => {
  const count = await taskLearning.backfillFromHistory();
  res.json({ success: true, backfilledCount: count });
}));

// GET /api/cos/learning/skipped - Get historical low-success recommendations (legacy endpoint name)
router.get('/learning/skipped', asyncHandler(async (req, res) => {
  const skipped = await taskLearning.getSkippedTaskTypes();
  res.json({
    advisoryOnly: true,
    lowSuccessCount: skipped.length,
    skippedCount: skipped.length, // Legacy field; not scheduler state.
    skippedTypes: skipped,
    message: skipped.length > 0
      ? 'These task types have low historical success rates; this recommendation does not pause scheduling'
      : 'No task types currently have low-success recommendations'
  });
}));

// POST /api/cos/learning/reset/:taskType - Reset learning data for a specific task type
router.post('/learning/reset/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  if (!taskType) {
    throw new ServerError('Task type is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await taskLearning.resetTaskTypeLearning(taskType);
  if (!result.reset) {
    throw new ServerError(`Task type "${taskType}" not found in learning data`, { status: 404, code: 'NOT_FOUND' });
  }
  import('../services/reviewQueue.js').then(m => m.__resetAlertsCache?.()).catch(() => {});
  res.json(result);
}));

// GET /api/cos/learning/routing - Get routing accuracy metrics (task type × model tier)
router.get('/learning/routing', asyncHandler(async (req, res) => {
  const routing = await taskLearning.getRoutingAccuracy();
  res.json(routing);
}));

// GET /api/cos/learning/performance - Get performance summary
router.get('/learning/performance', asyncHandler(async (req, res) => {
  const summary = await taskLearning.getPerformanceSummary();
  res.json(summary);
}));

// GET /api/cos/learning/summary - Get lightweight learning health summary for dashboard
router.get('/learning/summary', asyncHandler(async (req, res) => {
  const summary = await taskLearning.getLearningSummary();
  res.json(summary);
}));

// GET /api/cos/learning/insights - Get recent learning insights
router.get('/learning/insights', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(validateRequest(limitQuerySchema, req.query), { defaultLimit: 10, maxLimit: 500 });
  const insights = await taskLearning.getRecentInsights(limit);
  res.json({
    count: insights.length,
    insights
  });
}));

// POST /api/cos/learning/insights - Record a learning insight
router.post('/learning/insights', asyncHandler(async (req, res) => {
  const parsedInsight = recordLearningInsightSchema.safeParse(req.body);
  if (!parsedInsight.success) failValidation(parsedInsight);
  const { type, message, taskType, context } = parsedInsight.data;
  const insight = await taskLearning.recordLearningInsight({
    type: type || 'observation',
    message,
    taskType,
    context
  });
  res.json({ success: true, insight });
}));

// GET /api/cos/learning/recommendations/dismissed - List dismissed AI recommendations
router.get('/learning/recommendations/dismissed', asyncHandler(async (req, res) => {
  const dismissed = await taskLearning.getDismissedRecommendations();
  res.json({ count: dismissed.length, dismissed });
}));

// POST /api/cos/learning/recommendations/dismiss - Dismiss an AI recommendation
router.post('/learning/recommendations/dismiss', asyncHandler(async (req, res) => {
  const parsedDismiss = dismissRecommendationSchema.safeParse(req.body || {});
  if (!parsedDismiss.success) failValidation(parsedDismiss);
  const { id, snapshot } = parsedDismiss.data;
  const result = await taskLearning.dismissRecommendation(id, snapshot ?? null);
  res.json(result);
}));

// POST /api/cos/learning/recommendations/restore - Restore a dismissed recommendation
router.post('/learning/recommendations/restore', asyncHandler(async (req, res) => {
  const parsedRestore = restoreRecommendationSchema.safeParse(req.body || {});
  if (!parsedRestore.success) failValidation(parsedRestore);
  const { id } = parsedRestore.data;
  const result = await taskLearning.restoreRecommendation(id);
  res.json(result);
}));

// POST /api/cos/learning/recommendations/clear-dismissed - Clear all dismissals
router.post('/learning/recommendations/clear-dismissed', asyncHandler(async (req, res) => {
  const result = await taskLearning.clearDismissedRecommendations();
  res.json(result);
}));

// GET /api/cos/learning/recommendations/:taskType - Get detailed recommendations for specific task type
router.get('/learning/recommendations/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  if (!taskType) {
    throw new ServerError('Task type is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const recommendations = await taskLearning.getPromptImprovementRecommendations(taskType);
  res.json(recommendations);
}));

// GET /api/cos/learning/confidence - Get confidence levels for all task types
router.get('/learning/confidence', asyncHandler(async (req, res) => {
  const state = await loadState();
  const thresholds = state.config?.confidenceAutoApproval ?? {};
  const confidence = await taskLearning.getConfidenceLevels(thresholds);
  res.json(confidence);
}));

// ============================================================
// Weekly Digest Routes
// ============================================================

// GET /api/cos/digest - Get current week's digest
router.get('/digest', asyncHandler(async (req, res) => {
  const digest = await weeklyDigest.getWeeklyDigest();
  res.json(digest);
}));

// GET /api/cos/digest/list - List all available weekly digests
router.get('/digest/list', asyncHandler(async (req, res) => {
  const digests = await weeklyDigest.listWeeklyDigests();
  res.json({ digests });
}));

// GET /api/cos/digest/progress - Get current week's progress (live)
router.get('/digest/progress', asyncHandler(async (req, res) => {
  const progress = await weeklyDigest.getCurrentWeekProgress();
  res.json(progress);
}));

// GET /api/cos/digest/:weekId - Get digest for specific week
router.get('/digest/:weekId', asyncHandler(async (req, res) => {
  const { weekId } = req.params;

  // Validate weekId format (YYYY-WXX)
  if (!/^\d{4}-W\d{2}$/.test(weekId)) {
    throw new ServerError('Invalid weekId format. Use YYYY-WXX (e.g., 2026-W02)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const digest = await weeklyDigest.getWeeklyDigest(weekId);
  if (!digest) {
    throw new ServerError('Digest not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(digest);
}));

// POST /api/cos/digest/generate - Force generate digest for a week
router.post('/digest/generate', asyncHandler(async (req, res) => {
  const parsedDigest = generateWeeklyDigestSchema.safeParse(req.body || {});
  if (!parsedDigest.success) failValidation(parsedDigest);
  const { weekId } = parsedDigest.data;
  const digest = await weeklyDigest.generateWeeklyDigest(weekId || null);
  res.json(digest);
}));

export default router;
