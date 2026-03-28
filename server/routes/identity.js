import { Router } from 'express';
import * as identityService from '../services/identity.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  chronotypeBehavioralInputSchema,
  birthDateInputSchema,
  createGoalInputSchema,
  updateGoalInputSchema,
  addMilestoneInputSchema,
  addProgressEntrySchema,
  linkActivityInputSchema,
  linkCalendarInputSchema,
  addTodoInputSchema,
  updateTodoInputSchema,
  updateProgressSchema,
  generatePhasesInputSchema,
  acceptPhasesInputSchema,
  organizeGoalsInputSchema,
  applyOrganizationInputSchema,
  checkInGoalInputSchema
} from '../lib/identityValidation.js';
import * as goalCalendarScheduler from '../services/goalCalendarScheduler.js';

const router = Router();

// =============================================================================
// IDENTITY STATUS
// =============================================================================

// GET /api/digital-twin/identity — Unified section status
router.get('/', asyncHandler(async (req, res) => {
  const status = await identityService.getIdentityStatus();
  res.json(status);
}));

// =============================================================================
// CHRONOTYPE
// =============================================================================

// GET /api/digital-twin/identity/chronotype — Full chronotype profile
router.get('/chronotype', asyncHandler(async (req, res) => {
  const chronotype = await identityService.getChronotype();
  res.json(chronotype);
}));

// POST /api/digital-twin/identity/chronotype/derive — Force re-derivation
router.post('/chronotype/derive', asyncHandler(async (req, res) => {
  const chronotype = await identityService.deriveChronotype();
  res.json(chronotype);
}));

// PUT /api/digital-twin/identity/chronotype — Behavioral overrides
router.put('/chronotype', asyncHandler(async (req, res) => {
  const data = validateRequest(chronotypeBehavioralInputSchema, req.body);
  const chronotype = await identityService.updateChronotypeBehavioral(data);
  res.json(chronotype);
}));

// GET /api/digital-twin/identity/chronotype/energy-schedule — Energy zones for day view
router.get('/chronotype/energy-schedule', asyncHandler(async (req, res) => {
  const schedule = await identityService.getEnergySchedule();
  res.json(schedule);
}));

// =============================================================================
// CROSS-INSIGHTS
// =============================================================================

// GET /api/digital-twin/identity/cross-insights — Rule-based cross-domain insights
router.get('/cross-insights', asyncHandler(async (req, res) => {
  const result = await identityService.getCrossInsights();
  res.json(result);
}));

// =============================================================================
// LONGEVITY
// =============================================================================

// GET /api/digital-twin/identity/longevity — Full longevity profile
router.get('/longevity', asyncHandler(async (req, res) => {
  const longevity = await identityService.getLongevity();
  res.json(longevity);
}));

// POST /api/digital-twin/identity/longevity/derive — Force re-derivation
router.post('/longevity/derive', asyncHandler(async (req, res) => {
  const longevity = await identityService.deriveLongevity();
  res.json(longevity);
}));

// =============================================================================
// GOALS
// =============================================================================

// GET /api/digital-twin/identity/goals — Get all goals with time horizons
router.get('/goals', asyncHandler(async (req, res) => {
  const goals = await identityService.getGoals();
  res.json(goals);
}));

// GET /api/digital-twin/identity/goals/tree — Hierarchical goals tree
router.get('/goals/tree', asyncHandler(async (req, res) => {
  const tree = await identityService.getGoalsTree();
  res.json(tree);
}));

// PUT /api/digital-twin/identity/goals/birth-date — Set birth date
router.put('/goals/birth-date', asyncHandler(async (req, res) => {
  const { birthDate } = validateRequest(birthDateInputSchema, req.body);
  const goals = await identityService.setBirthDate(birthDate);
  res.json(goals);
}));

// POST /api/digital-twin/identity/goals — Create a new goal
router.post('/goals', asyncHandler(async (req, res) => {
  const data = validateRequest(createGoalInputSchema, req.body);
  const goal = await identityService.createGoal(data);
  res.status(201).json(goal);
}));

