import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
/**
 * CoS Task Schedule Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import * as taskSchedule from '../services/taskSchedule.js';
import { logCosScheduleUpdate } from '../services/userActionScheduleLog.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { sanitizeTaskMetadata, taskDataInputsSchema, validateRequest, parsePagination } from '../lib/validation.js';
import { promptSourceSchema, PROMPT_SOURCES } from '../lib/cosValidation.js';
import { EFFORT_LEVELS } from '../lib/providerModels.js';
import { INTERVAL_TYPES, decodeIntervalType, isCronExpression, isKnownIntervalType } from '../services/taskScheduleConstants.js';
import { normalizeSuggestedAfter, SUGGESTED_AFTER_MAX } from '../lib/scheduleRunOrder.js';
import { findCronExpressionError } from '../lib/cronValidation.js';
import { updateMaintenanceStep, listMaintenanceRuns, resumeMaintenanceRun, startMaintenanceRun, stopMaintenanceRun } from '../services/maintenanceRun.js';

const templateTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().optional(),
  taskType: z.string().optional(),
  priority: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const scheduleLabelsSchema = z.array(z.string().trim().min(1).max(40)).max(20)
  .transform(labels => [...new Set(labels.map(label => label.toLowerCase()))]);

// Shape only — normalizeSuggestedAfter does the trimming, self-drop and dedupe
// so the storage rules live with the field's own helper, not in the route.
const suggestedAfterSchema = z.array(z.string()).max(SUGGESTED_AFTER_MAX);

// A manual maintenance run names the app, the subscription provider and the
// model up front (AGENTS.md AI-policy: the click IS the consent). Blank effort
// inherits each scheduled task's saved effort.
const maintenanceRunStartSchema = z.object({
  taskTypes: z.array(z.enum(Object.keys(AUDIT_DEFINITIONS))).min(1).max(Object.keys(AUDIT_DEFINITIONS).length).optional(),
  mode: z.enum(['file-issues', 'fix']).optional(),
  claimBetweenAudits: z.boolean().optional(),
  claimHandler: z.object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  }).nullable().optional(),
  appId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

const router = Router();

const SCHEDULE_FIELDS = ['type', 'autoStart', 'perpetual', 'enabled', 'intervalMs', 'cronExpression', 'providerId', 'model', 'effort', 'prompt', 'description', 'labels', 'dataInputs', 'taskMetadata', 'runAfter',
  // Advisory run order — which OTHER scheduled tasks a user should generally run
  // first. Editable and unenforced; `runAfter` above is the enforced gate.
  'suggestedAfter',
  // Perpetual (drain-until-done) recheck cadence: after a perpetual task drains
  // its backlog and parks, it re-probes its work-detector on this cadence.
  // `recheckCron` (5-field) takes precedence over `recheckIntervalMs`.
  'recheckCron', 'recheckIntervalMs',
  // Provenance of the stored prompt ('user' | 'legacy-inferred' | null). An
  // explicit prompt write re-stamps it below in updateTaskInterval, so a body
  // carrying it only matters when the prompt itself is not being changed.
  'promptSource'];

/**
 * Pick only defined values from body for schedule settings updates. `taskType`
 * is the row being written, so a field that must not name itself (the advisory
 * `suggestedAfter`) can be cleaned here rather than again at the call site.
 */
