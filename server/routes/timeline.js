import { Router } from 'express';
import { z } from 'zod';
import { unlink } from 'fs/promises';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { uploadSingle } from '../lib/multipart.js';
import * as humanActivity from '../services/humanActivity.js';
import { importSpotifyHistory } from '../services/spotifyImport.js';
import { importTakeoutLocationHistory } from '../services/takeoutLocationImport.js';

const router = Router();

// Bulk-export uploads (Spotify extended history, Google Takeout location
// history) are ZIPs of JSON arrays bounded by the account lifetime — 200MB
// comfortably covers years of history. Both accept the same ZIP-or-JSON shape.
const zipOrJsonUpload = (label) => uploadSingle('file', {
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(zip|json)$/i.test(file.originalname)
      || ['application/zip', 'application/x-zip-compressed', 'application/json', 'text/json'].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new ServerError(`Only ${label} export ZIP or JSON files are accepted`, { status: 400, code: 'BAD_REQUEST' }));
  },
});

const uploadSpotify = zipOrJsonUpload('Spotify');
const uploadTakeoutLocation = zipOrJsonUpload('Google Takeout location');

// `preview` (a multipart text field, so it arrives as a string) toggles a
// parse-only dry run — count what would be imported without writing. Only map
// the recognized true/false tokens; any other string is left as-is so Zod
// rejects it with a 400 rather than silently coercing an unknown value to a
// (write-path) real import.
const importBodySchema = z.object({
  preview: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
    return v; // unrecognized → Zod boolean check fails → 400
  }, z.boolean().optional().default(false)),
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

// Shared handler for the bulk-backfill importers (#2160). Each accepts a ZIP or
// single JSON via multipart upload; `preview=true` parses + summarizes without
// writing; a real import is idempotent (dedupe key per source), so re-imports
// are safe. The uploaded temp file is ALWAYS unlinked, success or not, and BOTH
// validation and the import run inside the cleanup chain so a rejected `preview`
// value still unlinks the already-staged temp upload.
const importHandler = (importFn) => asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file?.path) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });
  const run = async () => {
    const { preview } = validateRequest(importBodySchema, req.body);
    return importFn(file, { dryRun: preview });
  };
  const result = await run().finally(() => unlink(file.path).catch(() => {}));
  res.json(result);
});

// POST /api/timeline/import/spotify — bulk-backfill Spotify extended streaming
// history (dedupe on played-at + track).
router.post('/import/spotify', uploadSpotify, importHandler(importSpotifyHistory));

// POST /api/timeline/import/takeout-location — bulk-backfill Google Takeout
// "Location History (Timeline)" semantic place visits → place.visit events
// (dedupe on visit-start + place identity).
router.post('/import/takeout-location', uploadTakeoutLocation, importHandler(importTakeoutLocationHistory));

export default router;
