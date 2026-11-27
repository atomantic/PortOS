/**
 * CoS Briefings, Claude changelog and Activity Routes
 */

import { Router } from 'express';
import { cosBriefingDateParamsSchema, whileAwayQuerySchema } from '../lib/cos/cosValidation.js';
import { getBriefing, getLatestBriefing, getTodayActivity, getWhileAwayActivity, listBriefings } from '../services/cos/cosReports.js';
import * as claudeChangelog from '../services/claudeChangelog.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';

const router = Router();

// GET /api/cos/briefings - List briefings with optional pagination
router.get('/briefings', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const briefings = await listBriefings();
  if (!isPaginationRequested(page)) return res.json({ briefings });
  res.json(paginateArray(briefings, page, { maxLimit: 500 }));
}));

// GET /api/cos/briefings/latest - Get latest briefing
router.get('/briefings/latest', asyncHandler(async (req, res) => {
  const briefing = await getLatestBriefing();
  res.json(briefing);
}));

// GET /api/cos/briefings/:date - Get briefing by date
router.get('/briefings/:date', asyncHandler(async (req, res) => {
  const { date } = validateRequest(cosBriefingDateParamsSchema, req.params);
  const briefing = await getBriefing(date);
  if (!briefing) {
    throw new ServerError('Briefing not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(briefing);
}));

// GET /api/cos/claude-changelog - Get Claude Code changelog (fetches Atom feed)
router.get('/claude-changelog', asyncHandler(async (req, res) => {
  const result = await claudeChangelog.checkChangelog();
  res.json(result);
}));

// GET /api/cos/activity/today - Get today's activity summary
router.get('/activity/today', asyncHandler(async (req, res) => {
  const activity = await getTodayActivity();
  res.json(activity);
}));

// GET /api/cos/activity/while-away - What agents did since ?since=<ISO> (the
// client's last-visit marker). Powers the "While You Were Away" dashboard card.
router.get('/activity/while-away', asyncHandler(async (req, res) => {
  const { since } = validateRequest(whileAwayQuerySchema, req.query);
  const activity = await getWhileAwayActivity(since);
  res.json(activity);
}));

export default router;
