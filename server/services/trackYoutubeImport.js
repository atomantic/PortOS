/**
 * Track YouTube import (#1945) — download + extract just the audio track from
 * a YouTube URL via yt-dlp, land it in the shared music library (data/music/),
 * and create a Track record pointing at it.
 *
 * Mirrors the render.js / loraDatasetCaption.js job pattern: kickoff returns a
 * jobId immediately, the download runs detached, progress streams over the
 * shared SSE helpers, and the client attaches with useSseProgress. The yt-dlp
 * download+extract itself is the shared core in `ytdlpAudioImport.js` (reused
 * by the round reference-audio import #2120); this module owns the YouTube-only
 * URL scope, the music-library landing, and the Track creation.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { shortId, PATHS } from '../lib/fileUtils.js';
import { probeVideoDuration } from '../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { importUploadedTrack, MUSIC_UPLOAD_MAX_BYTES } from './pipeline/musicLibrary.js';
import { createTrack, DURATION_MAX_SEC } from './tracks/index.js';
import { resolveYtDlpBinaries, downloadAudioToTempMp3, cleanupYtDlpTemp } from './ytdlpAudioImport.js';

// youtube.com/watch, youtu.be, and m.youtube.com only (issue #1945 scope:
// "start narrow" — other video hosts are explicitly out of scope). This also
// constrains what a shelled-out yt-dlp will touch, even though args are
// passed as an array (no shell interpolation).
export const YOUTUBE_URL_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/watch\?[^\s#]*\bv=[\w-]{6,}|youtu\.be\/[\w-]{6,})/i;

export function assertYoutubeUrl(url) {
  if (typeof url !== 'string' || !YOUTUBE_URL_RE.test(url)) {
    throw new ServerError(
      'Not a recognized YouTube URL (expected youtube.com/watch, youtu.be, or m.youtube.com)',
      { status: 400, code: 'YOUTUBE_URL_INVALID' },
    );
  }
}

// jobId -> { clients, lastPayload, process }
const importJobs = new Map();

export const attachImportSseClient = (jobId, res) => attachSse(importJobs, jobId, res);

/** Cancel an in-flight import. Returns false if the job is unknown or already finished. */
export function cancelYoutubeImport(jobId) {
  const job = importJobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  killWithEscalation(proc, { label: 'yt-dlp import', stillRunning: () => job.process === proc });
  return true;
}

/**
 * Kick off a YouTube audio import. Returns `{ jobId }` immediately; the
 * download+extract runs detached and streams progress over SSE. Terminal
 * frames: `{ type: 'complete', trackId, track }`, `{ type: 'error', error }`,
 * or `{ type: 'canceled' }`.
 */
export async function startYoutubeImport(url) {
  assertYoutubeUrl(url);
  const { ytDlp, ffmpeg } = await resolveYtDlpBinaries();

  const jobId = randomUUID();
  const tempPrefix = `portos-ytimport-${jobId}`;
  const job = { id: jobId, status: 'running', clients: [], process: null };
  importJobs.set(jobId, job);
  console.log(`📺 YouTube import ${shortId(jobId)} — ${url}`);

  (async () => {
    try {
      const result = await downloadAudioToTempMp3({
        url, ytDlp, ffmpeg, tempPrefix,
        maxBytes: MUSIC_UPLOAD_MAX_BYTES,
        maxDurationSec: DURATION_MAX_SEC,
        onProgress: (p) => broadcastSse(job, { type: 'progress', ...p }),
        registerProcess: (proc) => { job.process = proc; },
      });

      if (result.outcome === 'canceled') {
        console.log(`🛑 YouTube import ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        return;
      }
      if (result.outcome === 'failed') {
        throw new Error(result.reason);
      }

      broadcastSse(job, { type: 'progress', percent: 100, stage: 'importing' });
      const { title, outPath } = result;
      const { filename } = await importUploadedTrack(outPath, `${title || 'YouTube Import'}.mp3`);
      const durationSec = await probeVideoDuration(join(PATHS.music, filename)).catch(() => null);
      const track = await createTrack({ title: title || 'YouTube Import', audioFilename: filename, durationSec });

      console.log(`📺 YouTube import ${shortId(jobId)} complete — track=${shortId(track.id)} "${track.title}"`);
      broadcastSse(job, { type: 'complete', trackId: track.id, track });
    } catch (err) {
      console.error(`❌ YouTube import ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
      // The core cleans temp on canceled/failed; this catch covers a throw from
      // the post-complete landing (importUploadedTrack/createTrack), whose
      // produced outPath the core handed off and no longer owns.
      await cleanupYtDlpTemp(tempPrefix);
    } finally {
      closeJobAfterDelay(importJobs, jobId);
    }
  })();

  return { jobId };
}
