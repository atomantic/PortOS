import { Router } from 'express';
import { z } from 'zod';
import { unlink } from 'fs/promises';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { uploadSingle } from '../lib/multipart.js';
import * as humanActivity from '../services/humanActivity.js';
import { importSpotifyHistory } from '../services/spotifyImport.js';

const router = Router();

// Spotify extended-history exports (a ZIP of JSON arrays) are bounded by the
// account lifetime — 200MB comfortably covers years of listening.
const uploadSpotify = uploadSingle('file', {
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(zip|json)$/i.test(file.originalname)
      || ['application/zip', 'application/x-zip-compressed', 'application/json', 'text/json'].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new ServerError('Only Spotify export ZIP or JSON files are accepted', { status: 400, code: 'BAD_REQUEST' }));
  },
});

// `preview` (a multipart text field, so it arrives as a string) toggles a
// parse-only dry run — count what would be imported without writing.
const importBodySchema = z.object({
  preview: z.preprocess(
    (v) => (typeof v === 'string' ? v === 'true' || v === '1' : v),
    z.boolean().optional().default(false),
  ),
});

const dayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const eventsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  source: z.string().max(64).optional(),
  kind: z.string().max(64).optional(),
  personId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

// Day view — all activity on a local calendar day plus an hourly histogram and
// source/kind tallies. `date` (YYYY-MM-DD) defaults to today in the user's tz;
// the URL is the source of truth for the selected day on the /timeline page.
router.get('/day', asyncHandler(async (req, res) => {
  const { date } = validateRequest(dayQuerySchema, req.query);
  const summary = await humanActivity.getDaySummary({ date });
  res.json(summary);
}));

// Filtered raw event list (from/to/source/kind/personId). Newest first.
router.get('/events', asyncHandler(async (req, res) => {
  const filters = validateRequest(eventsQuerySchema, req.query);
  const events = await humanActivity.listEvents(filters);
  res.json({ events });
}));

// POST /api/timeline/import/spotify — bulk-backfill Spotify extended streaming
// history (#2160). Accepts the privacy-download ZIP or a single history JSON via
// multipart upload. `preview=true` parses + summarizes without writing; a real
// import is idempotent (dedupe on played-at + track), so re-imports are safe.
// The uploaded temp file is always unlinked, whether the import succeeds or not.
router.post('/import/spotify', uploadSpotify, asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file?.path) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });
  // Wrap BOTH validation and the import in the cleanup chain — a rejected
  // `preview` value must still unlink the already-staged temp upload.
  const run = async () => {
    const { preview } = validateRequest(importBodySchema, req.body);
    return importSpotifyHistory(file, { dryRun: preview });
  };
  const result = await run().finally(() => unlink(file.path).catch(() => {}));
  res.json(result);
}));

export default router;
