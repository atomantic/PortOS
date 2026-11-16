/**
 * Shared yt-dlp audio-download core (#1945, reused by reference-audio #2120).
 *
 * One yt-dlp invocation does the whole job (`-x --audio-format mp3`, pointed at
 * our ffmpeg via --ffmpeg-location; yt-dlp shells out to ffmpeg itself). Spawn,
 * marker parsing and exit classification shared with the video core live in
 * ytdlpRun.js; this module owns the audio argv and the temp-file lifecycle.
 *
 * SSE-agnostic: takes `onProgress` and `registerProcess` hooks and RETURNS an
 * outcome. The caller owns the job map, SSE, terminal frames, post-processing
 * and URL validation (track import: YouTube only; reference import: any
 * SSRF-guarded public http(s) URL), so the core never sees an unvetted URL.
 */

import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { findFfmpeg } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { runYtDlp, ytdlpMarkerArgs, describeYtDlpFailure } from './ytdlpRun.js';

/**
 * Locate yt-dlp + ffmpeg, throwing an actionable ServerError if either is
 * missing. Call at kickoff (before returning a jobId) so a missing binary is a
 * real HTTP error, not an SSE frame nobody's attached to yet.
 */
export async function resolveYtDlpBinaries() {
  const [ytDlp, ffmpeg] = await Promise.all([findYtDlp(), findFfmpeg()]);
  if (!ytDlp) throw new ServerError('yt-dlp not found on PATH', { status: 500, code: 'YTDLP_MISSING' });
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  return { ytDlp, ffmpeg };
}

/**
 * A cancelled/failed run may leave yt-dlp's PRE-extraction download (native
 * extension, renamed to `.mp3` only after a successful postprocess), so glob every
 * temp file this job's prefix touched instead of unlinking one known path.
 */
export async function cleanupYtDlpTemp(tempPrefix) {
  const dir = tmpdir();
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries.filter((name) => name.startsWith(tempPrefix)).map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

/**
 * Download + extract audio to a temp mp3 via one yt-dlp invocation.
 *
 * @param {object}   opts
 * @param {string}   opts.url            Already-validated source URL.
 * @param {string}   opts.ytDlp          yt-dlp binary path (from resolveYtDlpBinaries).
 * @param {string}   opts.ffmpeg         ffmpeg binary path (from resolveYtDlpBinaries).
 * @param {string}   opts.tempPrefix     Unique per-job temp filename prefix (no dir).
 * @param {number}   opts.maxBytes       `--max-filesize` cap.
 * @param {number}   opts.maxDurationSec `--match-filters duration<=` cap.
 * @param {function} opts.onProgress     ({ percent, stage }) => void
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ outcome:'complete'|'canceled'|'failed', outPath?:string, title?:string, reason?:string }>}
 *
 * Never throws for a yt-dlp runtime failure (returns `failed` + `reason`). Cleans
 * temp files on `canceled`/`failed`; on `complete` the caller owns `outPath`.
 */
export async function downloadAudioToTempMp3({
  url, ytDlp, ffmpeg, tempPrefix, maxBytes, maxDurationSec, onProgress, registerProcess,
}) {
  // -x --audio-format mp3 forces the container, so the output path is known up front.
  const tempBase = join(tmpdir(), tempPrefix);
  const outPath = `${tempBase}.mp3`;

  const args = [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist',
    '--ffmpeg-location', dirname(ffmpeg),
    ...ytdlpMarkerArgs('extracting'),
    // Bound resource use: a long video or livestream would otherwise download and transcode unbounded.
    '--max-filesize', String(maxBytes),
    '--match-filters', `duration <= ${maxDurationSec}`,
    '-o', `${tempBase}.%(ext)s`,
    url,
  ];

  const exit = await runYtDlp({ ytDlp, args, url, onProgress, registerProcess });

  if (exit.canceled) {
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'canceled' };
  }
  if (exit.code !== 0 || !existsSync(outPath)) {
    // A --match-filters/--max-filesize rejection exits 0 with no output file, and
    // `--print` (see ytdlpRun) hides the reason, so name the two known bounds.
    // describeYtDlpFailure owns the prose; what yt-dlp printed outranks the guess.
    const reason = exit.code === 0
      ? describeYtDlpFailure(exit.code, exit.output, {
        url,
        fallback: `no audio was produced — the source may be longer than ${Math.round(maxDurationSec / 60)} minutes or its audio larger than ${Math.round(maxBytes / 1024 / 1024)}MB, or it may be otherwise unavailable`,
      })
      : exit.reason; // always populated for a non-zero exit (see runYtDlp)
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'failed', reason };
  }

  return { outcome: 'complete', outPath, title: exit.title };
}
