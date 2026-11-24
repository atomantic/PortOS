/**
 * Meatspace Core Routes
 *
 * Overview, profile/lifestyle config, birth date, and the death-clock / LEV trackers.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { configUpdateSchema, lifestyleUpdateSchema } from '../lib/meatspaceValidation.js';
import { birthDateInputSchema } from '../lib/identityValidation.js';
import * as meatspaceService from '../services/meatspace/meatspace.js';
import { getLoggingStats } from '../services/meatspace/meatspaceLoggingStats.js';

const router = Router();


/**
 * GET /api/meatspace
 * Overview: death clock, LEV, health summary
 */
router.get('/', asyncHandler(async (req, res) => {
  const overview = await meatspaceService.getOverview();
  res.json(overview);
}));

/**
 * GET /api/meatspace/logging-stats
 * Cross-domain health-logging streak + this-week counts for the dashboard widget.
 */
router.get('/logging-stats', asyncHandler(async (req, res) => {
  const stats = await getLoggingStats();
  res.json(stats);
}));


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


/**
 * GET /api/meatspace/death-clock
 * Full death clock computation
 */
router.get('/death-clock', asyncHandler(async (req, res) => {
  const deathClock = await meatspaceService.getDeathClock();
  res.json(deathClock);
}));

export default router;
