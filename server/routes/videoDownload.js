/**
 * Video downloader routes (#1946) — Dev Tools utility that downloads a full
 * video from a YouTube or x.com/Twitter URL via yt-dlp into PATHS.videos, then
 * surfaces it in the existing media library.
 *
 *   POST   /api/devtools/video-download                → { jobId }  (kick off a download)
 *   GET    /api/devtools/video-download/downloads       → Entry[]    (downloaded videos, newest first)
 *   DELETE /api/devtools/video-download/downloads/:id   → { ok }     (delete a downloaded video)
 *   GET    /api/devtools/video-download/yt-dlp           → yt-dlp version + update availability
 *   POST   /api/devtools/video-download/yt-dlp/update    → update yt-dlp in place
 *   GET    /api/devtools/video-download/:jobId/events    → SSE progress
 *   POST   /api/devtools/video-download/:jobId/cancel    → { ok }
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest, videoDownloadSchema, isPaginationRequested, paginateArray,
} from '../lib/validation.js';
import {
  startVideoDownload,
  attachDownloadSseClient,
  cancelVideoDownload,
  listDownloads,
  deleteDownload,
} from '../services/videoDownload.js';
import { getYtDlpUpdateStatus, updateYtDlp } from '../services/ytdlpUpdate.js';

const router = Router();

router.post('/', asyncHandler(async (req, res) => {
  const { url } = validateRequest(videoDownloadSchema, req.body ?? {});
  res.status(202).json(await startVideoDownload(url));
}));

// `downloads` is a distinct first segment from a job's `:jobId` (whose routes
// are always two-segment — `:jobId/events`, `:jobId/cancel`), so no collision.
router.get('/downloads', asyncHandler(async (req, res) => {
  const downloads = await listDownloads();
  if (!isPaginationRequested(req.query)) return res.json(downloads);
  res.json(paginateArray(downloads, req.query, { defaultLimit: 50, maxLimit: 500 }));
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

// A `brew upgrade` can take a minute, so the package manager's own output is
// relayed over `ytdlp:update` while it runs — the page renders it as a status
// line on the button that started it.
router.post('/yt-dlp/update', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const emit = (frame) => io?.emit('ytdlp:update', frame);
  const result = await updateYtDlp({ onProgress: emit });
  if (!result.success) {
    emit({ event: 'error', message: result.error });
    throw new ServerError(result.error || 'yt-dlp update failed', { status: 502 });
  }
  emit({ event: 'complete', message: `yt-dlp ${result.note || `updated to ${result.version}`}` });
  res.json(result);
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
