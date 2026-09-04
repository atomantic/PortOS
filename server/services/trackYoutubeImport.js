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
import { assertYoutubeVideoUrl, YOUTUBE_VIDEO_URL_RE } from '../lib/youtubeUrl.js';
import { shortId, PATHS } from '../lib/fileUtils.js';
import { probeVideoDuration } from '../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { importUploadedTrack, MUSIC_UPLOAD_MAX_BYTES } from './pipeline/musicLibrary.js';
import { createTrack, DURATION_MAX_SEC } from './tracks/index.js';
import { resolveYtDlpBinaries, downloadAudioToTempMp3, cleanupYtDlpTemp } from './ytdlpAudioImport.js';

// YouTube-only by design (issue #1945 scope: "start narrow" — other video hosts
// are explicitly out of scope). This also constrains what a shelled-out yt-dlp
// will touch, even though args are passed as an array (no shell interpolation).
// The rule itself is canonical in `lib/youtubeUrl.js` (#6014) — importing it is
// what taught this path to accept music.youtube.com, shorts, live, and embed
// links, which the brain ingest and the Takeout importer already handled.
export {
  YOUTUBE_VIDEO_URL_RE as YOUTUBE_URL_RE,
  assertYoutubeVideoUrl as assertYoutubeUrl,
};

// jobId -> { clients, lastPayload, process, canceled }
const importJobs = new Map();

export const attachImportSseClient = (jobId, res) => attachSse(importJobs, jobId, res);

// The job map is module-private, which left cancelYoutubeImport untestable.
// Exposing it lets a test register a fake job and actually run the cancel —
// same rationale as videoDownload.js's __testing export.
export const __testing = { importJobs };

/**
 * Cancel an in-flight import. Returns false if the job is unknown or already
 * cancelled.
 *
 * `job.process` is transient — it is null while the job is awaiting setup and
 * again during post-processing (runYtDlp clears it on exit) — so cancellation
 * is recorded as a `job.canceled` flag the kickoff re-checks at each phase
 * boundary, and the child is only signalled when one is actually running.
 */
export function cancelYoutubeImport(jobId) {
  const job = importJobs.get(jobId);
  // The job lingers in the map after it ends (closeJobAfterDelay evicts it on
  // a timer), so a terminal status — not just the flag — is what makes a cancel
  // for an already-finished import report false.
  if (!job || job.canceled || job.status !== 'running') return false;
  job.canceled = true;
  const proc = job.process;
  if (proc) killWithEscalation(proc, { label: 'yt-dlp import', stillRunning: () => job.process === proc });
  return true;
}

/**
 * Kick off a YouTube audio import. Returns `{ jobId }` immediately; the
 * download+extract runs detached and streams progress over SSE. Terminal
 * frames: `{ type: 'complete', trackId, track }`, `{ type: 'error', error }`,
 * or `{ type: 'canceled' }`.
 */
export async function startYoutubeImport(url) {
  assertYoutubeVideoUrl(url);
  const { ytDlp, ffmpeg } = await resolveYtDlpBinaries();

  const jobId = randomUUID();
  const tempPrefix = `portos-ytimport-${jobId}`;
  const job = { id: jobId, status: 'running', clients: [], process: null, canceled: false };
  importJobs.set(jobId, job);
  console.log(`📺 YouTube import ${shortId(jobId)} — ${url}`);

  (async () => {
    // Cancel can land in three windows: before the spawn, while yt-dlp runs
    // (the core reports `canceled`), or during post-processing after the child
    // has exited. Only the middle one is the core's to detect — `job.process`
    // is null in the other two, so the flag is what carries them. The guard is
    // re-run at each phase boundary rather than only after the download, so
    // adding an await ahead of the spawn can't silently reopen window one.
    const abortIfCanceled = async (canceled = job.canceled) => {
      if (!canceled) return false;
      console.log(`🛑 YouTube import ${shortId(jobId)} cancelled`);
      broadcastSse(job, { type: 'canceled' });
      await cleanupYtDlpTemp(tempPrefix);
      return true;
    };

    try {
      if (await abortIfCanceled()) return;
      const result = await downloadAudioToTempMp3({
        url, ytDlp, ffmpeg, tempPrefix,
        maxBytes: MUSIC_UPLOAD_MAX_BYTES,
        maxDurationSec: DURATION_MAX_SEC,
        onProgress: (p) => broadcastSse(job, { type: 'progress', ...p }),
        registerProcess: (proc) => { job.process = proc; },
      });

      // The core reports `canceled` only for a kill we issued, so the two
      // signals normally agree — check both so an externally-killed child
      // still ends as a cancel rather than a failure.
      if (await abortIfCanceled(job.canceled || result.outcome === 'canceled')) return;
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
      job.status = 'done';
      closeJobAfterDelay(importJobs, jobId);
    }
  })();

  return { jobId };
}
