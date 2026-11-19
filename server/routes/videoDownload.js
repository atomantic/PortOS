/**
 * Video downloader routes (#1946) — Dev Tools utility that downloads a full
 * video from a YouTube or x.com/Twitter URL via yt-dlp into PATHS.videos, then
 * surfaces it in the existing media library.
 *
 *   POST   /api/devtools/video-download                → { jobId }  (kick off a download)
 *   GET    /api/devtools/video-download/downloads       → Entry[]    (downloaded videos, newest first)
 *   DELETE /api/devtools/video-download/downloads/:id   → { ok }     (delete a downloaded video)
 *   GET    /api/devtools/video-download/yt-dlp           → yt-dlp version + update availability
 *   POST   /api/devtools/video-download/yt-dlp/install   → install yt-dlp with Homebrew
 *   POST   /api/devtools/video-download/yt-dlp/update    → update yt-dlp in place
 *   GET    /api/devtools/video-download/:jobId/events    → SSE progress
 *   POST   /api/devtools/video-download/:jobId/cancel    → { ok }
 */

import { Router } from 'express';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  startVideoDownload,
  attachDownloadSseClient,
  cancelVideoDownload,
  listDownloads,
  deleteDownload,
} from '../services/videoDownload.js';
import { getYtDlpUpdateStatus, installYtDlp, updateYtDlp } from '../services/ytdlpUpdate.js';
import { videoDownloadSchema } from '../lib/mediaGenerationValidation.js';

const router = Router();

router.post('/', asyncHandler(async (req, res) => {
  const { url } = validateRequest(videoDownloadSchema, req.body ?? {});
  res.status(202).json(await startVideoDownload(url));
}));

// `downloads` is a distinct first segment from a job's `:jobId` (whose routes
// are always two-segment — `:jobId/events`, `:jobId/cancel`), so no collision.
router.get('/downloads', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const downloads = await listDownloads();
  if (!isPaginationRequested(page)) return res.json(downloads);
  res.json(paginateArray(downloads, page, { defaultLimit: 50, maxLimit: 500 }));
}));

router.delete('/downloads/:id', asyncHandler(async (req, res) => {
  res.json(await deleteDownload(req.params.id));
}));

// yt-dlp's own version and update state. A stale yt-dlp is the most common cause
// of a failed download here — YouTube's player handshake moves release to
// release — so the page offers the update rather than sending the user to a
// terminal. Kept off the download request: it spends a `brew info` and possibly
// a GitHub round-trip, neither of which a download should wait on.
//
// `yt-dlp` is a distinct first segment from `downloads` and from a job's
// `:jobId` (whose routes are always two-segment), so no collision.
router.get('/yt-dlp', asyncHandler(async (_req, res) => {
  res.json(await getYtDlpUpdateStatus());
}));

// Relay Homebrew output while the package manager is running.
const runYtDlpAction = (action, verb) => asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const emit = (frame) => io?.emit('ytdlp:update', frame);
  const result = await action({ onProgress: emit });
  if (!result.success) {
    emit({ event: 'error', message: result.error });
    throw new ServerError(result.error || `yt-dlp ${verb} failed`, { status: 502 });
  }
  emit({ event: 'complete', message: `yt-dlp ${result.note || `${verb} completed (${result.version})`}` });
  res.json(result);
});

router.post('/yt-dlp/install', runYtDlpAction(installYtDlp, 'install'));
router.post('/yt-dlp/update', runYtDlpAction(updateYtDlp, 'update'));

router.get('/:jobId/events', (req, res) => {
  if (!attachDownloadSseClient(req.params.jobId, res)) {
    throw new ServerError('Download job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelVideoDownload(req.params.jobId) });
});

export default router;
