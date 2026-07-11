/**
 * Per-app task-type overrides + read-only work-tracker / layered-intelligence
 * config resolution.
 *
 *   PUT  /bulk-task-type/:taskType   → { success, appsUpdated }  (all active apps)
 *   GET  /:id/task-types             → { taskTypeOverrides }
 *   GET  /:id/work-tracker           → { tracker info }
 *   GET  /:id/layered-intelligence   → { config, isPortos }
 *   PUT  /:id/task-types/all         → { success, taskTypeOverrides }
 *   PUT  /:id/task-types/:taskType   → { success, taskTypeOverrides }
 *
 * ORDER-SENSITIVE: `/:id/task-types/all` MUST be registered before
 * `/:id/task-types/:taskType`, otherwise `all` is captured as a taskType param.
 */

import { Router } from 'express';
import * as appsService from '../../services/apps.js';
import { PORTOS_APP_ID } from '../../services/apps.js';
import { sanitizeTaskMetadata } from '../../lib/validation.js';
import { parseCronToNextRun } from '../../services/eventScheduler.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from '../../services/taskSchedule.js';
import { loadApp } from './shared.js';

const router = Router();

// PUT /api/apps/bulk-task-type/:taskType - Enable/disable a task type for all active apps
router.put('/bulk-task-type/:taskType', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled (boolean) is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!SELF_IMPROVEMENT_TASK_TYPES.includes(req.params.taskType)) {
    throw new ServerError(`Unknown task type '${req.params.taskType}'`, { status: 400, code: 'INVALID_TASK_TYPE' });
  }

  const result = await appsService.bulkUpdateAppTaskTypeOverride(req.params.taskType, { enabled });
  console.log(`📋 Bulk ${enabled ? 'enabled' : 'disabled'} task type ${req.params.taskType} for ${result.count} apps`);
  res.json({ success: true, taskType: req.params.taskType, enabled, appsUpdated: result.count });
}));

// GET /api/apps/:id/task-types - Get per-app task type overrides
router.get('/:id/task-types', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const overrides = await appsService.getAppTaskTypeOverrides(app.id);
  res.json({ appId: app.id, appName: app.name, taskTypeOverrides: overrides });
}));

// GET /api/apps/:id/work-tracker - Resolve where this app's autonomous work
// items live (PLAN.md / GitHub / GitLab / JIRA). 'auto' resolves from the git
// origin host; see server/lib/workTracker.js. Read-only — the value itself is
// saved through the generic PUT /api/apps/:id (appUpdateSchema.workTracker).
router.get('/:id/work-tracker', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const info = await appsService.getAppWorkTracker(app.id);
  res.json({ appId: app.id, appName: app.name, ...info });
}));

// GET /api/apps/:id/layered-intelligence - Effective Layered Intelligence config
// for this app (the self-improvement loop). Merges the app's stored partial
// config over the shipped defaults so the UI always renders a complete, safe
// config — including the isPortos-derived scope set. Read-only; the value is
// saved through PUT /api/apps/:id (layeredIntelligence goes via the dedicated
// merge helper there). See server/services/layeredIntelligence.js.
router.get('/:id/layered-intelligence', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const config = await appsService.getAppLayeredIntelligenceConfig(app.id);
  res.json({ appId: app.id, appName: app.name, isPortos: app.id === PORTOS_APP_ID, config });
}));

// PUT /api/apps/:id/task-types/all - Toggle all task types for an app
router.put('/:id/task-types/all', loadApp, asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await appsService.toggleAllAppTaskTypes(req.params.id, enabled);
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }
  console.log(`📋 ${enabled ? 'Enabled' : 'Disabled'} all task types for ${result.name}`);
  res.json({ success: true, appId: result.id, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

// PUT /api/apps/:id/task-types/:taskType - Update a task type override for an app
router.put('/:id/task-types/:taskType', asyncHandler(async (req, res) => {
  const { enabled, interval, intervalMs, providerId, model, taskMetadata } = req.body;
  if (!SELF_IMPROVEMENT_TASK_TYPES.includes(req.params.taskType)) {
    throw new ServerError(`Unknown task type '${req.params.taskType}'`, { status: 400, code: 'INVALID_TASK_TYPE' });
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ServerError('enabled must be a boolean', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (typeof enabled !== 'boolean' && interval === undefined && intervalMs === undefined &&
      providerId === undefined && model === undefined && taskMetadata === undefined) {
    throw new ServerError('enabled (boolean), interval (string|null), intervalMs (number|null), providerId (string|null), model (string|null), or taskMetadata (object|null) required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Per-app scheduling fields for handler-backed tasks (layered-intelligence).
  // `null`/'' clears back to inherit; a numeric intervalMs must be a positive
  // finite number (a sub-daily cadence the string interval enum can't express).
  if (intervalMs !== undefined && intervalMs !== null) {
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new ServerError('intervalMs must be a positive number or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  if (providerId !== undefined && providerId !== null && typeof providerId !== 'string') {
    throw new ServerError('providerId must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new ServerError('model must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate and sanitize taskMetadata to allowed agent-option keys only
  let sanitizedTaskMetadata;
  if (taskMetadata === undefined) {
    sanitizedTaskMetadata = undefined;
  } else if (taskMetadata === null) {
    sanitizedTaskMetadata = null;
  } else {
    if (typeof taskMetadata !== 'object' || Array.isArray(taskMetadata)) {
      throw new ServerError('taskMetadata must be an object or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
    sanitizedTaskMetadata = sanitizeTaskMetadata(taskMetadata);
    if (sanitizedTaskMetadata === null) {
      throw new ServerError('Invalid taskMetadata: unrecognized keys or values', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  // Validate interval against allowed values (also accepts 5-field cron expressions)
  if (interval !== undefined) {
    // 'custom' pairs with a numeric intervalMs (handler-backed tasks with a
    // sub-daily per-app cadence); the scheduler's CUSTOM branch reads intervalMs.
    const allowedIntervals = ['rotation', 'daily', 'weekly', 'once', 'on-demand', 'custom'];
    if (interval !== null && typeof interval === 'string') {
      const isCron = interval.trim().split(/\s+/).length === 5;
      if (!isCron && !allowedIntervals.includes(interval)) {
        throw new ServerError('interval must be one of rotation|daily|weekly|once|on-demand|custom, a cron expression, or null', { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (isCron) {
        // Validate syntax and field ranges (parseCronToNextRun throws on invalid expressions)
        // Note: null return means no match within search window (e.g. leap day) -- not invalid
        parseCronToNextRun(interval, new Date(), 'UTC');
      }
    } else if (interval !== null) {
      throw new ServerError('interval must be a string or null', { status: 400, code: 'VALIDATION_ERROR' });
    }
  }

  const result = await appsService.updateAppTaskTypeOverride(req.params.id, req.params.taskType, { enabled, interval, intervalMs, providerId, model, taskMetadata: sanitizedTaskMetadata });
  if (!result) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const action = typeof enabled === 'boolean' ? (enabled ? 'Enabled' : 'Disabled') : 'Updated interval for';
  console.log(`📋 ${action} task type ${req.params.taskType} for ${result.name}`);
  res.json({ success: true, appId: result.id, taskType: req.params.taskType, enabled, interval, taskTypeOverrides: result.taskTypeOverrides || {} });
}));

export default router;
