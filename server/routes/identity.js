import { Router } from 'express';
import * as identityService from '../services/identity.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  chronotypeBehavioralInputSchema,
  birthDateInputSchema,
  createGoalInputSchema,
  updateGoalInputSchema,
  addMilestoneInputSchema
} from '../lib/identityValidation.js';

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

export default router;
