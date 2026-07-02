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
 */

import { spawn } from 'child_process';
import { readdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { shortId, PATHS, ensureDir } from '../lib/fileUtils.js';
import { findFfmpeg, generateThumbnail, probeVideoDuration } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
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

/** Cancel an in-flight download. Returns false if the job is unknown or already finished. */
export function cancelVideoDownload(jobId) {
  const job = downloadJobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (job.process === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ yt-dlp download didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
}

/** List downloaded videos — the `source: 'download'` slice of video-history, newest first. */
export async function listDownloads() {
  const history = await loadHistory().catch(() => []);
  return (Array.isArray(history) ? history : []).filter((h) => h?.source === 'download');
}

/**
 * Delete a downloaded video. Verifies the id is actually a download (not a
 * generated render) before delegating to the shared deleteHistoryItem, which
 * removes the file, thumbnail, and history entry. The next mediaAssetIndex
 * reconcile prunes its row (identical lifecycle to a deleted generation).
 */
export async function deleteDownload(id) {
  const history = await loadHistory().catch(() => []);
  const item = (Array.isArray(history) ? history : []).find((h) => h?.id === id);
  if (!item || item.source !== 'download') {
    throw new ServerError('Downloaded video not found', { status: 404, code: 'NOT_FOUND' });
  }
  return deleteHistoryItem(id);
}

const TITLE_PREFIX = 'PORTOS_TITLE:';
// Machine-readable progress markers via yt-dlp's --progress-template rather than
// scraping human-readable console lines — mirrors trackYoutubeImport.
const PROGRESS_PREFIX = 'PORTOS_PROGRESS:';
const STAGE_PREFIX = 'PORTOS_STAGE:';

// A cancelled/failed run can leave yt-dlp's pre-merge fragment files behind
// (`downloaded-<uuid>.f137.mp4`, `.part`, etc.), so cleanup globs every file
// this job's prefix touched in PATHS.videos rather than unlinking one path.
async function cleanupDownloadFiles(jobId) {
  const prefix = `${FILENAME_PREFIX}${jobId}`;
  const entries = await readdir(PATHS.videos).catch(() => []);
  await Promise.all(
    entries.filter((name) => name.startsWith(prefix)).map((name) => unlink(join(PATHS.videos, name)).catch(() => {})),
  );
}

// Locate the final produced file for a job. yt-dlp writes intermediate streams
// as `downloaded-<id>.f<code>.<ext>` and a `.part`/`.ytdl` in progress, then
// merges/remuxes to a single `downloaded-<id>.<ext>` and deletes the rest. We do
// NOT hardcode `.mp4`: the format fallback chain can land a single-file webm/mkv
// (VP9/AV1) that `--merge-output-format`/`--remux-video mp4` only converts on a
// best-effort basis, so assuming `.mp4` would miss a perfectly-good download and
// then delete it as a "failure". Prefer an exact `.mp4`, else the lone remaining
// non-intermediate file. Returns the basename or null when nothing was produced.
export async function findDownloadedFile(jobId, dir = PATHS.videos) {
  const prefix = `${FILENAME_PREFIX}${jobId}.`;
  const entries = await readdir(dir).catch(() => []);
  const candidates = entries.filter((n) =>
    n.startsWith(prefix)
    && !n.endsWith('.part')
    && !n.endsWith('.ytdl')
    && !/\.f\d+\.[^.]+$/.test(n), // format-fragment intermediates (.f137.mp4)
  );
  return candidates.find((n) => n === `${prefix}mp4`) || candidates[0] || null;
}

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
  // The final filename/extension isn't known until the download resolves (the
  // format fallback can produce a non-mp4 single file), so it's detected from
  // disk on success via findDownloadedFile rather than assumed here.
  const outTemplate = join(PATHS.videos, `${FILENAME_PREFIX}${jobId}.%(ext)s`);

  const job = { id: jobId, status: 'running', clients: [], process: null };
  downloadJobs.set(jobId, job);
  console.log(`📥 Video download ${shortId(jobId)} — ${url}`);

  (async () => {
    let title = '';
    try {
      // On a fresh install data/videos may not exist yet (setup-data.js doesn't
      // create it, and no prior render/import may have). Every other video
      // writer ensures it first; without this the first download points yt-dlp
      // at a missing directory and fails before producing a file.
      await ensureDir(PATHS.videos);
      const args = [
        // Prefer an mp4 (h264/aac) video+audio pair that merges cleanly for
        // broad browser playback; fall back to best single-file mp4, then best.
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        // Best-effort remux a single-file/non-mp4 result into an mp4 container so
        // browser playback is broad; when the codec can't be remuxed losslessly
        // yt-dlp leaves the native container, which findDownloadedFile handles.
        '--remux-video', 'mp4',
        '--no-playlist',
        '--ffmpeg-location', dirname(ffmpeg),
        '--newline',
        '--print', `${TITLE_PREFIX}%(title)s`,
        '--progress-template', `download:${PROGRESS_PREFIX}%(progress._percent_str)s`,
        '--progress-template', `postprocess:${STAGE_PREFIX}merging`,
        // --print implies --simulate AND suppresses normal progress reporting;
        // --no-simulate + --progress restore the real run + machine markers
        // (same yt-dlp quirk documented in trackYoutubeImport).
        '--no-simulate',
        '--progress',
        '--max-filesize', String(VIDEO_DOWNLOAD_MAX_BYTES),
        // Two --match-filters are OR'd by yt-dlp: bound KNOWN-duration videos to
        // the cap, but let a post whose duration can't be resolved pre-download
        // (common on x.com/Twitter) through rather than silently rejecting it —
        // the byte cap above still bounds it. A known video longer than the cap
        // matches neither filter and is skipped.
        '--match-filters', `duration <= ${VIDEO_DOWNLOAD_MAX_DURATION_SEC}`,
        '--match-filters', '!duration',
        '-o', outTemplate,
        url,
      ];
      const proc = spawn(ytDlp, args, { env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      job.process = proc;

      const onLine = (line) => {
        if (line.startsWith(TITLE_PREFIX)) {
          title = line.slice(TITLE_PREFIX.length).trim();
          return;
        }
        if (line.startsWith(PROGRESS_PREFIX)) {
          const percent = parseFloat(line.slice(PROGRESS_PREFIX.length));
          if (Number.isFinite(percent)) broadcastSse(job, { type: 'progress', percent });
          return;
        }
        if (line.startsWith(STAGE_PREFIX)) {
          broadcastSse(job, { type: 'progress', percent: 100, stage: line.slice(STAGE_PREFIX.length) });
        }
      };
      // Separate buffers per stream — a shared buffer can complete a partial
      // line from one stream with a chunk from the other, corrupting a marker.
      const makeLineReader = () => {
        let buf = '';
        return (chunk) => {
          buf += chunk.toString();
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          lines.forEach(onLine);
        };
      };
      proc.stdout.on('data', makeLineReader());
      proc.stderr.on('data', makeLineReader()); // yt-dlp writes some progress/info lines to stderr too

      const exit = await new Promise((resolve) => {
        proc.on('error', (err) => resolve({ code: null, reason: `spawn failed: ${err.message}` }));
        proc.on('close', (code, signal) => resolve({ code, signal }));
      });
      job.process = null;

      if (exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL') {
        console.log(`🛑 Video download ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        await cleanupDownloadFiles(jobId);
        return;
      }
      const produced = await findDownloadedFile(jobId);
      if (exit.code !== 0 || !produced) {
        // A --match-filters/--max-filesize rejection exits 0 with no output
        // file (yt-dlp treats a filtered-out video as "nothing to do") — and
        // --print suppresses the specific reason, so name the known bounds.
        // x.com/Twitter downloads also fail here on login-walled/rate-limited
        // content; surface a clear message rather than a bare exit code.
        const reason = exit.code === 0
          ? `no video was produced — it may be longer than ${VIDEO_DOWNLOAD_MAX_DURATION_SEC / 60} minutes or larger than ${Math.round(VIDEO_DOWNLOAD_MAX_BYTES / 1024 / 1024 / 1024)}GB, or (for x.com) login-walled, rate-limited, or otherwise unavailable`
          : (exit.reason || `yt-dlp exited ${exit.code}`);
        throw new Error(reason);
      }

      const filename = produced;
      const outPath = join(PATHS.videos, filename);
      broadcastSse(job, { type: 'progress', percent: 100, stage: 'finalizing' });
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

      console.log(`📥 Video download ${shortId(jobId)} complete — "${entry.title}" (${filename})`);
      broadcastSse(job, { type: 'complete', id: jobId, video: entry });
    } catch (err) {
      console.error(`❌ Video download ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
      await cleanupDownloadFiles(jobId);
    } finally {
      closeJobAfterDelay(downloadJobs, jobId);
    }
  })();

  return { jobId };
}
