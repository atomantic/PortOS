/**
 * Daily Driver state (issue #2666).
 *
 *   GET  /api/daily-driver          → { today, firstVisitToday, handledToday }  (records the visit)
 *   POST /api/daily-driver/handled  → { today, firstVisitToday, handledToday }  (marks the day handled)
 *
 * No LLM calls — this only reads/writes per-day flags (AI Provider Usage Policy).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import * as dailyDriver from '../services/dailyDriver.js';

const router = Router();

// GET records the landing so `firstVisitToday` flips false after the first hit
// of the local day (subsequent same-day fetches still report handledToday, so
// the card stays visible until the user handles it).
router.get('/', asyncHandler(async (req, res) => {
  const state = await dailyDriver.getAndRecordVisit();
  res.json(state);
}));

// POST marks the driver handled for today — the card self-hides on the next read.
router.post('/handled', asyncHandler(async (req, res) => {
  const state = await dailyDriver.markDriverHandled();
  res.json(state);
}));

export default router;
