import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  configUpdateSchema,
  lifestyleUpdateSchema,
  drinkLogSchema,
  drinkUpdateSchema,
  customDrinkSchema,
  customDrinkUpdateSchema,
  bloodTestSchema,
  bodyEntrySchema,
  epigeneticTestSchema,
  eyeExamSchema,
  eyeExamUpdateSchema,
  activitySchema,
  activityUpdateSchema,
} from '../lib/meatspaceValidation.js';
import {
  postSessionSubmitSchema,
  postConfigUpdateSchema,
  postDrillRequestSchema,
  postLlmScoreRequestSchema,
  LLM_DRILL_TYPES,
} from '../lib/postValidation.js';
import * as meatspaceService from '../services/meatspace.js';
import * as alcoholService from '../services/meatspaceAlcohol.js';
import * as healthService from '../services/meatspaceHealth.js';
import * as postService from '../services/meatspacePost.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspacePostLlm.js';
import * as calendarService from '../services/meatspaceCalendar.js';

const router = Router();

// =============================================================================
// OVERVIEW
// =============================================================================

/**
 * GET /api/meatspace
 * Overview: death clock, LEV, health summary
 */
router.get('/', asyncHandler(async (req, res) => {
  const overview = await meatspaceService.getOverview();
  res.json(overview);
}));

// =============================================================================
// CONFIG
// =============================================================================

/**
 * GET /api/meatspace/config
 * Profile + lifestyle config
 */
router.get('/config', asyncHandler(async (req, res) => {
  const config = await meatspaceService.getConfig();
  res.json(config);
}));

/**
 * PUT /api/meatspace/config
 * Update profile config
 */
router.put('/config', asyncHandler(async (req, res) => {
  const data = validateRequest(configUpdateSchema, req.body);
  const config = await meatspaceService.updateConfig(data);
  res.json(config);
}));

/**
 * PUT /api/meatspace/lifestyle
 * Update lifestyle questionnaire
 */
router.put('/lifestyle', asyncHandler(async (req, res) => {
  const data = validateRequest(lifestyleUpdateSchema, req.body);
  const config = await meatspaceService.updateLifestyle(data);
  res.json(config);
}));

// =============================================================================
// DEATH CLOCK & LEV
// =============================================================================

/**
 * GET /api/meatspace/death-clock
 * Full death clock computation
 */
router.get('/death-clock', asyncHandler(async (req, res) => {
  const deathClock = await meatspaceService.getDeathClock();
  res.json(deathClock);
}));

/**
 * GET /api/meatspace/lev
 * LEV 2045 tracker data
 */
router.get('/lev', asyncHandler(async (req, res) => {
  const lev = await meatspaceService.getLEV();
  res.json(lev);
}));

// =============================================================================
// ALCOHOL
// =============================================================================

/**
 * GET /api/meatspace/alcohol
 * Alcohol summary with rolling averages
 */
router.get('/alcohol', asyncHandler(async (req, res) => {
  const summary = await alcoholService.getAlcoholSummary();
  res.json(summary);
}));

/**
 * GET /api/meatspace/alcohol/daily
 * Daily alcohol entries with optional date range
 */
router.get('/alcohol/daily', asyncHandler(async (req, res) => {
  const entries = await alcoholService.getDailyAlcohol(req.query.from, req.query.to);
  res.json(entries);
}));

/**
 * POST /api/meatspace/alcohol/log
 * Log a drink
 */
router.post('/alcohol/log', asyncHandler(async (req, res) => {
  const data = validateRequest(drinkLogSchema, req.body);
  const result = await alcoholService.logDrink(data);
  res.status(201).json(result);
}));

/**
 * PUT /api/meatspace/alcohol/log/:date/:index
 * Update a specific drink entry
 */
