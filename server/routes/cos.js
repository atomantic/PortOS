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

// POST /api/cos/tasks - Add a new task
router.post('/tasks', asyncHandler(async (req, res) => {
  const { description, priority, context, model, provider, app, type = 'user', approvalRequired, screenshots } = req.body;

  if (!description) {
    throw new ServerError('Description is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const taskData = { description, priority, context, model, provider, app, approvalRequired, screenshots };
  const result = await cos.addTask(taskData, type);
  res.json(result);
}));

// PUT /api/cos/tasks/:id - Update a task
router.put('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { description, priority, status, context, model, provider, app, type = 'user' } = req.body;

  const updates = {};
  if (description !== undefined) updates.description = description;
  if (priority !== undefined) updates.priority = priority;
  if (status !== undefined) updates.status = status;
  if (context !== undefined) updates.context = context;
  if (model !== undefined) updates.model = model;
  if (provider !== undefined) updates.provider = provider;
  if (app !== undefined) updates.app = app;

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

// DELETE /api/cos/agents/:id - Delete a single agent
router.delete('/agents/:id', asyncHandler(async (req, res) => {
  const result = await cos.deleteAgent(req.params.id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// DELETE /api/cos/agents/completed - Clear completed agents
router.delete('/agents/completed', asyncHandler(async (req, res) => {
  const result = await cos.clearCompletedAgents();
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

// GET /api/cos/learning/cooldown/:taskType - Get adaptive cooldown for specific task type
router.get('/learning/cooldown/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const cooldownInfo = await taskLearning.getAdaptiveCooldownMultiplier(taskType);
  res.json({
    taskType,
    ...cooldownInfo
  });
}));

// GET /api/cos/learning/performance - Get performance summary
router.get('/learning/performance', asyncHandler(async (req, res) => {
  const summary = await taskLearning.getPerformanceSummary();
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
  const { type, enabled, intervalMs } = req.body;

  const settings = {};
  if (type !== undefined) settings.type = type;
  if (enabled !== undefined) settings.enabled = enabled;
  if (intervalMs !== undefined) settings.intervalMs = intervalMs;

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
  const { type, enabled, intervalMs } = req.body;

  const settings = {};
  if (type !== undefined) settings.type = type;
  if (enabled !== undefined) settings.enabled = enabled;
  if (intervalMs !== undefined) settings.intervalMs = intervalMs;

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

export default router;
