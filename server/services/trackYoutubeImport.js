/**
 * Track YouTube import (#1945) — download + extract just the audio track from
 * a YouTube URL via yt-dlp, land it in the shared music library (data/music/),
 * and create a Track record pointing at it.
 *
 * Mirrors the render.js / loraDatasetCaption.js job pattern: kickoff returns a
 * jobId immediately, the download runs detached, progress streams over the
 * shared SSE helpers, and the client attaches with useSseProgress. A single
 * yt-dlp invocation does the whole job (`-x --audio-format mp3`, pointed at
 * our discovered ffmpeg via --ffmpeg-location) rather than a separate
 * download-then-ffmpeg-extract step — yt-dlp already shells out to ffmpeg
 * for the audio conversion internally, so a second pass would just re-decode.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { shortId, PATHS } from '../lib/fileUtils.js';
import { findFfmpeg, probeVideoDuration } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { importUploadedTrack, MUSIC_UPLOAD_MAX_BYTES } from './pipeline/musicLibrary.js';
import { createTrack, DURATION_MAX_SEC } from './tracks/index.js';

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
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (job.process === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ yt-dlp import didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
}

const TITLE_PREFIX = 'PORTOS_TITLE:';
// Custom progress markers via yt-dlp's `--progress-template`, rather than
// scraping the human-readable `[download] NN%` / `[ExtractAudio]` console
// lines — a stable machine interface (mirrors ffmpeg's `-progress pipe:2`
// key=value protocol used by render.js) that a yt-dlp text-format change
// can't silently break.
const PROGRESS_PREFIX = 'PORTOS_PROGRESS:';
const STAGE_PREFIX = 'PORTOS_STAGE:';

// A cancelled/failed run may leave behind yt-dlp's PRE-extraction download
// (native extension — .webm/.m4a/etc., only renamed to our known `.mp3`
// AFTER a successful postprocess step), so cleanup can't just unlink one
// known path — glob every temp file this job's prefix touched.
async function cleanupTempFiles(jobId) {
  const prefix = `portos-ytimport-${jobId}`;
  const dir = tmpdir();
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries.filter((name) => name.startsWith(prefix)).map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

/**
 * Kick off a YouTube audio import. Returns `{ jobId }` immediately; the
 * download+extract runs detached and streams progress over SSE. Terminal
 * frames: `{ type: 'complete', trackId, track }`, `{ type: 'error', error }`,
 * or `{ type: 'canceled' }`.
 */
export async function startYoutubeImport(url) {
  assertYoutubeUrl(url);

  // Independent lookups (each its own existsSync probes + which/where fallback) —
  // run concurrently rather than in series.
  const [ytDlp, ffmpeg] = await Promise.all([findYtDlp(), findFfmpeg()]);
  if (!ytDlp) throw new ServerError('yt-dlp not found on PATH', { status: 500, code: 'YTDLP_MISSING' });
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const jobId = randomUUID();
  // -x --audio-format mp3 forces the final container to mp3 regardless of the
  // source's native audio codec, so the output path is known up front.
  const tempBase = join(tmpdir(), `portos-ytimport-${jobId}`);
  const outPath = `${tempBase}.mp3`;

  const job = { id: jobId, status: 'running', clients: [], process: null };
  importJobs.set(jobId, job);
  console.log(`📺 YouTube import ${shortId(jobId)} — ${url}`);

  (async () => {
    let title = '';
    try {
      const args = [
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--no-playlist',
        '--ffmpeg-location', dirname(ffmpeg),
        '--newline',
        '--print', `${TITLE_PREFIX}%(title)s`,
        '--progress-template', `download:${PROGRESS_PREFIX}%(progress._percent_str)s`,
        '--progress-template', `postprocess:${STAGE_PREFIX}extracting`,
        // `--print` has two side effects that would otherwise break this job
        // (confirmed against a real download): it implies `--simulate` (skips
        // the actual download/postprocess entirely, so `--no-simulate` is
        // required to force the real run), AND it suppresses ALL of yt-dlp's
        // normal progress/postprocessor reporting — so `--progress` plus the
        // two `--progress-template`s above are required to get stable,
        // machine-readable progress/stage markers back alongside the printed
        // title in one invocation.
        '--no-simulate',
        '--progress',
        // Bound resource use to the same limits the manual upload path already
        // enforces (MUSIC_UPLOAD_MAX_BYTES, DURATION_MAX_SEC) — without these,
        // a long video or a livestream/archive URL downloads and transcodes
        // unbounded, eating disk in tmpdir()/data/music and CPU with no cap.
        '--max-filesize', String(MUSIC_UPLOAD_MAX_BYTES),
        '--match-filters', `duration <= ${DURATION_MAX_SEC}`,
        '-o', `${tempBase}.%(ext)s`,
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
      // Separate buffers per stream — stdout and stderr chunks arrive
      // independently, so a shared buffer can complete a partial line from
      // one stream with a chunk from the other, corrupting a marker line.
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
        console.log(`🛑 YouTube import ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
        await cleanupTempFiles(jobId);
        return;
      }
      if (exit.code !== 0 || !existsSync(outPath)) {
        // A --match-filters/--max-filesize rejection exits 0 with no output
        // file (yt-dlp treats a filtered-out video as "nothing to do", not an
        // error) — `--print`'s suppression of normal reporting (see above)
        // means the specific reason never reaches our stdout/stderr parsing,
        // so name the two known bounds explicitly rather than a bare exit code.
        const reason = exit.code === 0
          ? `no audio was produced — the video may be longer than ${DURATION_MAX_SEC / 60} minutes or its audio larger than ${Math.round(MUSIC_UPLOAD_MAX_BYTES / 1024 / 1024)}MB, or it may be otherwise unavailable`
          : (exit.reason || `yt-dlp exited ${exit.code}`);
        throw new Error(reason);
      }

      broadcastSse(job, { type: 'progress', percent: 100, stage: 'importing' });
      const { filename } = await importUploadedTrack(outPath, `${title || 'YouTube Import'}.mp3`);
      const durationSec = await probeVideoDuration(join(PATHS.music, filename)).catch(() => null);
      const track = await createTrack({ title: title || 'YouTube Import', audioFilename: filename, durationSec });

      console.log(`📺 YouTube import ${shortId(jobId)} complete — track=${shortId(track.id)} "${track.title}"`);
      broadcastSse(job, { type: 'complete', trackId: track.id, track });
    } catch (err) {
      console.error(`❌ YouTube import ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
      await cleanupTempFiles(jobId);
    } finally {
      closeJobAfterDelay(importJobs, jobId);
    }
  })();

  return { jobId };
}
