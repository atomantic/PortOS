/**
 * Shared yt-dlp audio-download core.
 *
 * Extracted from the YouTube track import (#1945) so a second consumer — the
 * round reference-audio "Download from URL" convenience (#2120) — can reuse the
 * hard part (yt-dlp arg construction, `--progress-template` machine-readable
 * progress parsing, cancel-aware exit classification, temp-file cleanup) rather
 * than duplicating ~120 lines of subtle yt-dlp knowledge.
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

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { findFfmpeg } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { createLineReader } from '../lib/streamLines.js';

const TITLE_PREFIX = 'PORTOS_TITLE:';
// Custom progress markers via yt-dlp's `--progress-template`, rather than
// scraping the human-readable `[download] NN%` / `[ExtractAudio]` console
// lines — a stable machine interface (mirrors ffmpeg's `-progress pipe:2`
// key=value protocol used by render.js) that a yt-dlp text-format change
// can't silently break.
const PROGRESS_PREFIX = 'PORTOS_PROGRESS:';
const STAGE_PREFIX = 'PORTOS_STAGE:';

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

  let title = '';
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
    // (confirmed against a real download): it implies `--simulate` (skips the
    // actual download/postprocess entirely, so `--no-simulate` is required to
    // force the real run), AND it suppresses ALL of yt-dlp's normal
    // progress/postprocessor reporting — so `--progress` plus the two
    // `--progress-template`s above are required to get stable, machine-readable
    // progress/stage markers back alongside the printed title in one invocation.
    '--no-simulate',
    '--progress',
    // Bound resource use — without these, a long video or a livestream/archive
    // URL downloads and transcodes unbounded, eating disk in tmpdir() and CPU
    // with no cap.
    '--max-filesize', String(maxBytes),
    '--match-filters', `duration <= ${maxDurationSec}`,
    '-o', `${tempBase}.%(ext)s`,
    url,
  ];

  const proc = spawn(ytDlp, args, { env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  registerProcess(proc);

  const onLine = (line) => {
    if (line.startsWith(TITLE_PREFIX)) {
      title = line.slice(TITLE_PREFIX.length).trim();
      return;
    }
    if (line.startsWith(PROGRESS_PREFIX)) {
      const percent = parseFloat(line.slice(PROGRESS_PREFIX.length));
      if (Number.isFinite(percent)) onProgress({ percent });
      return;
    }
    if (line.startsWith(STAGE_PREFIX)) {
      onProgress({ percent: 100, stage: line.slice(STAGE_PREFIX.length) });
    }
  };
  // Separate readers per stream — stdout and stderr chunks arrive
  // independently, so a shared buffer can complete a partial line from one
  // stream with a chunk from the other, corrupting a marker line.
  const stdoutReader = createLineReader(onLine);
  const stderrReader = createLineReader(onLine);
  proc.stdout.on('data', stdoutReader.push);
  proc.stderr.on('data', stderrReader.push); // yt-dlp writes some progress/info lines to stderr too

  const exit = await new Promise((resolve) => {
    proc.on('error', (err) => resolve({ code: null, reason: `spawn failed: ${err.message}` }));
    proc.on('close', (code, signal) => resolve({ code, signal }));
  });
  registerProcess(null);

  if (exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL') {
    // Don't flush on cancel — a SIGKILL'd child leaves only a partial marker
    // line in the carry, and emitting it would fire a stray progress/stage
    // callback right before the caller reports the cancellation.
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'canceled' };
  }
  // Flush any final line the child wrote without a trailing newline before exit.
  stdoutReader.flush();
  stderrReader.flush();
  if (exit.code !== 0 || !existsSync(outPath)) {
    // A --match-filters/--max-filesize rejection exits 0 with no output file
    // (yt-dlp treats a filtered-out video as "nothing to do", not an error) —
    // `--print`'s suppression of normal reporting (see above) means the
    // specific reason never reaches our stdout/stderr parsing, so name the two
    // known bounds explicitly rather than a bare exit code.
    const reason = exit.code === 0
      ? `no audio was produced — the source may be longer than ${Math.round(maxDurationSec / 60)} minutes or its audio larger than ${Math.round(maxBytes / 1024 / 1024)}MB, or it may be otherwise unavailable`
      : (exit.reason || `yt-dlp exited ${exit.code}`);
    await cleanupYtDlpTemp(tempPrefix);
    return { outcome: 'failed', reason };
  }

  return { outcome: 'complete', outPath, title };
}
