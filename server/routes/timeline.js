import { importBodySchema, whatsappImportBodySchema, dayQuerySchema, eraseQuerySchema, gmailImportSchema } from '../lib/timelineValidation.js';
import { Router } from 'express';
import { unlink } from 'fs/promises';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { uploadSingle } from '../lib/multipart.js';
import * as humanActivity from '../services/humanActivity.js';
import * as spotifyAuth from '../services/spotifyAuth.js';
import { importSpotifyHistory } from '../services/spotifyImport.js';
import { importTakeoutLocationHistory } from '../services/takeoutLocationImport.js';
import { importDiscordHistory } from '../services/discordImport.js';
import { importWhatsappHistory } from '../services/whatsappImport.js';
import { importBrowserHistory } from '../services/browserHistoryImport.js';
import { importYoutubeHistory } from '../services/youtubeImport.js';
import { importGmailMbox } from '../services/gmailMboxImport.js';

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
// YouTube watch history ships as a Takeout `watch-history.json` (or the whole
// ZIP) — same ZIP-or-JSON shape as the other Takeout importers.
const uploadYoutube = zipOrJsonUpload('Google Takeout YouTube watch history');
const uploadTakeoutLocation = zipOrJsonUpload('Google Takeout location');
// Browser history ships as a Takeout Chrome `History.json` (or the whole ZIP) —
// same ZIP-or-JSON shape as the other Takeout importers.
const uploadBrowserHistory = zipOrJsonUpload('Chrome browser history');
// The Discord data package ships `messages.csv` in older exports, so accept CSV
// alongside the ZIP/JSON the other importers take.
const uploadDiscord = uploadSingle('file', {
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(zip|json|csv)$/i.test(file.originalname)
      || ['application/zip', 'application/x-zip-compressed', 'application/json', 'text/json', 'text/csv', 'application/csv'].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new ServerError('Only Discord data-package ZIP, JSON, or CSV files are accepted', { status: 400, code: 'BAD_REQUEST' }));
  },
});
// WhatsApp "Export chat" ships a `_chat.txt` transcript, either standalone or
// bundled in a ZIP with media — accept the plain text file alongside the ZIP.
const uploadWhatsapp = uploadSingle('file', {
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(zip|txt)$/i.test(file.originalname)
      || ['application/zip', 'application/x-zip-compressed', 'text/plain'].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new ServerError('Only WhatsApp chat-export TXT or ZIP files are accepted', { status: 400, code: 'BAD_REQUEST' }));
  },
});

// Day view — all activity on a local calendar day plus an hourly histogram and
// source/kind tallies. `date` (YYYY-MM-DD) defaults to today in the user's tz;
// the URL is the source of truth for the selected day on the /timeline page.
router.get('/day', asyncHandler(async (req, res) => {
  const { date } = validateRequest(dayQuerySchema, req.query);
  const summary = await humanActivity.getDaySummary({ date });
  res.json(summary);
}));

// Per-source counts and date range — what "Manage imported data" shows before a delete.
router.get('/sources', asyncHandler(async (req, res) => {
  res.json({ sources: await humanActivity.listSourceCounts() });
}));

// Erase one source's events (optionally a kind / from–to range). `source` is
// required; there is no way to wipe every source in one call.
router.delete('/events', asyncHandler(async (req, res) => {
  const filters = validateRequest(eraseQuerySchema, req.query);
  const result = await humanActivity.eraseEvents(filters);
  if (filters.source === 'spotify' && !filters.kind && !filters.from && !filters.to) {
    await spotifyAuth.clearAuth();
  }
  res.json(result);
}));

// Shared handler for the bulk-backfill importers (#2160). Each accepts a ZIP or
// single JSON via multipart upload; `preview=true` parses + summarizes without
// writing; a real import is idempotent (dedupe key per source), so re-imports
// are safe. The uploaded temp file is ALWAYS unlinked, success or not, and BOTH
// validation and the import run inside the cleanup chain so a rejected `preview`
// value still unlinks the already-staged temp upload.
// `schema` validates the multipart text fields (defaulting to just `preview`);
// `toOptions` maps the validated body to the importer's option object so a source
// with extra fields (WhatsApp's `yourName`) threads them through the same seam.
const importHandler = (importFn, { schema = importBodySchema, toOptions } = {}) => asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file?.path) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });
  const run = async () => {
    const body = validateRequest(schema, req.body);
    const options = toOptions ? toOptions(body) : { dryRun: body.preview };
    return importFn(file, options);
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

// POST /api/timeline/import/discord — bulk-backfill a Discord "data package"
// (the messages you sent across every channel/DM) → message.sent events
// (dedupe on the globally-unique Discord message snowflake id).
router.post('/import/discord', uploadDiscord, importHandler(importDiscordHistory));

// POST /api/timeline/import/whatsapp — bulk-backfill a WhatsApp "Export chat"
// transcript (`_chat.txt`, standalone or zipped) → message events (dedupe on a
// content hash, since WhatsApp lines carry no message id). An optional `yourName`
// classifies direction (sent vs received); absent → neutral `message` events. An
// optional `chatLabel` scopes the dedupe key to a stable chat name so distinct
// chats don't collide; absent → the legacy un-scoped key. A file whose day/month
// order can't be inferred needs `dateOrder` (mdy|dmy) to commit (400
// WHATSAPP_DATE_ORDER_REQUIRED otherwise); previews always succeed.
router.post('/import/whatsapp', uploadWhatsapp, importHandler(importWhatsappHistory, {
  schema: whatsappImportBodySchema,
  toOptions: (body) => ({ dryRun: body.preview, yourName: body.yourName ?? null, chatLabel: body.chatLabel ?? null, dateOrder: body.dateOrder ?? null }),
}));

// POST /api/timeline/import/browser — bulk-backfill a Google Takeout Chrome
// `History.json` (standalone or the whole ZIP) → web.visit events under source
// `browser` (dedupe on a content hash of visit-instant + URL, since the export
// carries no visit id). Subframe (iframe) loads are dropped as noise.
router.post('/import/browser', uploadBrowserHistory, importHandler(importBrowserHistory));

// POST /api/timeline/import/youtube — bulk-backfill a Google Takeout YouTube
// `watch-history.json` (standalone or the whole ZIP) → media.watch events under
// source `youtube` (dedupe on video id + local day, shared with the live scrape).
router.post('/import/youtube', uploadYoutube, importHandler(importYoutubeHistory));

router.post('/import/gmail', asyncHandler(async (req, res) => {
  const { path: mboxPath, preview, yourEmail } = validateRequest(gmailImportSchema, req.body);
  const result = await importGmailMbox({
    path: mboxPath,
    dryRun: preview,
    selfEmails: yourEmail ? [yourEmail] : [],
  });
  res.json(result);
}));

export default router;
