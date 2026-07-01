/**
 * Video downloader routes (#1946) — Dev Tools utility that downloads a full
 * video from a YouTube or x.com/Twitter URL via yt-dlp into PATHS.videos, then
 * surfaces it in the existing media library.
 *
 *   POST   /api/devtools/video-download                → { jobId }  (kick off a download)
 *   GET    /api/devtools/video-download/downloads       → Entry[]    (downloaded videos, newest first)
 *   DELETE /api/devtools/video-download/downloads/:id   → { ok }     (delete a downloaded video)
 *   GET    /api/devtools/video-download/:jobId/events    → SSE progress
 *   POST   /api/devtools/video-download/:jobId/cancel    → { ok }
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, videoDownloadSchema } from '../lib/validation.js';
import {
  startVideoDownload,
  attachDownloadSseClient,
  cancelVideoDownload,
  listDownloads,
  deleteDownload,
} from '../services/videoDownload.js';

const router = Router();

router.post('/', asyncHandler(async (req, res) => {
  const { url } = validateRequest(videoDownloadSchema, req.body ?? {});
  res.status(202).json(await startVideoDownload(url));
}));

// `downloads` is a distinct first segment from a job's `:jobId` (whose routes
// are always two-segment — `:jobId/events`, `:jobId/cancel`), so no collision.
router.get('/downloads', asyncHandler(async (_req, res) => {
  res.json(await listDownloads());
}));

router.delete('/downloads/:id', asyncHandler(async (req, res) => {
  res.json(await deleteDownload(req.params.id));
}));

router.get('/:jobId/events', (req, res) => {
  if (!attachDownloadSseClient(req.params.jobId, res)) {
    throw new ServerError('Download job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelVideoDownload(req.params.jobId) });
});

export default router;
