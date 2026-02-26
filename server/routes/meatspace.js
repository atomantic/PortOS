import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  configUpdateSchema,
  lifestyleUpdateSchema,
  drinkLogSchema,
  drinkUpdateSchema,
  bloodTestSchema,
  bodyEntrySchema,
  epigeneticTestSchema,
  eyeExamSchema,
  tsvImportSchema
} from '../lib/meatspaceValidation.js';
import * as meatspaceService from '../services/meatspace.js';
import * as alcoholService from '../services/meatspaceAlcohol.js';
import * as healthService from '../services/meatspaceHealth.js';
import { importTSV } from '../services/meatspaceImport.js';

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
  const result = await alcoholService.updateDrink(date, parseInt(index, 10), data);
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
  const removed = await alcoholService.removeDrink(date, parseInt(index, 10));
  if (!removed) {
    throw new ServerError('Drink entry not found', { status: 404, code: 'NOT_FOUND' });
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

// =============================================================================
// NUTRITION
// =============================================================================

/**
 * GET /api/meatspace/nutrition
 * Nutrition summary + averages
 */
router.get('/nutrition', asyncHandler(async (req, res) => {
  const summary = await healthService.getNutritionSummary();
  res.json(summary);
}));

/**
 * GET /api/meatspace/nutrition/daily
 * Daily nutrition entries
 */
router.get('/nutrition/daily', asyncHandler(async (req, res) => {
  const entries = await healthService.getDailyNutrition(req.query.from, req.query.to);
  res.json(entries);
}));

// =============================================================================
// IMPORT
// =============================================================================

/**
 * POST /api/meatspace/import/tsv
 * Import TSV spreadsheet (5MB limit handled by express.json middleware)
 */
router.post('/import/tsv', asyncHandler(async (req, res) => {
  const { content } = validateRequest(tsvImportSchema, req.body);
  const stats = await importTSV(content);
  if (stats.error) {
    throw new ServerError(stats.error, { status: 400, code: 'IMPORT_FAILED' });
  }
  res.json(stats);
}));

export default router;
