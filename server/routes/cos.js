/**
 * Chief of Staff API Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import * as appActivity from '../services/appActivity.js';
import * as taskLearning from '../services/taskLearning.js';
import * as weeklyDigest from '../services/weeklyDigest.js';
import * as taskSchedule from '../services/taskSchedule.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import * as taskTemplates from '../services/taskTemplates.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import * as productivity from '../services/productivity.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/cos - Get CoS status
router.get('/', asyncHandler(async (req, res) => {
  const status = await cos.getStatus();
  res.json(status);
}));

// POST /api/cos/start - Start CoS daemon
router.post('/start', asyncHandler(async (req, res) => {
  const result = await cos.start();
  await taskWatcher.startWatching();
  res.json(result);
}));

// POST /api/cos/stop - Stop CoS daemon
router.post('/stop', asyncHandler(async (req, res) => {
  const result = await cos.stop();
  await taskWatcher.stopWatching();
  res.json(result);
}));

// POST /api/cos/pause - Pause CoS daemon (stays running but skips evaluations)
router.post('/pause', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const result = await cos.pause(reason);
  res.json(result);
}));

// POST /api/cos/resume - Resume CoS daemon from pause
router.post('/resume', asyncHandler(async (req, res) => {
  const result = await cos.resume();
  res.json(result);
}));

// GET /api/cos/config - Get configuration
router.get('/config', asyncHandler(async (req, res) => {
  const config = await cos.getConfig();
  res.json(config);
}));

// PUT /api/cos/config - Update configuration
router.put('/config', asyncHandler(async (req, res) => {
  const config = await cos.updateConfig(req.body);
  res.json(config);
}));

// GET /api/cos/tasks - Get all tasks
router.get('/tasks', asyncHandler(async (req, res) => {
  const tasks = await cos.getAllTasks();
  res.json(tasks);
}));

// GET /api/cos/tasks/user - Get user tasks
router.get('/tasks/user', asyncHandler(async (req, res) => {
  const tasks = await cos.getUserTasks();
  res.json(tasks);
}));

// GET /api/cos/tasks/internal - Get CoS internal tasks
router.get('/tasks/internal', asyncHandler(async (req, res) => {
  const tasks = await cos.getCosTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/refresh - Force refresh tasks
router.post('/tasks/refresh', asyncHandler(async (req, res) => {
  const tasks = await taskWatcher.refreshTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/reorder - Reorder tasks
router.post('/tasks/reorder', asyncHandler(async (req, res) => {
  const { taskIds } = req.body;

  if (!taskIds || !Array.isArray(taskIds)) {
    throw new ServerError('taskIds array is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await cos.reorderTasks(taskIds);
  res.json(result);
}));

// POST /api/cos/tasks/enhance - Enhance a task prompt with AI
router.post('/tasks/enhance', asyncHandler(async (req, res) => {
  const { description, context } = req.body;

  if (!description) {
    throw new ServerError('Description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await enhanceTaskPrompt(description, context);
  res.json(result);
}));

// POST /api/cos/tasks - Add a new task
router.post('/tasks', asyncHandler(async (req, res) => {
  const { description, priority, context, model, provider, app, type = 'user', approvalRequired, screenshots, attachments, position = 'bottom' } = req.body;

  if (!description) {
    throw new ServerError('Description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const taskData = { description, priority, context, model, provider, app, approvalRequired, screenshots, attachments, position };
  const result = await cos.addTask(taskData, type);
  res.json(result);
}));

// PUT /api/cos/tasks/:id - Update a task
router.put('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { description, priority, status, context, model, provider, app, blockedReason, type = 'user' } = req.body;

  const updates = {};
  if (description !== undefined) updates.description = description;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) updates.status = status;
  if (context !== undefined) updates.context = context;
  if (model !== undefined) updates.model = model;
  if (provider !== undefined) updates.provider = provider;
  if (app !== undefined) updates.app = app;

  // Handle blocker metadata - set when marking as blocked, clear when unblocking
  if (status === 'blocked' && blockedReason) {
    updates.metadata = { blocker: blockedReason };
  } else if (status && status !== 'blocked') {
    // Clear blocker when moving out of blocked status
    updates.metadata = { blocker: undefined };
  }

  const result = await cos.updateTask(id, updates, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// DELETE /api/cos/tasks/:id - Delete a task
router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type = 'user' } = req.query;

  const result = await cos.deleteTask(id, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// POST /api/cos/tasks/:id/approve - Approve a task
router.post('/tasks/:id/approve', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await cos.approveTask(id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(result);
}));

// POST /api/cos/evaluate - Force task evaluation
router.post('/evaluate', asyncHandler(async (req, res) => {
  await cos.evaluateTasks();
  res.json({ success: true, message: 'Evaluation triggered' });
}));

// GET /api/cos/health - Get health status
router.get('/health', asyncHandler(async (req, res) => {
  const health = await cos.getHealthStatus();
  res.json(health);
}));

// POST /api/cos/health/check - Force health check
router.post('/health/check', asyncHandler(async (req, res) => {
  const result = await cos.runHealthCheck();
  res.json(result);
}));

// GET /api/cos/agents - Get all agents (auto-cleans zombies)
router.get('/agents', asyncHandler(async (req, res) => {
  // Cleanup zombie agents before returning list
  await cos.cleanupZombieAgents();
  const agents = await cos.getAgents();
  res.json(agents);
}));

// GET /api/cos/agents/:id - Get agent by ID
router.get('/agents/:id', asyncHandler(async (req, res) => {
  const agent = await cos.getAgent(req.params.id);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(agent);
}));

// POST /api/cos/agents/:id/terminate - Terminate agent (graceful SIGTERM, then SIGKILL)
router.post('/agents/:id/terminate', asyncHandler(async (req, res) => {
  const result = await cos.terminateAgent(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/kill - Force kill agent (immediate SIGKILL)
router.post('/agents/:id/kill', asyncHandler(async (req, res) => {
  const result = await cos.killAgent(req.params.id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// GET /api/cos/agents/:id/stats - Get process stats for agent (CPU, memory)
router.get('/agents/:id/stats', asyncHandler(async (req, res) => {
  const stats = await cos.getAgentProcessStats(req.params.id);
  // Return success with active:false instead of 404 - this is expected when process isn't running
  res.json(stats || { active: false, pid: null });
}));

// DELETE /api/cos/agents/completed - Clear completed agents (must be before :id route)
router.delete('/agents/completed', asyncHandler(async (req, res) => {
  const result = await cos.clearCompletedAgents();
  res.json(result);
}));

// DELETE /api/cos/agents/:id - Delete a single agent
router.delete('/agents/:id', asyncHandler(async (req, res) => {
  const result = await cos.deleteAgent(req.params.id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// GET /api/cos/reports - List all reports
router.get('/reports', asyncHandler(async (req, res) => {
  const reports = await cos.listReports();
  res.json(reports);
}));

// GET /api/cos/reports/today - Get today's report
router.get('/reports/today', asyncHandler(async (req, res) => {
  const report = await cos.getTodayReport();
  res.json(report);
}));

// GET /api/cos/reports/:date - Get report by date
router.get('/reports/:date', asyncHandler(async (req, res) => {
  const report = await cos.getReport(req.params.date);
  if (!report) {
    throw new ServerError('Report not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(report);
}));

// POST /api/cos/reports/generate - Generate report for date
router.post('/reports/generate', asyncHandler(async (req, res) => {
  const { date } = req.body;
  const report = await cos.generateReport(date);
  res.json(report);
}));

// GET /api/cos/briefings - List all briefings
router.get('/briefings', asyncHandler(async (req, res) => {
  const briefings = await cos.listBriefings();
  res.json({ briefings });
}));

// GET /api/cos/briefings/latest - Get latest briefing
router.get('/briefings/latest', asyncHandler(async (req, res) => {
  const briefing = await cos.getLatestBriefing();
  res.json(briefing);
}));

// GET /api/cos/briefings/:date - Get briefing by date
router.get('/briefings/:date', asyncHandler(async (req, res) => {
  const briefing = await cos.getBriefing(req.params.date);
  if (!briefing) {
    throw new ServerError('Briefing not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(briefing);
}));

// GET /api/cos/scripts - List generated scripts
router.get('/scripts', asyncHandler(async (req, res) => {
  const scripts = await cos.listScripts();
  res.json(scripts);
}));

// GET /api/cos/scripts/:name - Get script content
router.get('/scripts/:name', asyncHandler(async (req, res) => {
  const script = await cos.getScript(req.params.name);
  if (!script) {
    throw new ServerError('Script not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(script);
}));

// GET /api/cos/watcher - Get watcher status
router.get('/watcher', (req, res) => {
  res.json(taskWatcher.getWatcherStatus());
});

// GET /api/cos/app-activity - Get per-app activity data
router.get('/app-activity', asyncHandler(async (req, res) => {
  const activity = await appActivity.loadAppActivity();
  res.json(activity);
}));

// GET /api/cos/app-activity/:appId - Get activity for specific app
router.get('/app-activity/:appId', asyncHandler(async (req, res) => {
  const activity = await appActivity.getAppActivityById(req.params.appId);
  if (!activity) {
    res.json({ appId: req.params.appId, activity: null, message: 'No activity recorded for this app' });
    return;
  }
  res.json({ appId: req.params.appId, activity });
}));

// POST /api/cos/app-activity/:appId/clear-cooldown - Clear cooldown for an app
router.post('/app-activity/:appId/clear-cooldown', asyncHandler(async (req, res) => {
  const result = await appActivity.clearAppCooldown(req.params.appId);
  res.json({ success: true, appId: req.params.appId, activity: result });
}));

// GET /api/cos/activity/today - Get today's activity summary
router.get('/activity/today', asyncHandler(async (req, res) => {
  const activity = await cos.getTodayActivity();
  res.json(activity);
}));

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

// ============================================================
// Task Schedule Routes (Configurable Intervals)
// ============================================================

// GET /api/cos/schedule - Get full schedule status
router.get('/schedule', asyncHandler(async (req, res) => {
  const status = await taskSchedule.getScheduleStatus();
  res.json(status);
}));

// GET /api/cos/schedule/self-improvement/:taskType - Get interval for self-improvement task
router.get('/schedule/self-improvement/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const interval = await taskSchedule.getSelfImprovementInterval(taskType);
  const shouldRun = await taskSchedule.shouldRunSelfImprovementTask(taskType);
  res.json({ taskType, interval, shouldRun });
}));

// PUT /api/cos/schedule/self-improvement/:taskType - Update interval for self-improvement task
router.put('/schedule/self-improvement/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const { type, enabled, intervalMs, providerId, model, prompt } = req.body;

  const settings = {};
  if (type !== undefined) settings.type = type;
  if (enabled !== undefined) settings.enabled = enabled;
  if (intervalMs !== undefined) settings.intervalMs = intervalMs;
  if (providerId !== undefined) settings.providerId = providerId;
  if (model !== undefined) settings.model = model;
  if (prompt !== undefined) settings.prompt = prompt;

  const result = await taskSchedule.updateSelfImprovementInterval(taskType, settings);
  res.json({ success: true, taskType, interval: result });
}));

// GET /api/cos/schedule/app-improvement/:taskType - Get interval for app improvement task
router.get('/schedule/app-improvement/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const interval = await taskSchedule.getAppImprovementInterval(taskType);
  res.json({ taskType, interval });
}));

// PUT /api/cos/schedule/app-improvement/:taskType - Update interval for app improvement task
router.put('/schedule/app-improvement/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const { type, enabled, intervalMs, providerId, model, prompt } = req.body;

  const settings = {};
  if (type !== undefined) settings.type = type;
  if (enabled !== undefined) settings.enabled = enabled;
  if (intervalMs !== undefined) settings.intervalMs = intervalMs;
  if (providerId !== undefined) settings.providerId = providerId;
  if (model !== undefined) settings.model = model;
  if (prompt !== undefined) settings.prompt = prompt;

  const result = await taskSchedule.updateAppImprovementInterval(taskType, settings);
  res.json({ success: true, taskType, interval: result });
}));

// GET /api/cos/schedule/due - Get all tasks that are due to run
router.get('/schedule/due', asyncHandler(async (req, res) => {
  const selfImprovement = await taskSchedule.getDueSelfImprovementTasks();
  res.json({ selfImprovement, appImprovement: 'requires appId - use /schedule/due/:appId' });
}));

// GET /api/cos/schedule/due/:appId - Get app improvement tasks due for specific app
router.get('/schedule/due/:appId', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const appImprovement = await taskSchedule.getDueAppImprovementTasks(appId);
  res.json({ appId, appImprovement });
}));

// POST /api/cos/schedule/trigger - Trigger an on-demand task
router.post('/schedule/trigger', asyncHandler(async (req, res) => {
  const { taskType, category, appId } = req.body;

  if (!taskType) {
    throw new ServerError('taskType is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const request = await taskSchedule.triggerOnDemandTask(taskType, category || 'selfImprovement', appId);
  res.json({ success: true, request });
}));

// GET /api/cos/schedule/on-demand - Get pending on-demand requests
router.get('/schedule/on-demand', asyncHandler(async (req, res) => {
  const requests = await taskSchedule.getOnDemandRequests();
  res.json({ requests });
}));

// DELETE /api/cos/schedule/on-demand/:requestId - Clear an on-demand request
router.delete('/schedule/on-demand/:requestId', asyncHandler(async (req, res) => {
  const { requestId } = req.params;
  const cleared = await taskSchedule.clearOnDemandRequest(requestId);
  if (!cleared) {
    throw new ServerError('Request not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, cleared });
}));

// POST /api/cos/schedule/reset - Reset execution history for a task type
router.post('/schedule/reset', asyncHandler(async (req, res) => {
  const { taskType, category, appId } = req.body;

  if (!taskType) {
    throw new ServerError('taskType is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await taskSchedule.resetExecutionHistory(taskType, category || 'selfImprovement', appId);
  if (result.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// GET /api/cos/schedule/templates - Get all template tasks
router.get('/schedule/templates', asyncHandler(async (req, res) => {
  const templates = await taskSchedule.getTemplateTasks();
  res.json({ templates });
}));

// POST /api/cos/schedule/templates - Add a template task
router.post('/schedule/templates', asyncHandler(async (req, res) => {
  const { name, description, category, taskType, priority, metadata } = req.body;

  if (!name || !description) {
    throw new ServerError('name and description are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const template = await taskSchedule.addTemplateTask({
    name,
    description,
    category,
    taskType,
    priority,
    metadata
  });
  res.json({ success: true, template });
}));

// DELETE /api/cos/schedule/templates/:templateId - Delete a template task
router.delete('/schedule/templates/:templateId', asyncHandler(async (req, res) => {
  const { templateId } = req.params;
  const result = await taskSchedule.deleteTemplateTask(templateId);
  if (result.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// GET /api/cos/schedule/interval-types - Get available interval types
router.get('/schedule/interval-types', (req, res) => {
  res.json({
    types: taskSchedule.INTERVAL_TYPES,
    descriptions: {
      rotation: 'Runs as part of normal task rotation (default)',
      daily: 'Runs once per day',
      weekly: 'Runs once per week',
      once: 'Runs once per app or globally, then stops',
      'on-demand': 'Only runs when manually triggered',
      custom: 'Custom interval in milliseconds'
    }
  });
});

// ============================================================
// Autonomous Jobs Routes
// ============================================================

// GET /api/cos/jobs - Get all autonomous jobs
router.get('/jobs', asyncHandler(async (req, res) => {
  const jobs = await autonomousJobs.getAllJobs();
  const stats = await autonomousJobs.getJobStats();
  res.json({ jobs, stats });
}));

// GET /api/cos/jobs/due - Get jobs that are due to run
router.get('/jobs/due', asyncHandler(async (req, res) => {
  const due = await autonomousJobs.getDueJobs();
  res.json({ due });
}));

// GET /api/cos/jobs/intervals - Get available interval options
router.get('/jobs/intervals', (req, res) => {
  res.json({ intervals: autonomousJobs.INTERVAL_OPTIONS });
});

// GET /api/cos/jobs/:id - Get a single job
router.get('/jobs/:id', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.getJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(job);
}));

// POST /api/cos/jobs - Create a new autonomous job
router.post('/jobs', asyncHandler(async (req, res) => {
  const { name, description, category, interval, intervalMs, scheduledTime, enabled, priority, autonomyLevel, promptTemplate } = req.body;

  if (!name || !promptTemplate) {
    throw new ServerError('name and promptTemplate are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const job = await autonomousJobs.createJob({
    name, description, category, interval, intervalMs, scheduledTime,
    enabled, priority, autonomyLevel, promptTemplate
  });
  res.json({ success: true, job });
}));

// PUT /api/cos/jobs/:id - Update a job
router.put('/jobs/:id', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.updateJob(req.params.id, req.body);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, job });
}));

// POST /api/cos/jobs/:id/toggle - Toggle job enabled/disabled
router.post('/jobs/:id/toggle', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.toggleJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, job });
}));

// POST /api/cos/jobs/:id/trigger - Manually trigger a job now
router.post('/jobs/:id/trigger', asyncHandler(async (req, res) => {
  const job = await autonomousJobs.getJob(req.params.id);
  if (!job) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Generate task and add to CoS internal task queue
  // Job execution is recorded via the job:spawned event when the agent actually starts
  const task = await autonomousJobs.generateTaskFromJob(job);
  const result = await cos.addTask({
    description: task.description,
    priority: task.priority,
    context: `Manually triggered autonomous job: ${job.name}`,
    approvalRequired: !task.autoApprove
  }, 'internal');

  res.json({ success: true, task: result });
}));

// DELETE /api/cos/jobs/:id - Delete a job
router.delete('/jobs/:id', asyncHandler(async (req, res) => {
  const deleted = await autonomousJobs.deleteJob(req.params.id);
  if (!deleted) {
    throw new ServerError('Job not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

// ============================================================
// Quick Task Templates Routes
// ============================================================

// GET /api/cos/templates - Get all task templates
router.get('/templates', asyncHandler(async (req, res) => {
  const templates = await taskTemplates.getAllTemplates();
  res.json({ templates });
}));

// GET /api/cos/templates/popular - Get popular templates
router.get('/templates/popular', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 5;
  const templates = await taskTemplates.getPopularTemplates(limit);
  res.json({ templates });
}));

// GET /api/cos/templates/categories - Get template categories
router.get('/templates/categories', asyncHandler(async (req, res) => {
  const categories = await taskTemplates.getCategories();
  res.json({ categories });
}));

// POST /api/cos/templates - Create a new template
router.post('/templates', asyncHandler(async (req, res) => {
  const { name, icon, description, context, category, provider, model, app } = req.body;

  if (!name || !description) {
    throw new ServerError('name and description are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const template = await taskTemplates.createTemplate({
    name, icon, description, context, category, provider, model, app
  });
  res.json({ success: true, template });
}));

// POST /api/cos/templates/from-task - Create template from task
router.post('/templates/from-task', asyncHandler(async (req, res) => {
  const { task, templateName } = req.body;

  if (!task || !task.description) {
    throw new ServerError('task with description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const template = await taskTemplates.createTemplateFromTask(task, templateName);
  res.json({ success: true, template });
}));

// POST /api/cos/templates/:id/use - Record template usage
router.post('/templates/:id/use', asyncHandler(async (req, res) => {
  const useCount = await taskTemplates.recordTemplateUsage(req.params.id);
  res.json({ success: true, useCount });
}));

// PUT /api/cos/templates/:id - Update a template
router.put('/templates/:id', asyncHandler(async (req, res) => {
  const result = await taskTemplates.updateTemplate(req.params.id, req.body);
  if (result.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json({ success: true, template: result });
}));

// DELETE /api/cos/templates/:id - Delete a template
router.delete('/templates/:id', asyncHandler(async (req, res) => {
  const result = await taskTemplates.deleteTemplate(req.params.id);
  if (result.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(result);
}));

// ============================================================
// Productivity & Streaks Routes
// ============================================================

// GET /api/cos/productivity - Get productivity insights and streaks
router.get('/productivity', asyncHandler(async (req, res) => {
  const insights = await productivity.getProductivityInsights();
  res.json(insights);
}));

// GET /api/cos/productivity/summary - Get quick summary for dashboard
router.get('/productivity/summary', asyncHandler(async (req, res) => {
  const summary = await productivity.getProductivitySummary();
  res.json(summary);
}));

// POST /api/cos/productivity/recalculate - Force recalculation from history
router.post('/productivity/recalculate', asyncHandler(async (req, res) => {
  const data = await productivity.recalculateProductivity();
  res.json({ success: true, data });
}));

// GET /api/cos/productivity/trends - Get daily task completion trends for charting
router.get('/productivity/trends', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const trends = await productivity.getDailyTrends(days);
  res.json(trends);
}));

// GET /api/cos/actionable-insights - Get prioritized action items requiring user attention
// Surfaces the most important things to address right now across all CoS subsystems
router.get('/actionable-insights', asyncHandler(async (req, res) => {
  const [tasksData, learningSummary, healthCheck, notificationsModule] = await Promise.all([
    cos.getAllTasks().catch(() => ({ user: null, cos: null })),
    taskLearning.getLearningInsights().catch(() => null),
    cos.runHealthCheck().catch(() => ({ issues: [] })),
    import('../services/notifications.js')
  ]);

  const notificationsData = await notificationsModule.getNotifications({ unreadOnly: true, limit: 10 }).catch(() => []);

  const insights = [];

  // 1. Pending approvals (highest priority)
  const pendingApprovals = tasksData.cos?.awaitingApproval || [];
  if (pendingApprovals.length > 0) {
    insights.push({
      type: 'approval',
      priority: 'high',
      icon: 'AlertCircle',
      title: `${pendingApprovals.length} task${pendingApprovals.length > 1 ? 's' : ''} awaiting approval`,
      description: pendingApprovals[0]?.description?.substring(0, 80) + (pendingApprovals[0]?.description?.length > 80 ? '...' : ''),
      action: { label: 'Review', route: '/cos/tasks' },
      count: pendingApprovals.length
    });
  }

  // 2. Blocked tasks
  const blockedUser = tasksData.user?.grouped?.blocked || [];
  const blockedCos = tasksData.cos?.grouped?.blocked || [];
  const blockedCount = blockedUser.length + blockedCos.length;
  if (blockedCount > 0) {
    const firstBlocked = blockedUser[0] || blockedCos[0];
    insights.push({
      type: 'blocked',
      priority: 'high',
      icon: 'XCircle',
      title: `${blockedCount} blocked task${blockedCount > 1 ? 's' : ''}`,
      description: firstBlocked?.metadata?.blocker || firstBlocked?.description?.substring(0, 80),
      action: { label: 'Unblock', route: '/cos/tasks' },
      count: blockedCount
    });
  }

  // 3. Health issues
  const healthIssues = healthCheck?.issues || [];
  if (healthIssues.length > 0) {
    const criticalIssues = healthIssues.filter(i => i.severity === 'critical');
    insights.push({
      type: 'health',
      priority: criticalIssues.length > 0 ? 'critical' : 'medium',
      icon: 'AlertTriangle',
      title: `${healthIssues.length} system health issue${healthIssues.length > 1 ? 's' : ''}`,
      description: healthIssues[0]?.message,
      action: { label: 'Check Health', route: '/cos/health' },
      count: healthIssues.length
    });
  }

  // 4. Learning failures (skipped task types)
  const skippedTypes = learningSummary?.skippedTypes || [];
  if (skippedTypes.length > 0) {
    insights.push({
      type: 'learning',
      priority: 'low',
      icon: 'Brain',
      title: `${skippedTypes.length} task type${skippedTypes.length > 1 ? 's' : ''} auto-skipped`,
      description: `Due to low success rates: ${skippedTypes.slice(0, 2).map(t => t.type).join(', ')}`,
      action: { label: 'View Learning', route: '/cos/learning' },
      count: skippedTypes.length
    });
  }

  // 5. Unread notifications (briefings, reviews, etc.)
  const briefingNotifs = notificationsData.filter(n => n.type === 'briefing_ready');
  if (briefingNotifs.length > 0) {
    insights.push({
      type: 'briefing',
      priority: 'low',
      icon: 'Newspaper',
      title: 'New briefing available',
      description: 'Your daily briefing is ready for review',
      action: { label: 'Read Briefing', route: '/cos/briefing' },
      count: 1
    });
  }

  // 6. Pending user tasks (informational)
  const pendingUserTasks = tasksData.user?.grouped?.pending || [];
  if (pendingUserTasks.length > 0 && insights.length < 4) {
    insights.push({
      type: 'tasks',
      priority: 'info',
      icon: 'ListTodo',
      title: `${pendingUserTasks.length} pending task${pendingUserTasks.length > 1 ? 's' : ''}`,
      description: pendingUserTasks[0]?.description?.substring(0, 80),
      action: { label: 'View Tasks', route: '/cos/tasks' },
      count: pendingUserTasks.length
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  insights.sort((a, b) => (priorityOrder[a.priority] || 5) - (priorityOrder[b.priority] || 5));

  res.json({
    insights: insights.slice(0, 5), // Max 5 insights
    hasActionableItems: insights.some(i => ['critical', 'high'].includes(i.priority)),
    totalCount: insights.length
  });
}));

// GET /api/cos/recent-tasks - Get recent completed tasks for dashboard widget
router.get('/recent-tasks', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const recentTasks = await cos.getRecentTasks(limit);
  res.json(recentTasks);
}));

// GET /api/cos/quick-summary - Get at-a-glance dashboard summary
// Combines today's activity, streak status, next job, and pending approvals into one efficient call
router.get('/quick-summary', asyncHandler(async (req, res) => {
  const [todayActivity, productivityData, tasksData, jobStats] = await Promise.all([
    cos.getTodayActivity(),
    productivity.getProductivitySummary(),
    cos.getAllTasks(),
    autonomousJobs.getJobStats()
  ]);

  // Count pending approvals from system tasks
  const pendingApprovals = tasksData.cos?.awaitingApproval?.length || 0;

  // Count pending user tasks
  const pendingUserTasks = tasksData.user?.grouped?.pending?.length || 0;

  res.json({
    today: {
      completed: todayActivity.stats.completed,
      succeeded: todayActivity.stats.succeeded,
      failed: todayActivity.stats.failed,
      running: todayActivity.stats.running,
      successRate: todayActivity.stats.successRate,
      timeWorked: todayActivity.time.combined
    },
    streak: {
      current: productivityData.currentStreak,
      longest: productivityData.longestStreak,
      weekly: productivityData.weeklyStreak,
      lastActive: productivityData.lastActive
    },
    nextJob: jobStats.nextDue,
    queue: {
      pendingApprovals,
      pendingUserTasks,
      total: pendingApprovals + pendingUserTasks
    },
    status: {
      running: todayActivity.isRunning,
      paused: todayActivity.isPaused,
      lastEvaluation: todayActivity.lastEvaluation
    }
  });
}));

export default router;