function pickScheduleSettings(body, taskType) {
  const settings = {};
  for (const key of SCHEDULE_FIELDS) {
    if (body[key] !== undefined) settings[key] = body[key];
  }
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.autoStart !== undefined && typeof settings.autoStart !== 'boolean') {
    throw new ServerError('autoStart must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.perpetual !== undefined && typeof settings.perpetual !== 'boolean') {
    throw new ServerError('perpetual must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.type !== undefined) {
    // Reject an unrecognized string outright — decoding it would silently make
    // an unreadable cadence 'on-demand', i.e. quietly stop the task running.
    if (!isKnownIntervalType(settings.type)) {
      throw new ServerError(`type must be one of ${Object.values(INTERVAL_TYPES).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    // A client still on the previous release (or a peer machine mid-upgrade)
    // may send a retired cadence name. Rewrite it onto the two-variant model
    // rather than 400-ing, so an older UI keeps working through the upgrade.
    const decoded = decodeIntervalType(settings.type, { intervalMs: settings.intervalMs });
    settings.type = decoded.type;
    if (decoded.perpetual && settings.perpetual === undefined) settings.perpetual = true;
    if (decoded.type === INTERVAL_TYPES.CRON && !isCronExpression(settings.cronExpression) && decoded.cronExpression) {
      settings.cronExpression = decoded.cronExpression;
    }
  }
  // Field RANGES, not just the 5-token shape: an out-of-range expression saved
  // on an enabled schedule would be silently dropped by the walker and never
  // fire (#6634).
  if (settings.cronExpression !== undefined && settings.cronExpression !== null) {
    const cronError = findCronExpressionError(settings.cronExpression);
    if (cronError) {
      throw new ServerError(`cronExpression is invalid: ${cronError}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  if (settings.labels !== undefined) {
    const parsed = scheduleLabelsSchema.safeParse(settings.labels);
    if (!parsed.success) {
      throw new ServerError('labels must be at most 20 non-empty strings of at most 40 characters', { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.labels = parsed.data;
  }
  if (settings.description !== undefined) {
    if (settings.description !== null && typeof settings.description !== 'string') {
      throw new ServerError('description must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const description = settings.description == null ? '' : settings.description.trim();
    if (description.length > 240) {
      throw new ServerError('description must be 240 characters or fewer', { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.description = description || null;
  }
  if (settings.intervalMs !== undefined && settings.intervalMs !== null && (typeof settings.intervalMs !== 'number' || settings.intervalMs < 0)) {
    throw new ServerError('intervalMs must be a non-negative number or null', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.recheckIntervalMs !== undefined && settings.recheckIntervalMs !== null && (typeof settings.recheckIntervalMs !== 'number' || settings.recheckIntervalMs < 0)) {
    throw new ServerError('recheckIntervalMs must be a non-negative number or null', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (settings.recheckCron !== undefined && settings.recheckCron !== null) {
    if (typeof settings.recheckCron !== 'string') {
      throw new ServerError('recheckCron must be a cron string or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const trimmed = settings.recheckCron.trim();
    // Empty string clears it; otherwise require a 5-field cron expression.
    if (trimmed === '') {
      settings.recheckCron = null;
    } else {
      // An invalid recheck cron does not merely 'not fire' —
      // computePerpetualRecheckAt silently falls back to another cadence — so
      // reject it here with the same shared validator (#6634).
      const recheckError = findCronExpressionError(trimmed);
      if (recheckError) {
        throw new ServerError(`recheckCron is invalid: ${recheckError}`, { status: 400, code: 'VALIDATION_ERROR' });
      }
      settings.recheckCron = trimmed;
    }
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
  if (settings.dataInputs !== undefined) {
    const parsed = taskDataInputsSchema.safeParse(settings.dataInputs);
    if (!parsed.success) {
      throw new ServerError('dataInputs must contain only registered task data input ids', { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.dataInputs = parsed.data;
  }
  if (settings.promptSource !== undefined) {
    const parsed = promptSourceSchema.safeParse(settings.promptSource);
    if (!parsed.success) {
      throw new ServerError(`promptSource must be one of ${PROMPT_SOURCES.join(', ')} or null`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.promptSource = parsed.data ?? null;
  }
  if (settings.effort !== undefined && settings.effort !== null && !EFFORT_LEVELS.includes(settings.effort)) {
    throw new ServerError(`effort must be one of ${EFFORT_LEVELS.join(', ')} or null`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Advisory ordering. `normalizeSuggestedAfter` owns the shape rules (self,
  // blanks, duplicates, cap) and why an emptied list stays `[]` rather than
  // becoming null the way `runAfter` does.
  if (settings.suggestedAfter !== undefined) {
    const parsed = suggestedAfterSchema.safeParse(settings.suggestedAfter ?? []);
    if (!parsed.success) {
      throw new ServerError(`suggestedAfter must be at most ${SUGGESTED_AFTER_MAX} task type strings, or null`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    settings.suggestedAfter = normalizeSuggestedAfter(parsed.data, taskType);
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
  const { limit } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 500 });
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
  const settings = pickScheduleSettings(req.body, taskType);
  // Filter self-references from runAfter to prevent permanent blocking
  if (Array.isArray(settings.runAfter)) {
    settings.runAfter = settings.runAfter.filter(dep => dep !== taskType);
    if (settings.runAfter.length === 0) settings.runAfter = null;
  }
  const result = await taskSchedule.updateTaskInterval(taskType, settings);
  await logCosScheduleUpdate({
    target: taskType,
    patch: settings,
    source: { route: `${req.baseUrl}${req.route?.path ?? ''}`, method: req.method },
  });
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

// Manual maintenance runs — the Schedule tab's "Run maintenance now"; see
// services/maintenanceRun.js for why this is not a quota burn.
router.get('/schedule/maintenance-runs', asyncHandler(async (_req, res) => {
  res.json({ runs: await listMaintenanceRuns() });
}));

router.post('/schedule/maintenance-runs', asyncHandler(async (req, res) => {
  const body = validateRequest(maintenanceRunStartSchema, req.body || {});
  res.status(201).json(await startMaintenanceRun(body));
}));

router.patch('/schedule/maintenance-runs/:id/steps/:stepId', asyncHandler(async (req, res) => {
  const body = validateRequest(maintenanceRunStartSchema.pick({ providerId: true, model: true, effort: true }), req.body || {});
  const run = await updateMaintenanceStep(req.params.id, req.params.stepId, body);
  if (!run) throw new ServerError('Maintenance run or stage not found', { status: 404 });
  res.json({ run });
}));

router.post('/schedule/maintenance-runs/:id/stop', asyncHandler(async (req, res) => {
  const run = await stopMaintenanceRun(req.params.id);
  if (!run) throw new ServerError('Maintenance run not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ run });
}));

router.post('/schedule/maintenance-runs/:id/resume', asyncHandler(async (req, res) => {
  const resumed = await resumeMaintenanceRun(req.params.id);
  if (!resumed) throw new ServerError('Maintenance run not found', { status: 404, code: 'NOT_FOUND' });
  res.json(resumed);
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
  const { name, description, category, taskType, priority, metadata } = validateRequest(templateTaskSchema, req.body);

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
      'on-demand': 'Only runs when manually triggered',
      cron: 'Scheduled on a cron expression (minute hour dayOfMonth month dayOfWeek)'
    },
    // `perpetual` is an orthogonal flag, not a type — it applies to either.
    perpetual: 'Drains actionable work back-to-back until none remains. On-demand tasks with autoStart false wait for another explicit trigger; otherwise rechecks on a cadence (its own cron expression when scheduled, else recheckCron / recheckIntervalMs, default daily)'
  });
});

export default router;
