/**
 * Proactive Alerts Routes
 *
 * REST API for proactive system alerts:
 *   GET  /api/alerts          — full alert list with counts
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { generateAlerts } from '../services/proactiveAlerts.js';

const router = Router();

// GET /api/alerts — full alert list
router.get('/', asyncHandler(async (req, res) => {
  const result = await generateAlerts();
  res.json(result);
}));

export default router;
