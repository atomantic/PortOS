/**
 * Video downloader (#1946) — follow-up to #1945. Where trackYoutubeImport.js
 * extracts just the AUDIO track, this downloads the FULL video from a YouTube
 * or x.com/Twitter URL via yt-dlp, lands it under PATHS.videos as a
 * distinguishable `downloaded-<uuid>.mp4`, generates a thumbnail, and writes a
 * `source: 'download'` entry into the shared video-history store so it shows up
 * in the existing media library/gallery and gets picked up by the mediaAssetIndex
 * `videoGenEvents 'completed'` hook UNMODIFIED (issue design option (b) —
 * "write a lightweight video-history-like entry"; the `source` marker + filename
 * prefix keep the "derived, not a generation" framing honest without a new row
 * shape or a new index event).
 *
 * Mirrors trackYoutubeImport's job pattern exactly: kickoff returns a jobId
 * immediately, the download runs detached, progress streams over the shared SSE
 * helpers, and the client attaches with useSseProgress. A single yt-dlp
 * invocation does the whole job (best mp4 video+audio merged via ffmpeg).
 *
 * The yt-dlp invocation itself lives in ytdlpVideoImport.js — extracted so the
 * YouTube brain ingest can run the same download as one step of a bigger job
 * (the same split ytdlpAudioImport.js already made for the audio path). This
 * module keeps the download-specific concerns: the host allowlist, the SSE job
 * map, and the `source: 'download'` video-history entry.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { shortId, PATHS } from '../lib/fileUtils.js';
import { findFfmpeg, generateThumbnail, probeVideoDuration } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { downloadVideoToDir, cleanupProducedFiles } from './ytdlpVideoImport.js';
import { loadHistory, mutateVideoHistory } from './videoGen/history.js';
import { deleteHistoryItem } from './videoGen/local.js';
import { videoGenEvents } from './videoGen/events.js';

// Host allowlist: YouTube (watch/shorts/youtu.be) + x.com/Twitter status URLs.
// Same reasoning as #1945's YOUTUBE_URL_RE — constrains what a shelled-out
// yt-dlp will touch even though args are passed as an array (no shell
// interpolation), and gives the user a clear "unsupported host" error up front
// instead of a cryptic yt-dlp failure.
export const SUPPORTED_VIDEO_URL_RE =
  /^https?:\/\/(www\.|m\.|mobile\.)?(youtube\.com\/(watch\?[^\s#]*\bv=[\w-]{6,}|shorts\/[\w-]{6,})|youtu\.be\/[\w-]{6,}|(x|twitter)\.com\/[^\s/]+\/status\/\d+)/i;

export function assertSupportedVideoUrl(url) {
  if (typeof url !== 'string' || !SUPPORTED_VIDEO_URL_RE.test(url)) {
    throw new ServerError(
      'Unsupported video URL (expected a YouTube video/shorts, youtu.be, or x.com/twitter.com status URL)',
      { status: 400, code: 'VIDEO_URL_INVALID' },
    );
  }
}

// Bound resource use the same way #1945 does for audio: without these, a long
// video, livestream, or archive URL downloads unbounded, eating disk in
// data/videos and CPU with no cap. Generous but finite for full-video pulls.
export const VIDEO_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const VIDEO_DOWNLOAD_MAX_DURATION_SEC = 60 * 60; // 1 hour

const FILENAME_PREFIX = 'downloaded-';

// jobId -> { id, status, clients, lastPayload, process }
const downloadJobs = new Map();

export const attachDownloadSseClient = (jobId, res) => attachSse(downloadJobs, jobId, res);

// The job map is module-private, which left cancelVideoDownload untestable — and
// an untested cancel path is exactly how a refactor shipped it referencing an
// unimported killWithEscalation while the whole suite stayed green. Exposing the
// map lets a test register a fake job and actually run the cancel.
export const __testing = { downloadJobs };

/** Cancel an in-flight download. Returns false if the job is unknown or already finished. */
export function cancelVideoDownload(jobId) {
  const job = downloadJobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  killWithEscalation(proc, { label: 'yt-dlp download', stillRunning: () => job.process === proc });
  return true;
}

/** List downloaded videos — the `source: 'download'` slice of video-history, newest first. */
export async function listDownloads() {
  // No `.catch(() => [])`: that re-swallowed exactly what `loadHistory`'s strict
  // read exists to surface (#4115), turning an unreadable history into a
  // confident "you have no downloads". Let it bubble to the error middleware.
  const history = await loadHistory();
  return (Array.isArray(history) ? history : []).filter((h) => h?.source === 'download');
}

/**
 * Delete a downloaded video. Verifies the id is actually a download (not a
 * generated render) before delegating to the shared deleteHistoryItem, which
 * removes the file, thumbnail, history entry, and mediaAssetIndex row
 * (identical lifecycle to a deleted generation).
 */
export async function deleteDownload(id) {
  // Same reason as listDownloads: an unreadable history must not answer
  // "not found" (a 404 the user would read as "already gone").
  const history = await loadHistory();
  const item = (Array.isArray(history) ? history : []).find((h) => h?.id === id);
  if (!item || item.source !== 'download') {
    throw new ServerError('Downloaded video not found', { status: 404, code: 'NOT_FOUND' });
  }
  return deleteHistoryItem(id);
}

// A cancelled/failed run can leave yt-dlp's pre-merge fragment files behind
// (`downloaded-<uuid>.f137.mp4`, `.part`, etc.), so cleanup globs every file
// this job's prefix touched in PATHS.videos rather than unlinking one path.
const cleanupDownloadFiles = (jobId) => cleanupProducedFiles(`${FILENAME_PREFIX}${jobId}`, PATHS.videos);

