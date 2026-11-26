/**
 * Automation Schedules Routes
 *
 * Manage scheduled automation tasks for agent platform accounts.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { automationSchedulesListQuerySchema, automationScheduleSchema, automationScheduleUpdateSchema } from '../lib/agent/agentValidation.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as automationScheduler from '../services/automationScheduler.js';
import { validateScheduleOwner } from '../services/agent/automationScheduleOwner.js';
import { logAction } from '../services/history.js';

const toggleScheduleSchema = z.object({
  enabled: z.boolean(),
});

const router = Router();

// GET / - Get all schedules
router.get('/', asyncHandler(async (req, res) => {
  console.log('📅 GET /api/agents/schedules');
  const { agentId, accountId } = validateRequest(automationSchedulesListQuerySchema, req.query);

  let schedules;
  if (agentId) {
    schedules = await automationScheduler.getSchedulesByAgent(agentId);
  } else if (accountId) {
    schedules = await automationScheduler.getSchedulesByAccount(accountId);
  } else {
    schedules = await automationScheduler.getAllSchedules();
  }

  res.json(schedules);
}));

// GET /stats - Get schedule statistics
router.get('/stats', asyncHandler(async (req, res) => {
  console.log('📅 GET /api/agents/schedules/stats');
  const stats = await automationScheduler.getStats();
  res.json(stats);
}));

// GET /:id - Get schedule by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`📅 GET /api/agents/schedules/${id}`);

  const schedule = await automationScheduler.getScheduleById(id);
  if (!schedule) {
    throw new ServerError('Schedule not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(schedule);
}));

// POST / - Create new schedule
router.post('/', asyncHandler(async (req, res) => {
  console.log('📅 POST /api/agents/schedules');

  const data = validateRequest(automationScheduleSchema, req.body);
  await validateScheduleOwner(data);

  const schedule = await automationScheduler.createSchedule(data);
  await logAction('create', 'automation-schedule', schedule.id, {
    agentId: schedule.agentId,
    action: schedule.action.type
  });

  res.status(201).json(schedule);
}));

// PUT /:id - Update schedule
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`📅 PUT /api/agents/schedules/${id}`);

  const data = validateRequest(automationScheduleUpdateSchema, req.body);
  const schedule = await automationScheduler.updateSchedule(id, data);
  if (!schedule) {
    throw new ServerError('Schedule not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('update', 'automation-schedule', id, {
    agentId: schedule.agentId,
    action: schedule.action.type
  });

  res.json(schedule);
}));

// DELETE /:id - Delete schedule
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`📅 DELETE /api/agents/schedules/${id}`);

  const deleted = await automationScheduler.deleteSchedule(id);
  if (!deleted) {
    throw new ServerError('Schedule not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('delete', 'automation-schedule', id, {});
  res.json({ success: true });
}));

// POST /:id/toggle - Toggle schedule enabled status
router.post('/:id/toggle', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled } = validateRequest(toggleScheduleSchema, req.body);
  console.log(`📅 POST /api/agents/schedules/${id}/toggle enabled=${enabled}`);

  const schedule = await automationScheduler.toggleSchedule(id, enabled);
  if (!schedule) {
    throw new ServerError('Schedule not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('toggle', 'automation-schedule', id, { enabled });
  res.json(schedule);
}));

// POST /:id/run - Trigger immediate run
router.post('/:id/run', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`📅 POST /api/agents/schedules/${id}/run`);

  const schedule = await automationScheduler.runNow(id);
  if (!schedule) {
    throw new ServerError('Schedule not found', { status: 404, code: 'NOT_FOUND' });
  }

  await logAction('run', 'automation-schedule', id, {
    agentId: schedule.agentId,
    action: schedule.action.type
  });

  res.json(schedule);
}));

export default router;
