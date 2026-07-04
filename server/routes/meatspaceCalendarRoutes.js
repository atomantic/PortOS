/**
 * Meatspace Life Calendar Routes
 *
 * Life calendar grid + stats, custom activities, and life events.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  activitySchema,
  activityUpdateSchema,
  lifeEventSchema,
  lifeEventUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as calendarService from '../services/meatspaceCalendar.js';

const router = Router();

// ============================================================
// Life Calendar
// ============================================================

/**
 * GET /api/meatspace/calendar
 * Full life calendar data: grid, stats, activity budgets.
 */
router.get('/calendar', asyncHandler(async (_req, res) => {
  const data = await calendarService.getCalendarData();
  res.json(data);
}));

/**
 * GET /api/meatspace/activities
 * List all custom activities (or defaults if none configured).
 */
router.get('/activities', asyncHandler(async (_req, res) => {
  const activities = await calendarService.getActivities();
  res.json(activities);
}));

/**
 * POST /api/meatspace/activities
 * Add a new activity.
 */
router.post('/activities', asyncHandler(async (req, res) => {
  const data = validateRequest(activitySchema, req.body);
  const activities = await calendarService.addActivity(data);
  res.json(activities);
}));

/**
 * PUT /api/meatspace/activities/:index
 * Update an activity by index.
 */
router.put('/activities/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  const data = validateRequest(activityUpdateSchema, req.body);
  const activities = await calendarService.updateActivity(index, data);
  if (!activities) {
    throw new ServerError('Activity not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(activities);
}));

/**
 * DELETE /api/meatspace/activities/:index
 * Remove an activity by index.
 */
router.delete('/activities/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  const activities = await calendarService.removeActivity(index);
  if (!activities) {
    throw new ServerError('Activity not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(activities);
}));

// ============================================================
// Life Events
// ============================================================

/**
 * GET /api/meatspace/life-events
 * List all life events (or defaults if none configured).
 */
router.get('/life-events', asyncHandler(async (_req, res) => {
  const events = await calendarService.getLifeEvents();
  res.json(events);
}));

/**
 * POST /api/meatspace/life-events
 * Add a new life event.
 */
router.post('/life-events', asyncHandler(async (req, res) => {
  const data = validateRequest(lifeEventSchema, req.body);
  const events = await calendarService.addLifeEvent(data);
  res.json(events);
}));

/**
 * PUT /api/meatspace/life-events/:id
 * Update a life event by ID.
 */
router.put('/life-events/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(lifeEventUpdateSchema, req.body);
  const events = await calendarService.updateLifeEvent(req.params.id, data);
  if (!events) throw new ServerError('Life event not found', { status: 404, code: 'NOT_FOUND' });
  res.json(events);
}));

/**
 * DELETE /api/meatspace/life-events/:id
 * Remove a life event by ID.
 */
router.delete('/life-events/:id', asyncHandler(async (req, res) => {
  const events = await calendarService.removeLifeEvent(req.params.id);
  if (!events) throw new ServerError('Life event not found', { status: 404, code: 'NOT_FOUND' });
  res.json(events);
}));

export default router;
