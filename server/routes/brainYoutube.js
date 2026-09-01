/**
 * Brain YouTube Ingest Routes
 *
 * Mounted at /api/brain/youtube. Kickoff returns a jobId immediately and the
 * work streams over SSE (same job/SSE shape as the track import and the Dev
 * Tools video downloader), so a 40-minute talk doesn't hold an HTTP request
 * open.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { youtubeIngestSchema, youtubeIngestSettingsSchema } from '../lib/brainValidation.js';
import * as ingest from '../services/youtubeIngest.js';

const router = Router();

/**
 * POST /api/brain/youtube/ingest
 * Start an ingest. Body: { url, captureTranscript?, downloadVideo?, ingestAudio?,
 * note?, agentPrompt?, tags?, priority? } → { jobId, videoId }
 */
router.post('/ingest', asyncHandler(async (req, res) => {
  const data = validateRequest(youtubeIngestSchema, req.body || {});
  const result = await ingest.startYoutubeIngest(data);
  res.json(result);
}));

/** GET /api/brain/youtube/ingest/:jobId/events — SSE progress stream. */
router.get('/ingest/:jobId/events', (req, res) => {
  if (!ingest.attachIngestSseClient(req.params.jobId, res)) {
    res.status(404).json({ error: 'Ingest job not found' });
  }
});

/** POST /api/brain/youtube/ingest/:jobId/cancel */
router.post('/ingest/:jobId/cancel', asyncHandler(async (req, res) => {
  const canceled = ingest.cancelYoutubeIngest(req.params.jobId);
  if (!canceled) throw new ServerError('Ingest job not found or already finished', { status: 404, code: 'NOT_FOUND' });
  res.json({ message: 'Cancellation requested' });
}));

/** GET /api/brain/youtube/ingests — every ingest, newest first. */
router.get('/ingests', asyncHandler(async (req, res) => {
  res.json({ ingests: await ingest.listIngests() });
}));

/** GET /api/brain/youtube/ingests/:videoId */
router.get('/ingests/:videoId', asyncHandler(async (req, res) => {
  const record = await ingest.getIngest(req.params.videoId);
  if (!record) throw new ServerError('Ingest not found', { status: 404, code: 'NOT_FOUND' });
  res.json(record);
}));

/** GET /api/brain/youtube/ingests/:videoId/transcript — the stored markdown. */
router.get('/ingests/:videoId/transcript', asyncHandler(async (req, res) => {
  const markdown = await ingest.getTranscript(req.params.videoId);
  if (markdown === null) {
    throw new ServerError('No transcript is stored for this video', { status: 404, code: 'TRANSCRIPT_NOT_FOUND' });
  }
  res.type('text/markdown').send(markdown);
}));

/** DELETE /api/brain/youtube/ingests/:videoId — drops local files + the note. */
router.delete('/ingests/:videoId', asyncHandler(async (req, res) => {
  const removed = await ingest.deleteIngest(req.params.videoId);
  if (!removed) throw new ServerError('Ingest not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ message: 'Ingest removed' });
}));

router.get('/settings', asyncHandler(async (req, res) => {
  res.json(await ingest.getSettings());
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(youtubeIngestSettingsSchema, req.body || {});
  res.json(await ingest.updateSettings(data));
}));

export default router;