router.put('/alcohol/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const data = validateRequest(drinkUpdateSchema, req.body);
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const result = await alcoholService.updateDrink(date, parsedIndex, data);
  if (!result) {
    throw new ServerError('Drink entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/meatspace/alcohol/log/:date/:index
 * Remove a specific drink entry
 */
router.delete('/alcohol/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await alcoholService.removeDrink(date, parsedIndex);
  if (!removed) {
    throw new ServerError('Drink entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

// =============================================================================
// CUSTOM DRINK BUTTONS
// =============================================================================

/**
 * GET /api/meatspace/alcohol/custom-drinks
 * List custom drink quick-add buttons
 */
router.get('/alcohol/custom-drinks', asyncHandler(async (req, res) => {
  const drinks = await alcoholService.getCustomDrinks();
  res.json(drinks);
}));

/**
 * POST /api/meatspace/alcohol/custom-drinks
 * Add a custom drink button
 */
router.post('/alcohol/custom-drinks', asyncHandler(async (req, res) => {
  const data = validateRequest(customDrinkSchema, req.body);
  const drink = await alcoholService.addCustomDrink(data);
  res.status(201).json(drink);
}));

/**
 * PUT /api/meatspace/alcohol/custom-drinks/:index
 * Update a custom drink button
 */
router.put('/alcohol/custom-drinks/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(customDrinkUpdateSchema, req.body);
  const drink = await alcoholService.updateCustomDrink(index, data);
  if (!drink) {
    throw new ServerError('Custom drink not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(drink);
}));

/**
 * DELETE /api/meatspace/alcohol/custom-drinks/:index
 * Remove a custom drink button
 */
router.delete('/alcohol/custom-drinks/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await alcoholService.removeCustomDrink(index);
  if (!removed) {
    throw new ServerError('Custom drink not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

// =============================================================================
// BLOOD & BODY
// =============================================================================

/**
 * GET /api/meatspace/blood
 * Blood test history + reference ranges
 */
router.get('/blood', asyncHandler(async (req, res) => {
  const data = await healthService.getBloodTests();
  res.json(data);
}));

/**
 * POST /api/meatspace/blood
 * Add a blood test
 */
router.post('/blood', asyncHandler(async (req, res) => {
  const data = validateRequest(bloodTestSchema, req.body);
  const test = await healthService.addBloodTest(data);
  res.status(201).json(test);
}));

/**
 * GET /api/meatspace/body
 * Body composition history
 */
router.get('/body', asyncHandler(async (req, res) => {
  const history = await healthService.getBodyHistory();
  res.json(history);
}));

/**
 * POST /api/meatspace/body
 * Log a body entry
 */
router.post('/body', asyncHandler(async (req, res) => {
  const data = validateRequest(bodyEntrySchema, req.body);
  const entry = await healthService.addBodyEntry(data);
  res.status(201).json(entry);
}));

/**
 * GET /api/meatspace/epigenetic
 * Elysium results
 */
router.get('/epigenetic', asyncHandler(async (req, res) => {
  const data = await healthService.getEpigeneticTests();
  res.json(data);
}));

/**
 * POST /api/meatspace/epigenetic
 * Add epigenetic test result
 */
router.post('/epigenetic', asyncHandler(async (req, res) => {
  const data = validateRequest(epigeneticTestSchema, req.body);
  const test = await healthService.addEpigeneticTest(data);
  res.status(201).json(test);
}));

/**
 * GET /api/meatspace/eyes
 * Eye Rx history
 */
router.get('/eyes', asyncHandler(async (req, res) => {
  const data = await healthService.getEyeExams();
  res.json(data);
}));

/**
 * POST /api/meatspace/eyes
 * Add eye exam
 */
router.post('/eyes', asyncHandler(async (req, res) => {
  const data = validateRequest(eyeExamSchema, req.body);
  const exam = await healthService.addEyeExam(data);
  res.status(201).json(exam);
}));

/**
 * PUT /api/meatspace/eyes/:index
 * Update an eye exam
 */
router.put('/eyes/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(eyeExamUpdateSchema, req.body);
  const exam = await healthService.updateEyeExam(index, data);
  if (!exam) {
    throw new ServerError('Eye exam not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(exam);
}));

/**
 * DELETE /api/meatspace/eyes/:index
 * Remove an eye exam
 */
router.delete('/eyes/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await healthService.removeEyeExam(index);
  if (!removed) {
    throw new ServerError('Eye exam not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));


// =============================================================================
// POST (Power On Self Test)
// =============================================================================

/**
 * GET /api/meatspace/post/config
 * Drill configuration and weights
 */
router.get('/post/config', asyncHandler(async (req, res) => {
  const config = await postService.getPostConfig();
  res.json(config);
}));

/**
 * PUT /api/meatspace/post/config
 * Update drill configuration
 */
router.put('/post/config', asyncHandler(async (req, res) => {
  const data = validateRequest(postConfigUpdateSchema, req.body);
  const config = await postService.updatePostConfig(data);
  res.json(config);
}));

/**
 * GET /api/meatspace/post/sessions
 * Session history with optional date range
 */
router.get('/post/sessions', asyncHandler(async (req, res) => {
  const sessions = await postService.getPostSessions(req.query.from, req.query.to);
  res.json(sessions);
}));

/**
 * GET /api/meatspace/post/sessions/:id
 * Single session by ID
 */
router.get('/post/sessions/:id', asyncHandler(async (req, res) => {
  const session = await postService.getPostSession(req.params.id);
  if (!session) {
    throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(session);
}));

/**
 * POST /api/meatspace/post/sessions
 * Submit a completed session
 */
router.post('/post/sessions', asyncHandler(async (req, res) => {
  const data = validateRequest(postSessionSubmitSchema, req.body);
  const session = await postService.submitPostSession(data);
  res.status(201).json(session);
}));

/**
 * GET /api/meatspace/post/stats
 * Rolling averages and trends
 */
router.get('/post/stats', asyncHandler(async (req, res) => {
  const rawDays = req.query.days != null ? parseInt(req.query.days, 10) : 30;
  const days = Number.isNaN(rawDays) ? 30 : rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const stats = await postService.getPostStats(days);
  res.json(stats);
}));

/**
 * POST /api/meatspace/post/drill
 * Generate a drill with questions and expected answers.
 * Supports both math drills (sync) and LLM drills (async, requires AI provider).
 */
router.post('/post/drill', asyncHandler(async (req, res) => {
  const data = validateRequest(postDrillRequestSchema, req.body);

  if (LLM_DRILL_TYPES.includes(data.type)) {
    const drill = await generateLlmDrill(data.type, data.config, data.providerId, data.model);
    if (!drill) {
      throw new ServerError('Failed to generate LLM drill', { status: 500, code: 'LLM_DRILL_FAILED' });
    }
    return res.json(drill);
  }

  const drill = postService.generateDrill(data.type, data.config);
  if (!drill) {
    throw new ServerError('Unknown drill type', { status: 400, code: 'INVALID_DRILL_TYPE' });
  }
  res.json(drill);
}));

/**
 * POST /api/meatspace/post/score-llm
 * Score an LLM drill's responses using AI evaluation.
 */
router.post('/post/score-llm', asyncHandler(async (req, res) => {
  const data = validateRequest(postLlmScoreRequestSchema, req.body);
  const result = await scoreLlmDrill(
    data.type, data.drillData, data.responses,
    data.timeLimitMs, data.providerId, data.model
  );
  res.json(result);
}));

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

export default router;
