import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  configUpdateSchema,
  lifestyleUpdateSchema,
  tsvImportSchema
} from '../lib/meatspaceValidation.js';
import * as meatspaceService from '../services/meatspace.js';
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
