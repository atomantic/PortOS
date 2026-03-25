/**
 * Proactive Alerts Routes
 *
 * REST API for proactive system alerts:
 *   GET  /api/alerts          — full alert list with counts
 *   GET  /api/alerts/summary  — compact summary for dashboard widget
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { generateAlerts, getAlertsSummary } from '../services/proactiveAlerts.js';

const router = Router();

// GET /api/alerts — full alert list
router.get('/', asyncHandler(async (req, res) => {
  const result = await generateAlerts();
  res.json(result);
}));

// GET /api/alerts/summary — compact summary for dashboard
router.get('/summary', asyncHandler(async (req, res) => {
  const result = await getAlertsSummary();
  res.json(result);
}));

export default router;
