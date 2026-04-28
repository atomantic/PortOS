/**
 * CoS Task Schedule Routes
 */

import { Router } from 'express';
import * as taskSchedule from '../services/taskSchedule.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { sanitizeTaskMetadata } from '../lib/validation.js';

const router = Router();

const SCHEDULE_FIELDS = ['type', 'enabled', 'intervalMs', 'cronExpression', 'providerId', 'model', 'prompt', 'taskMetadata', 'runAfter'];

/**
 * Pick only defined values from body for schedule settings updates
 */
function pickScheduleSettings(body) {
  const settings = {};
  for (const key of SCHEDULE_FIELDS) {
    if (body[key] !== undefined) settings[key] = body[key];
  }
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.intervalMs !== undefined && settings.intervalMs !== null && (typeof settings.intervalMs !== 'number' || settings.intervalMs < 0)) {
    throw new ServerError('intervalMs must be a non-negative number or null', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.taskMetadata !== undefined && settings.taskMetadata !== null) {
    if (typeof settings.taskMetadata !== 'object' || Array.isArray(settings.taskMetadata)) {
      throw new ServerError('taskMetadata must be an object or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const sanitized = sanitizeTaskMetadata(settings.taskMetadata);
    if (sanitized === null) {
      throw new ServerError('Invalid taskMetadata: unrecognized keys or values', { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.taskMetadata = sanitized;
  }
  if (settings.runAfter !== undefined && settings.runAfter !== null) {
    if (!Array.isArray(settings.runAfter)) {
      throw new ServerError('runAfter must be an array of task type strings or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (!settings.runAfter.every(v => typeof v === 'string')) {
      throw new ServerError('runAfter entries must be strings', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (settings.runAfter.length === 0) {
      settings.runAfter = null;
    }
  }
  return settings;
}

// GET /api/cos/schedule - Get full schedule status
router.get('/schedule', asyncHandler(async (req, res) => {
  const status = await taskSchedule.getScheduleStatus();
  res.json(status);
}));

// GET /api/cos/upcoming - Get upcoming tasks preview
router.get('/upcoming', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const upcoming = await taskSchedule.getUpcomingTasks(limit);
  res.json(upcoming);
}));

// GET /api/cos/schedule/task/:taskType - Get interval for a task type (unified)
router.get('/schedule/task/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const interval = await taskSchedule.getTaskInterval(taskType);
  const shouldRun = await taskSchedule.shouldRunTask(taskType);
  res.json({ taskType, interval, shouldRun });
}));

// PUT /api/cos/schedule/task/:taskType - Update interval for a task type (unified)
router.put('/schedule/task/:taskType', asyncHandler(async (req, res) => {
  const { taskType } = req.params;
  const settings = pickScheduleSettings(req.body);
  // Filter self-references from runAfter to prevent permanent blocking
  if (Array.isArray(settings.runAfter)) {
    settings.runAfter = settings.runAfter.filter(dep => dep !== taskType);
    if (settings.runAfter.length === 0) settings.runAfter = null;
  }
  const result = await taskSchedule.updateTaskInterval(taskType, settings);
  res.json({ success: true, taskType, interval: result });
}));

// GET /api/cos/schedule/due - Get all tasks that are due to run
router.get('/schedule/due', asyncHandler(async (req, res) => {
  const tasks = await taskSchedule.getDueTasks();
  res.json({ tasks });
}));

// GET /api/cos/schedule/due/:appId - Get tasks due for specific app
router.get('/schedule/due/:appId', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const tasks = await taskSchedule.getDueTasks(appId);
  res.json({ appId, tasks });
}));

// POST /api/cos/schedule/trigger - Trigger an on-demand task
router.post('/schedule/trigger', asyncHandler(async (req, res) => {
  const { taskType, appId } = req.body;

  if (!taskType) {
    throw new ServerError('taskType is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const request = await taskSchedule.triggerOnDemandTask(taskType, appId);
  if (request?.error) {
    throw new ServerError(request.error, { status: 409, code: 'TRIGGER_REJECTED' });
  }
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
  const { taskType, appId } = req.body;

  if (!taskType) {
    throw new ServerError('taskType is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await taskSchedule.resetExecutionHistory(taskType, appId);
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
      custom: 'Custom interval in milliseconds',
      cron: 'Cron expression schedule (minute hour dayOfMonth month dayOfWeek)'
    }
  });
});

export default router;