// PUT /api/digital-twin/identity/goals/:id — Update a goal
router.put('/goals/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateGoalInputSchema, req.body);
  const goal = await identityService.updateGoal(req.params.id, data);
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// DELETE /api/digital-twin/identity/goals/:id — Delete a goal
router.delete('/goals/:id', asyncHandler(async (req, res) => {
  const deleted = await identityService.deleteGoal(req.params.id);
  if (!deleted) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// POST /api/digital-twin/identity/goals/:id/milestones — Add milestone
router.post('/goals/:id/milestones', asyncHandler(async (req, res) => {
  const data = validateRequest(addMilestoneInputSchema, req.body);
  const milestone = await identityService.addMilestone(req.params.id, data);
  if (!milestone) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(201).json(milestone);
}));

// PUT /api/digital-twin/identity/goals/:id/milestones/:milestoneId/complete — Complete milestone
router.put('/goals/:id/milestones/:milestoneId/complete', asyncHandler(async (req, res) => {
  const milestone = await identityService.completeMilestone(req.params.id, req.params.milestoneId);
  if (!milestone) {
    throw new ServerError('Goal or milestone not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(milestone);
}));

// POST /api/digital-twin/identity/goals/:id/progress — Log progress entry
router.post('/goals/:id/progress', asyncHandler(async (req, res) => {
  const data = validateRequest(addProgressEntrySchema, req.body);
  const entry = await identityService.addProgressEntry(req.params.id, data);
  if (!entry) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(201).json(entry);
}));

// DELETE /api/digital-twin/identity/goals/:id/progress/:entryId — Delete progress entry
router.delete('/goals/:id/progress/:entryId', asyncHandler(async (req, res) => {
  const result = await identityService.deleteProgressEntry(req.params.id, req.params.entryId);
  if (!result) {
    throw new ServerError('Goal or progress entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

// POST /api/digital-twin/identity/goals/:id/activities — Link activity to goal
router.post('/goals/:id/activities', asyncHandler(async (req, res) => {
  const data = validateRequest(linkActivityInputSchema, req.body);
  const goal = await identityService.linkActivity(req.params.id, data);
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// DELETE /api/digital-twin/identity/goals/:id/activities/:activityName — Unlink activity from goal
router.delete('/goals/:id/activities/:activityName', asyncHandler(async (req, res) => {
  const goal = await identityService.unlinkActivity(req.params.id, decodeURIComponent(req.params.activityName));
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// POST /api/digital-twin/identity/goals/:id/calendars — Link calendar to goal
router.post('/goals/:id/calendars', asyncHandler(async (req, res) => {
  const data = validateRequest(linkCalendarInputSchema, req.body);
  const goal = await identityService.linkCalendarToGoal(req.params.id, data);
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// DELETE /api/digital-twin/identity/goals/:id/calendars/:subcalendarId — Unlink calendar from goal
router.delete('/goals/:id/calendars/:subcalendarId', asyncHandler(async (req, res) => {
  const goal = await identityService.unlinkCalendarFromGoal(req.params.id, decodeURIComponent(req.params.subcalendarId));
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// GET /api/digital-twin/identity/goals/:id/calendar-events — Get matching events
router.get('/goals/:id/calendar-events', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const events = await identityService.getGoalCalendarEvents(req.params.id, startDate, endDate);
  res.json(events);
}));

// PUT /api/digital-twin/identity/goals/:id/progress — Update progress percentage
router.put('/goals/:id/progress', asyncHandler(async (req, res) => {
  const { value } = validateRequest(updateProgressSchema, req.body);
  const goal = await identityService.updateGoalProgress(req.params.id, value);
  if (!goal) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(goal);
}));

// POST /api/digital-twin/identity/goals/:id/todos — Add todo
router.post('/goals/:id/todos', asyncHandler(async (req, res) => {
  const data = validateRequest(addTodoInputSchema, req.body);
  const todo = await identityService.addTodo(req.params.id, data);
  if (!todo) {
    throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(201).json(todo);
}));

// PUT /api/digital-twin/identity/goals/:id/todos/:todoId — Update todo
router.put('/goals/:id/todos/:todoId', asyncHandler(async (req, res) => {
  const data = validateRequest(updateTodoInputSchema, req.body);
  const todo = await identityService.updateTodo(req.params.id, req.params.todoId, data);
  if (!todo) {
    throw new ServerError('Goal or todo not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(todo);
}));

// DELETE /api/digital-twin/identity/goals/:id/todos/:todoId — Delete todo
router.delete('/goals/:id/todos/:todoId', asyncHandler(async (req, res) => {
  const result = await identityService.deleteTodo(req.params.id, req.params.todoId);
  if (!result) {
    throw new ServerError('Goal or todo not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// POST /api/digital-twin/identity/goals/:id/generate-phases — AI-generate phases
router.post('/goals/:id/generate-phases', asyncHandler(async (req, res) => {
  const data = validateRequest(generatePhasesInputSchema, req.body);
  const phases = await identityService.generateGoalPhases(req.params.id, data);
  res.json(phases);
}));

// POST /api/digital-twin/identity/goals/:id/accept-phases — Persist phases as milestones
router.post('/goals/:id/accept-phases', asyncHandler(async (req, res) => {
  const data = validateRequest(acceptPhasesInputSchema, req.body);
  const goal = await identityService.acceptGoalPhases(req.params.id, data.phases);
  res.json(goal);
}));

// POST /api/digital-twin/identity/goals/organize — AI-organize goals into hierarchy
router.post('/goals/organize', asyncHandler(async (req, res) => {
  const data = validateRequest(organizeGoalsInputSchema, req.body);
  const result = await identityService.organizeGoals(data);
  res.json(result);
}));

// POST /api/digital-twin/identity/goals/organize/apply — Apply organization suggestions
router.post('/goals/organize/apply', asyncHandler(async (req, res) => {
  const { organization } = validateRequest(applyOrganizationInputSchema, req.body);
  const result = await identityService.applyGoalOrganization(organization);
  res.json(result);
}));

// POST /api/digital-twin/identity/goals/:id/check-in — AI-powered goal check-in
router.post('/goals/:id/check-in', asyncHandler(async (req, res) => {
  const data = validateRequest(checkInGoalInputSchema, req.body);
  const checkIn = await identityService.checkInGoal(req.params.id, data);
  res.status(201).json(checkIn);
}));

// POST /api/digital-twin/identity/goals/:id/schedule — Create time blocks
router.post('/goals/:id/schedule', asyncHandler(async (req, res) => {
  const result = await goalCalendarScheduler.scheduleTimeBlocks(req.params.id);
  res.json(result);
}));

// DELETE /api/digital-twin/identity/goals/:id/schedule — Remove scheduled events
router.delete('/goals/:id/schedule', asyncHandler(async (req, res) => {
  const result = await goalCalendarScheduler.removeScheduledEvents(req.params.id);
  res.json(result);
}));

// POST /api/digital-twin/identity/goals/:id/reschedule — Rebuild schedule
router.post('/goals/:id/reschedule', asyncHandler(async (req, res) => {
  const result = await goalCalendarScheduler.rescheduleTimeBlocks(req.params.id);
  res.json(result);
}));

export default router;
