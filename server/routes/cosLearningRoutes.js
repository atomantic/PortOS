/**
 * CoS Learning and Weekly Digest Routes
 */

import { Router } from 'express';
import * as taskLearning from '../services/taskLearning.js';
import * as weeklyDigest from '../services/weeklyDigest.js';
import { loadState } from '../services/cosState.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

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

// GET /api/cos/learning/skipped - Get task types being skipped due to poor performance
router.get('/learning/skipped', asyncHandler(async (req, res) => {
  const skipped = await taskLearning.getSkippedTaskTypes();
  res.json({
    skippedCount: skipped.length,
    skippedTypes: skipped,
    message: skipped.length > 0
      ? 'These task types have <30% success rate after 5+ attempts and are being skipped'
      : 'No task types are currently being skipped'
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
  res.json(result);
}));

// GET /api/cos/learning/cooldown/:taskType - Get adaptive cooldown for specific task type
router.get('/learning/cooldown/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const cooldownInfo = await taskLearning.getAdaptiveCooldownMultiplier(taskType);
  res.json({
    taskType,
    ...cooldownInfo
  });
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
  const limit = parseInt(req.query.limit, 10) || 10;
  const insights = await taskLearning.getRecentInsights(limit);
  res.json({
    count: insights.length,
    insights
  });
}));

// POST /api/cos/learning/insights - Record a learning insight
router.post('/learning/insights', asyncHandler(async (req, res) => {
  const { type, message, taskType, context } = req.body;
  if (!message) {
    throw new ServerError('Insight message is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const insight = await taskLearning.recordLearningInsight({
    type: type || 'observation',
    message,
    taskType,
    context
  });
  res.json({ success: true, insight });
}));

// GET /api/cos/learning/recommendations - Get all prompt improvement recommendations
router.get('/learning/recommendations', asyncHandler(async (req, res) => {
  const recommendations = await taskLearning.getAllPromptRecommendations();
  res.json({
    count: recommendations.length,
    recommendations,
    summary: {
      critical: recommendations.filter(r => r.status === 'critical').length,
      needsImprovement: recommendations.filter(r => r.status === 'needs-improvement').length,
      moderate: recommendations.filter(r => r.status === 'moderate').length,
      good: recommendations.filter(r => r.status === 'good').length
    }
  });
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

// POST /api/cos/learning/recalculate-model-tiers - Rebuild byModelTier from routingAccuracy
router.post('/learning/recalculate-model-tiers', asyncHandler(async (req, res) => {
  const result = await taskLearning.recalculateModelTierMetrics();
  res.json({ success: true, ...result });
}));

// POST /api/cos/learning/recalculate-durations - Rebuild success-only duration stats from agent archive
router.post('/learning/recalculate-durations', asyncHandler(async (req, res) => {
  const result = await taskLearning.recalculateDurationStats();
  res.json({ success: true, ...result });
}));

// GET /api/cos/learning/confidence - Get confidence levels for all task types
router.get('/learning/confidence', asyncHandler(async (req, res) => {
  const state = await loadState();
  const thresholds = state.config?.confidenceAutoApproval ?? {};
  const confidence = await taskLearning.getConfidenceLevels(thresholds);
  res.json(confidence);
}));

// GET /api/cos/learning/confidence/:taskType - Get confidence for specific task type
router.get('/learning/confidence/:taskType', asyncHandler(async (req, res) => {
  const state = await loadState();
  const thresholds = state.config?.confidenceAutoApproval ?? {};
  const confidence = await taskLearning.getTaskTypeConfidence(req.params.taskType, thresholds);
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

// GET /api/cos/digest/text - Get text summary suitable for notifications
router.get('/digest/text', asyncHandler(async (req, res) => {
  const text = await weeklyDigest.generateTextSummary();
  res.type('text/plain').send(text);
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
  const { weekId } = req.body;
  const digest = await weeklyDigest.generateWeeklyDigest(weekId || null);
  res.json(digest);
}));

// GET /api/cos/digest/compare - Compare two weeks
router.get('/digest/compare', asyncHandler(async (req, res) => {
  const { week1, week2 } = req.query;

  if (!week1 || !week2) {
    throw new ServerError('Both week1 and week2 query parameters are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const comparison = await weeklyDigest.compareWeeks(week1, week2);
  if (!comparison) {
    throw new ServerError('One or both weeks not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(comparison);
}));

export default router;
