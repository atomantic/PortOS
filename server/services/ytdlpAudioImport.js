/**
 * Shared yt-dlp audio-download core.
 *
 * Extracted from the YouTube track import (#1945) so a second consumer — the
 * round reference-audio "Download from URL" convenience (#2120) — can reuse the
 * hard part (yt-dlp arg construction, `--progress-template` machine-readable
 * progress parsing, cancel-aware exit classification, temp-file cleanup) rather
 * than duplicating ~120 lines of subtle yt-dlp knowledge. The spawn, marker
 * parsing and exit classification it shares with the video core live in
 * ytdlpRun.js; this module owns the audio argv and the temp-file lifecycle.
 *
 * A single yt-dlp invocation does the whole job (`-x --audio-format mp3`,
 * pointed at our discovered ffmpeg via --ffmpeg-location) — yt-dlp already
 * shells out to ffmpeg for the audio conversion internally, so a second pass
 * would just re-decode.
 *
 * The core is deliberately SSE-agnostic: it takes an `onProgress` callback and
 * a `registerProcess` hook, and RETURNS an outcome. The caller owns the job
 * map, SSE broadcasting, terminal frames, and post-processing (where the
 * produced file lands). URL validation is the caller's job too — the track
 * import allows only YouTube URLs, the reference import allows any public
 * http(s) URL (SSRF-guarded) — so the core never sees an unvetted URL.
 */

import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { findFfmpeg } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { runYtDlp, ytdlpMarkerArgs } from './ytdlpRun.js';

/**
 * Locate yt-dlp + ffmpeg, throwing an actionable ServerError if either is
 * missing. Call this at kickoff (before returning a jobId) so a missing binary
 * surfaces as a real HTTP error instead of an SSE frame nobody's attached to
 * yet. Independent lookups run concurrently.
 */
export async function resolveYtDlpBinaries() {
  const [ytDlp, ffmpeg] = await Promise.all([findYtDlp(), findFfmpeg()]);
  if (!ytDlp) throw new ServerError('yt-dlp not found on PATH', { status: 500, code: 'YTDLP_MISSING' });
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  return { ytDlp, ffmpeg };
}

/**
 * A cancelled/failed run may leave behind yt-dlp's PRE-extraction download
 * (native extension — .webm/.m4a/etc., only renamed to our known `.mp3`
 * AFTER a successful postprocess step), so cleanup can't just unlink one
 * known path — glob every temp file this job's prefix touched.
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
 * @param {function} opts.onProgress     ({ percent, stage }) => void — SSE-agnostic.
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ outcome:'complete'|'canceled'|'failed', outPath?:string, title?:string, reason?:string }>}
 *
 * Never throws for a yt-dlp runtime failure (returns `failed` + `reason`); the
 * caller decides how to surface it. Cleans temp files on `canceled`/`failed`;
 * on `complete` the caller owns `outPath` (moves it, then it's gone).
 */
export async function downloadAudioToTempMp3({
  url, ytDlp, ffmpeg, tempPrefix, maxBytes, maxDurationSec, onProgress, registerProcess,
}) {
  // -x --audio-format mp3 forces the final container to mp3 regardless of the
  // source's native audio codec, so the output path is known up front.
  const tempBase = join(tmpdir(), tempPrefix);
  const outPath = `${tempBase}.mp3`;

  const args = [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist',
    '--ffmpeg-location', dirname(ffmpeg),
    ...ytdlpMarkerArgs('extracting'),
    // Bound resource use — without these, a long video or a livestream/archive
    // URL downloads and transcodes unbounded, eating disk in tmpdir() and CPU
    // with no cap.
    '--max-filesize', String(maxBytes),
    '--match-filters', `duration <= ${maxDurationSec}`,
    '-o', `${tempBase}.%(ext)s`,
    url,
  ];

  const exit = await runYtDlp({ ytDlp, args, onProgress, registerProcess });

  if (exit.canceled) {
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'canceled' };
  }
  if (exit.code !== 0 || !existsSync(outPath)) {
    // A --match-filters/--max-filesize rejection exits 0 with no output file
    // (yt-dlp treats a filtered-out video as "nothing to do", not an error) —
    // `--print`'s suppression of normal reporting (see ytdlpRun) means the
    // specific reason never reaches our stdout/stderr parsing, so name the two
    // known bounds explicitly rather than a bare exit code.
    const reason = exit.code === 0
      ? `no audio was produced — the source may be longer than ${Math.round(maxDurationSec / 60)} minutes or its audio larger than ${Math.round(maxBytes / 1024 / 1024)}MB, or it may be otherwise unavailable`
      : (exit.reason || `yt-dlp exited ${exit.code}`);
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'failed', reason };
  }

  return { outcome: 'complete', outPath, title: exit.title };
}
