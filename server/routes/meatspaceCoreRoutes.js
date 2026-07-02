/**
 * Meatspace Core Routes
 *
 * Overview, profile/lifestyle config, birth date, and the death-clock / LEV trackers.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { configUpdateSchema, lifestyleUpdateSchema } from '../lib/meatspaceValidation.js';
import { birthDateInputSchema } from '../lib/identityValidation.js';
import * as meatspaceService from '../services/meatspace.js';

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

export default router;