// Build the `source: 'download'` video-history entry. Pure + exported so the
// load-bearing shape (the fields normalizeVideo, mediaAssetIndex videoToRow, and
// deleteHistoryItem all depend on) is pinned by a unit test rather than only
// implicitly exercised by the spawn path. `id === jobId` so the live media-index
// `completed` hook loads it by generationId AND deleteHistoryItem's `${id}.jpg`
// thumbnail + `${filename}` cleanup both resolve.
export function buildDownloadHistoryEntry({ jobId, filename, thumbnail, durationSec, title, sourceUrl }) {
  return {
    id: jobId,
    filename,
    thumbnail,
    createdAt: new Date().toISOString(),
    source: 'download',
    sourceUrl,
    title: title || 'Downloaded video',
    ...(durationSec != null ? { durationSec } : {}),
  };
}

/**
 * Download a video and land it in the shared media library.
 *
 * This — not the bare yt-dlp spawn — is the unit a second caller wants: it owns
 * the `downloaded-<id>` filename prefix, the thumbnail + duration probe, the
 * `source: 'download'` video-history entry, the media-index `completed` event,
 * and cleanup of partial files when any of that fails. Extracted so the YouTube
 * brain ingest lands a video EXACTLY the way the Dev Tools downloader does;
 * duplicating the tail is how the two silently drift.
 *
 * `outcome: 'canceled' | 'failed'` are returned rather than thrown (matching
 * `downloadVideoToDir`) so the caller decides how to surface them; anything that
 * fails AFTER a successful download throws, with the partial files already
 * cleaned up.
 *
 * `id` is the library id: the filename prefix, the thumbnail name and the
 * history-entry id all derive from it, so a caller that already has a job id
 * passes it to keep the two aligned (the SSE downloader does — its terminal
 * frame's `id` has always been the video's id).
 *
 * @returns {Promise<{ outcome:'complete'|'canceled'|'failed', entry?:object, reason?:string }>}
 */
export async function downloadVideoIntoLibrary({
  url, ytDlp, ffmpeg, id, maxBytes = VIDEO_DOWNLOAD_MAX_BYTES,
  maxDurationSec = VIDEO_DOWNLOAD_MAX_DURATION_SEC, onProgress, registerProcess,
}) {
  const jobId = id || randomUUID();
  try {
    const result = await downloadVideoToDir({
      url,
      ytDlp,
      ffmpeg,
      outDir: PATHS.videos,
      filePrefix: `${FILENAME_PREFIX}${jobId}`,
      maxBytes,
      maxDurationSec,
      onProgress,
      registerProcess,
    });
    if (result.outcome !== 'complete') return result;

    const { filename, title } = result;
    const outPath = join(PATHS.videos, filename);
    onProgress?.({ percent: 100, stage: 'finalizing' });
    const [thumbnail, durationSec] = await Promise.all([
      generateThumbnail(outPath, jobId),
      probeVideoDuration(outPath).catch(() => null),
    ]);

    // Derived, not a generation: a `source: 'download'` video-history entry so
    // the existing videoToRow / onVideoCompleted media-index path and the
    // gallery pick it up unmodified. Serialized read-modify-write so two
    // near-simultaneous downloads can't clobber each other's entry.
    const entry = buildDownloadHistoryEntry({ jobId, filename, thumbnail, durationSec, title, sourceUrl: url });
    await mutateVideoHistory((history) => { history.unshift(entry); return history; });

    // Let the live media-asset index hook index this immediately (it loads
    // history by generationId and upserts one row). Reconcile is the backstop.
    videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail });
    return { outcome: 'complete', entry };
  } catch (err) {
    // A throw between the download and the history write would otherwise orphan
    // a multi-GB file in data/videos with nothing pointing at it.
    await cleanupDownloadFiles(jobId);
    throw err;
  }
}

/**
 * Kick off a full-video download. Returns `{ jobId }` immediately; the download
 * runs detached and streams progress over SSE. Terminal frames:
 * `{ type: 'complete', id, video }`, `{ type: 'error', error }`, or
 * `{ type: 'canceled' }`.
 */
export async function startVideoDownload(url) {
  assertSupportedVideoUrl(url);

  const [ytDlp, ffmpeg] = await Promise.all([findYtDlp(), findFfmpeg()]);
  if (!ytDlp) throw new ServerError('yt-dlp not found on PATH', { status: 500, code: 'YTDLP_MISSING' });
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const jobId = randomUUID();
  const job = { id: jobId, status: 'running', clients: [], process: null };
  downloadJobs.set(jobId, job);
  console.log(`📥 Video download ${shortId(jobId)} — ${url}`);

  (async () => {
    try {
      const result = await downloadVideoIntoLibrary({
        url,
        ytDlp,
        ffmpeg,
        id: jobId, // keep the library id == the SSE job id, as it has always been
        onProgress: ({ percent, stage }) => broadcastSse(job, { type: 'progress', percent, ...(stage ? { stage } : {}) }),
        registerProcess: (proc) => { job.process = proc; },
      });

      if (result.outcome === 'canceled') {
        console.log(`🛑 Video download ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        return;
      }
      if (result.outcome === 'failed') throw new Error(result.reason);

      const { entry } = result;
      console.log(`📥 Video download ${shortId(jobId)} complete — "${entry.title}" (${entry.filename})`);
      broadcastSse(job, { type: 'complete', id: jobId, video: entry });
    } catch (err) {
      console.error(`❌ Video download ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
    } finally {
      closeJobAfterDelay(downloadJobs, jobId);
    }
  })();

  return { jobId };
}
