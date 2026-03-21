import { Router } from 'express';
import { join } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import {
  configUpdateSchema,
  lifestyleUpdateSchema,
  drinkLogSchema,
  drinkUpdateSchema,
  customDrinkSchema,
  customDrinkUpdateSchema,
  nicotineLogSchema,
  nicotineUpdateSchema,
  customNicotineProductSchema,
  customNicotineProductUpdateSchema,
  bloodTestSchema,
  bodyEntrySchema,
  epigeneticTestSchema,
  eyeExamSchema,
  eyeExamUpdateSchema,
  activitySchema,
  activityUpdateSchema,
  lifeEventSchema,
  lifeEventUpdateSchema,
} from '../lib/meatspaceValidation.js';
import { birthDateInputSchema } from '../lib/identityValidation.js';
import {
  postSessionSubmitSchema,
  postConfigUpdateSchema,
  postDrillRequestSchema,
  postLlmScoreRequestSchema,
  memoryItemCreateSchema,
  memoryItemUpdateSchema,
  memoryPracticeSchema,
  memoryDrillRequestSchema,
  LLM_DRILL_TYPES,
  MEMORY_DRILL_TYPES,
  trainingEntrySchema,
} from '../lib/postValidation.js';
import * as meatspaceService from '../services/meatspace.js';
import * as alcoholService from '../services/meatspaceAlcohol.js';
import * as nicotineService from '../services/meatspaceNicotine.js';
import * as healthService from '../services/meatspaceHealth.js';
import * as postService from '../services/meatspacePost.js';
import * as memoryService from '../services/meatspacePostMemory.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspacePostLlm.js';
import * as trainingService from '../services/meatspacePostTraining.js';
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
// BIRTH DATE
// =============================================================================

/**
 * GET /api/meatspace/birth-date
 * Get birth date (migrates from goals.json on first read)
 */
router.get('/birth-date', asyncHandler(async (req, res) => {
  const result = await meatspaceService.getBirthDate();
  res.json(result);
}));

/**
 * PUT /api/meatspace/birth-date
 * Set or update birth date
 */
