/**
 * Round reference-audio import (#2120) — the deferred convenience path from the
 * reference-audio analysis feature (#2106). Download + extract the audio from a
 * reference URL (a layered TikTok performance, a YouTube clip, …) via yt-dlp and
 * land it in the uploads dir, so it can be attached to a round reference and
 * analyzed exactly like an uploaded file or a mic capture.
 *
 * Reuses the shared yt-dlp download core (`ytdlpAudioImport.js`) — same job/SSE
 * shape as the YouTube track import (#1945). The two differences from that path:
 *   1. URL scope — ANY public http(s) URL (SSRF-guarded), not YouTube-only. yt-dlp
 *      decides what it can actually extract; a scrape failure degrades to a clear
 *      error (upload/mic capture remain the primary attach paths).
 *   2. Output — lands in PATHS.uploads and returns a `filename` for the
 *      reference's `audioFilename`, rather than the music library + a Track.
 */

import { randomUUID } from 'crypto';
import { shortId, importFileToUploads } from '../lib/fileUtils.js';
import { assertPublicHttpUrl } from '../lib/safeUrlFetch.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { resolveYtDlpBinaries, downloadAudioToTempMp3, cleanupYtDlpTemp } from './ytdlpAudioImport.js';

// Reference performances are short clips — bound resource use so a mistyped
// link to a long archive/livestream can't download + transcode unbounded.
export const REFERENCE_AUDIO_MAX_BYTES = 60 * 1024 * 1024; // 60MB
export const REFERENCE_AUDIO_MAX_DURATION_SEC = 20 * 60; // 20 minutes

// jobId -> { clients, lastPayload, process }
const importJobs = new Map();

export const attachReferenceAudioSseClient = (jobId, res) => attachSse(importJobs, jobId, res);

/** Cancel an in-flight import. Returns false if the job is unknown or already finished. */
export function cancelReferenceAudioImport(jobId) {
  const job = importJobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  killWithEscalation(proc, { label: 'yt-dlp reference audio', stillRunning: () => job.process === proc });
  return true;
}

/**
 * Kick off a reference-audio download. Returns `{ jobId }` immediately; the
 * download+extract runs detached and streams progress over SSE. Terminal
 * frames: `{ type: 'complete', filename }`, `{ type: 'error', error }`, or
 * `{ type: 'canceled' }`. Throws (before returning a jobId) on an unsafe URL or
 * a missing yt-dlp/ffmpeg binary, so those surface as real HTTP errors.
 */
export async function startReferenceAudioImport(url) {
  // SSRF guard: http(s) only, reject loopback/link-local/metadata AND private
  // LAN hosts (blockPrivate) — yt-dlp fetches the URL itself, so it never
  // reaches our SSRF-guarded fetcher; validate before handing it the URL.
  await assertPublicHttpUrl(url, { blockPrivate: true });
  const { ytDlp, ffmpeg } = await resolveYtDlpBinaries();

  const jobId = randomUUID();
  const tempPrefix = `portos-refaudio-${jobId}`;
  const job = { id: jobId, status: 'running', clients: [], process: null };
  importJobs.set(jobId, job);
  console.log(`🎧 Reference-audio import ${shortId(jobId)} — ${url}`);

  (async () => {
    try {
      const result = await downloadAudioToTempMp3({
        url, ytDlp, ffmpeg, tempPrefix,
        maxBytes: REFERENCE_AUDIO_MAX_BYTES,
        maxDurationSec: REFERENCE_AUDIO_MAX_DURATION_SEC,
        onProgress: (p) => broadcastSse(job, { type: 'progress', ...p }),
        registerProcess: (proc) => { job.process = proc; },
      });

      if (result.outcome === 'canceled') {
        console.log(`🛑 Reference-audio import ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        return;
      }
      if (result.outcome === 'failed') {
        throw new Error(result.reason);
      }

      broadcastSse(job, { type: 'progress', percent: 100, stage: 'importing' });
      const { title, outPath } = result;
      const { filename } = await importFileToUploads(outPath, `${title || 'Reference Audio'}.mp3`);

      console.log(`🎧 Reference-audio import ${shortId(jobId)} complete — ${filename}`);
      broadcastSse(job, { type: 'complete', filename, title: title || null });
    } catch (err) {
      console.error(`❌ Reference-audio import ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
      // The core cleans temp on canceled/failed; this catch covers a throw from
      // the post-complete landing (importFileToUploads), whose produced outPath
      // the core handed off and no longer owns.
      await cleanupYtDlpTemp(tempPrefix);
    } finally {
      closeJobAfterDelay(importJobs, jobId);
    }
  })();

  return { jobId };
}
