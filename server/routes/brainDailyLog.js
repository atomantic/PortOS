/**
 * Brain Daily Log Routes
 *
 * Per-day journal entries with optional Obsidian vault mirroring.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { dailyLogSettingsSchema, activityDigestSettingsSchema } from '../lib/brainValidation.js';
import * as journal from '../services/brainJournal.js';
import * as activityDigest from '../services/activityDigest.js';

const router = Router();

// Resolve the :date route param: either 'today' → current local date, or a
// real ISO YYYY-MM-DD calendar day. Delegates to journal.isIsoDate so the
// date rules stay in one place (service layer) and can't drift between
// routes and internal callers.
const resolveJournalDate = async (date) => {
  if (!date || date === 'today') return journal.getToday();
  if (!journal.isIsoDate(date)) {
    throw new ServerError('Invalid date. Expected "today" or YYYY-MM-DD.', {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }
  return date;
};

/**
 * GET /api/brain/daily-log
 * List daily log entries (most recent first)
 */
router.get('/daily-log', asyncHandler(async (req, res) => {
  // Clamp pagination: negative or zero limit / negative offset would slice
  // unpredictably (or from the end of the array). Match the convention used
  // by other paginated brain routes.
  const parsedLimit = parseInt(req.query.limit, 10);
  const parsedOffset = parseInt(req.query.offset, 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200);
  const offset = Math.max(Number.isNaN(parsedOffset) ? 0 : parsedOffset, 0);
  // Opt-in to full entries; default is slim summaries (date + segmentCount +
  // obsidianPath) so the sidebar doesn't pull every day's content on load.
  const includeContent = req.query.includeContent === '1' || req.query.includeContent === 'true';
  const result = await journal.listJournals({ limit, offset, includeContent });
  res.json(result);
}));

/**
 * GET /api/brain/daily-log/settings
 * Get daily log configuration (obsidian vault/folder, auto-sync)
 */
router.get('/daily-log/settings', asyncHandler(async (req, res) => {
  const settings = await journal.getSettings();
  res.json(settings);
}));

/**
 * PUT /api/brain/daily-log/settings
 */
router.put('/daily-log/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(dailyLogSettingsSchema, req.body || {});
  const next = await journal.updateSettings(data);
  res.json(next);
}));

/**
 * POST /api/brain/daily-log/sync-obsidian
 * Re-mirror every existing entry into the currently-configured Obsidian vault.
 */
router.post('/daily-log/sync-obsidian', asyncHandler(async (req, res) => {
  const stats = await journal.resyncAllToObsidian();
  res.json(stats);
}));

/**
 * GET /api/brain/daily-log/digest-settings
 * Activity-digest (auto-draft) configuration. Registered BEFORE /:date so the
 * literal path isn't captured by the date param.
 */
router.get('/daily-log/digest-settings', asyncHandler(async (req, res) => {
  const settings = await activityDigest.getSettings();
  res.json(settings);
}));

/**
 * PUT /api/brain/daily-log/digest-settings
 */
router.put('/daily-log/digest-settings', asyncHandler(async (req, res) => {
  const data = validateRequest(activityDigestSettingsSchema, req.body || {});
  const next = await activityDigest.updateSettings(data);
  res.json(next);
}));

/**
 * GET /api/brain/daily-log/:date (accepts 'today')
 */
router.get('/daily-log/:date', asyncHandler(async (req, res) => {
  const date = await resolveJournalDate(req.params.date);
  const entry = await journal.getJournal(date);
  res.json({ date, entry });
}));

/**
 * POST /api/brain/daily-log/:date/append — append a text segment
 */
router.post('/daily-log/:date/append', asyncHandler(async (req, res) => {
  const date = await resolveJournalDate(req.params.date);
  const { text, source } = req.body || {};
  // Trim-check here too so a whitespace-only payload doesn't no-op all the
  // way through appendJournal() and still return a 200 — clients would read
  // that as a successful append.
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ServerError('text is required', { status: 400, code: 'BAD_REQUEST' });
  }
  const entry = await journal.appendJournal(date, text, { source });
  res.json({ date, entry });
}));

/**
 * POST /api/brain/daily-log/:date/draft — manual "draft today now".
 * Direct user action, so it runs regardless of the scheduler's enabled flag and
 * doesn't advance the scheduler cursor. Uses the configured provider/model when
 * one is set (LLM narrative), else the non-LLM structured summary.
 */
router.post('/daily-log/:date/draft', asyncHandler(async (req, res) => {
  const date = await resolveJournalDate(req.params.date);
  const result = await activityDigest.runDigestForDate(date);
  const entry = await journal.getJournal(date);
  res.json({ ...result, entry });
}));

/**
 * PUT /api/brain/daily-log/:date — full content replace
 */
router.put('/daily-log/:date', asyncHandler(async (req, res) => {
  const date = await resolveJournalDate(req.params.date);
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    throw new ServerError('content is required', { status: 400, code: 'BAD_REQUEST' });
  }
  const entry = await journal.setJournalContent(date, content);
  res.json({ date, entry });
}));

/**
 * DELETE /api/brain/daily-log/:date
 */
router.delete('/daily-log/:date', asyncHandler(async (req, res) => {
  const date = await resolveJournalDate(req.params.date);
  const deleted = await journal.deleteJournal(date);
  if (!deleted) {
    throw new ServerError('Journal not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