router.put('/birth-date', asyncHandler(async (req, res) => {
  const { birthDate } = validateRequest(birthDateInputSchema, req.body);
  const result = await meatspaceService.updateBirthDate(birthDate);
  res.json(result);
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
// NICOTINE
// =============================================================================

/**
 * GET /api/meatspace/nicotine
 * Nicotine summary with rolling averages
 */
router.get('/nicotine', asyncHandler(async (req, res) => {
  const summary = await nicotineService.getNicotineSummary();
  res.json(summary);
}));

/**
 * GET /api/meatspace/nicotine/daily
 * Daily nicotine entries with optional date range
 */
router.get('/nicotine/daily', asyncHandler(async (req, res) => {
  const entries = await nicotineService.getDailyNicotine(req.query.from, req.query.to);
  res.json(entries);
}));

/**
 * POST /api/meatspace/nicotine/log
 * Log nicotine consumption
 */
router.post('/nicotine/log', asyncHandler(async (req, res) => {
  const data = validateRequest(nicotineLogSchema, req.body);
  const result = await nicotineService.logNicotine(data);
  res.status(201).json(result);
}));

/**
 * PUT /api/meatspace/nicotine/log/:date/:index
 * Update a specific nicotine entry
 */
router.put('/nicotine/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const data = validateRequest(nicotineUpdateSchema, req.body);
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const result = await nicotineService.updateNicotine(date, parsedIndex, data);
  if (!result) {
    throw new ServerError('Nicotine entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/meatspace/nicotine/log/:date/:index
 * Remove a specific nicotine entry
 */
router.delete('/nicotine/log/:date/:index', asyncHandler(async (req, res) => {
  const { date, index } = req.params;
  const parsedIndex = parseInt(index, 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await nicotineService.removeNicotine(date, parsedIndex);
  if (!removed) {
    throw new ServerError('Nicotine entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

// =============================================================================
// CUSTOM NICOTINE PRODUCTS
// =============================================================================

/**
 * GET /api/meatspace/nicotine/custom-products
 * List custom nicotine product quick-add buttons
 */
router.get('/nicotine/custom-products', asyncHandler(async (req, res) => {
  const products = await nicotineService.getCustomProducts();
  res.json(products);
}));

/**
 * POST /api/meatspace/nicotine/custom-products
 * Add a custom nicotine product button
 */
router.post('/nicotine/custom-products', asyncHandler(async (req, res) => {
  const data = validateRequest(customNicotineProductSchema, req.body);
  const product = await nicotineService.addCustomProduct(data);
  res.status(201).json(product);
}));

/**
 * PUT /api/meatspace/nicotine/custom-products/:index
 * Update a custom nicotine product button
 */
router.put('/nicotine/custom-products/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(customNicotineProductUpdateSchema, req.body);
  const product = await nicotineService.updateCustomProduct(index, data);
  if (!product) {
    throw new ServerError('Custom product not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(product);
}));

/**
 * DELETE /api/meatspace/nicotine/custom-products/:index
 * Remove a custom nicotine product button
 */
router.delete('/nicotine/custom-products/:index', asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await nicotineService.removeCustomProduct(index);
  if (!removed) {
    throw new ServerError('Custom product not found', { status: 404, code: 'NOT_FOUND' });
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

  if (MEMORY_DRILL_TYPES.includes(data.type)) {
    const mode = data.type.replace('memory-', '');
    const drill = await memoryService.generateMemoryDrill({ mode, count: data.config?.count, memoryItemId: data.config?.memoryItemId });
    if (!drill) {
      throw new ServerError('Failed to generate memory drill', { status: 500, code: 'MEMORY_DRILL_FAILED' });
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

// =============================================================================
// POST - Training Log
// =============================================================================

/**
 * POST /api/meatspace/post/training
 * Submit a training practice entry (separate from scored sessions)
 */
router.post('/post/training', asyncHandler(async (req, res) => {
  const data = validateRequest(trainingEntrySchema, req.body);
  const entry = await trainingService.submitTrainingEntry(data);
  res.status(201).json(entry);
}));

/**
 * GET /api/meatspace/post/training/stats
 * Training stats: practice counts, streaks, accuracy by drill type
 */
router.get('/post/training/stats', asyncHandler(async (req, res) => {
  const rawDays = req.query.days != null ? parseInt(req.query.days, 10) : 30;
  const days = Number.isNaN(rawDays) ? 30 : rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const stats = await trainingService.getTrainingStats(days);
  res.json(stats);
}));

/**
 * GET /api/meatspace/post/training/entries
 * Recent training entries
 */
router.get('/post/training/entries', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const entries = await trainingService.getTrainingEntries(limit);
  res.json(entries);
}));

// =============================================================================
// POST - Memory Builder
// =============================================================================

/**
 * GET /api/meatspace/post/memory-items
 * List all memory items (includes built-in Elements Song)
 */
router.get('/post/memory-items', asyncHandler(async (req, res) => {
  const items = await memoryService.getMemoryItems();
  res.json(items);
}));

/**
 * GET /api/meatspace/post/memory-items/:id
 * Get a single memory item
 */
router.get('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const item = await memoryService.getMemoryItem(req.params.id);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(item);
}));

/**
 * POST /api/meatspace/post/memory-items
 * Create a custom memory item
 */
router.post('/post/memory-items', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryItemCreateSchema, req.body);
  const item = await memoryService.createMemoryItem(data);
  res.status(201).json(item);
}));

/**
 * PUT /api/meatspace/post/memory-items/:id
 * Update a memory item (built-in items: mastery only)
 */
router.put('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryItemUpdateSchema, req.body);
  const item = await memoryService.updateMemoryItem(req.params.id, data);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(item);
}));

/**
 * DELETE /api/meatspace/post/memory-items/:id
 * Delete a custom memory item (built-in items cannot be deleted)
 */
router.delete('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const removed = await memoryService.deleteMemoryItem(req.params.id);
  if (!removed) throw new ServerError('Cannot delete item (not found or built-in)', { status: 400, code: 'DELETE_FAILED' });
  res.json(removed);
}));

/**
 * POST /api/meatspace/post/memory-items/:id/practice
 * Submit practice results and update mastery
 */
router.post('/post/memory-items/:id/practice', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryPracticeSchema, req.body);
  const result = await memoryService.submitPractice(req.params.id, data);
  if (!result) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(result);
}));

/**
 * GET /api/meatspace/post/memory-items/:id/mastery
 * Get mastery breakdown for a memory item
 */
router.get('/post/memory-items/:id/mastery', asyncHandler(async (req, res) => {
  const mastery = await memoryService.getMastery(req.params.id);
  if (!mastery) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(mastery);
}));

/**
 * GET /api/meatspace/post/memory-items/:id/chunk-mastery
 * Get chunk mastery order for spaced repetition practice
 */
router.get('/post/memory-items/:id/chunk-mastery', asyncHandler(async (req, res) => {
  const item = await memoryService.getMemoryItem(req.params.id);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(memoryService.getChunkMasteryOrder(item));
}));

/**
 * POST /api/meatspace/post/memory-drill
 * Generate a memory drill for a POST session
 */
router.post('/post/memory-drill', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryDrillRequestSchema, req.body);
  const drill = await memoryService.generateMemoryDrill(data);
  if (!drill) throw new ServerError('No memory items available', { status: 400, code: 'NO_MEMORY_ITEMS' });
  res.json(drill);
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

/**
 * GET /api/meatspace/export/mortalloom
 * Export all health data in MortalLoom-compatible JSON format.
 * Transforms PortOS daily-log + files into MortalLoom AppData schema.
 */
router.get('/export/mortalloom', asyncHandler(async (req, res) => {
  const config = await meatspaceService.getConfig();
  const bloodData = await healthService.getBloodTests();
  const epiData = await healthService.getEpigeneticTests();
  const eyeData = await healthService.getEyeExams();
  const bodyHistory = await healthService.getBodyHistory();
  const dailyLog = await readJSONFile(join(PATHS.meatspace, 'daily-log.json'), { entries: [] });

  // Profile
  const profile = {
    birthDate: config.birthDate || null,
    biologicalSex: config.sex || null,
    lifestyle: {
      smokingStatus: config.lifestyle?.smokingStatus ?? 'never',
      exerciseMinutesPerWeek: config.lifestyle?.exerciseMinutesPerWeek ?? 150,
      sleepHoursPerNight: config.lifestyle?.sleepHoursPerNight ?? 7.5,
      dietQuality: config.lifestyle?.dietQuality ?? 'good',
      stressLevel: config.lifestyle?.stressLevel ?? 'moderate',
      bmi: config.lifestyle?.bmi ?? null,
    },
  };

  // Alcohol drinks - flatten daily log entries into individual drinks
  const alcoholDrinks = [];
  for (const entry of (dailyLog?.entries || [])) {
    if (!entry.alcohol?.drinks) continue;
    for (const drink of entry.alcohol.drinks) {
      alcoholDrinks.push({
        id: crypto.randomUUID(),
        name: drink.name,
        oz: drink.oz,
        abv: drink.abv,
        count: drink.count || 1,
        date: entry.date,
      });
    }
  }

  // Nicotine entries - flatten daily log
  const nicotineEntries = [];
  for (const entry of (dailyLog?.entries || [])) {
    if (!entry.nicotine?.items) continue;
    for (const item of entry.nicotine.items) {
      nicotineEntries.push({
        id: crypto.randomUUID(),
        product: item.product,
        mgPerUnit: item.mgPerUnit,
        count: item.count || 1,
        date: entry.date,
      });
    }
  }

  // Blood tests - PortOS stores markers flat on test object, MortalLoom nests under `markers`
  const bloodTests = (bloodData?.tests || []).map(test => {
    const { date, ...markers } = test;
    return {
      id: crypto.randomUUID(),
      date,
      markers,
    };
  });

  // Body entries from daily log
  const bodyEntries = bodyHistory.map(entry => ({
    id: crypto.randomUUID(),
    date: entry.date,
    weightLbs: entry.weightLbs ?? null,
    bodyFatPct: entry.fatPct ?? null,
  }));

  // Epigenetic tests
  const epigeneticTests = (epiData?.tests || []).map(test => ({
    id: crypto.randomUUID(),
    date: test.date,
    chronologicalAge: test.chronologicalAge,
    biologicalAge: test.biologicalAge,
    paceOfAging: test.paceOfAging ?? null,
    organScores: test.organScores ?? null,
  }));

  // Eye exams
  const eyeExams = (eyeData?.exams || []).map(exam => ({
    id: crypto.randomUUID(),
    date: exam.date,
    leftSphere: exam.leftSphere ?? null,
    leftCylinder: exam.leftCylinder ?? null,
    leftAxis: exam.leftAxis ?? null,
    rightSphere: exam.rightSphere ?? null,
    rightCylinder: exam.rightCylinder ?? null,
    rightAxis: exam.rightAxis ?? null,
  }));

  // Default alcohol presets (match MortalLoom defaults)
  const alcoholPresets = [
    { id: crypto.randomUUID(), name: 'Modelo Especial (12oz)', oz: 12, abv: 4.4 },
    { id: crypto.randomUUID(), name: 'Nitro Guinness (14.9oz)', oz: 14.9, abv: 4.2 },
    { id: crypto.randomUUID(), name: 'Old Fashioned (2oz)', oz: 2, abv: 40 },
    { id: crypto.randomUUID(), name: 'Guinness 0 (14.9oz)', oz: 14.9, abv: 0.4 },
    { id: crypto.randomUUID(), name: 'N/A Beer (12oz)', oz: 12, abv: 0.4 },
  ];

  // Nicotine presets
  const nicotinePresets = [
    { id: crypto.randomUUID(), name: 'Stokes Pick (5mg)', mgPerUnit: 5 },
  ];

  const exportData = {
    profile,
    alcoholDrinks,
    alcoholPresets,
    nicotineEntries,
    nicotinePresets,
    bloodTests,
    eyeExams,
    epigeneticTests,
    bodyEntries,
  };

  res.setHeader('Content-Disposition', 'attachment; filename="MortalLoom-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(exportData);
}));

export default router;
