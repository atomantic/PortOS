/**
 * Shared yt-dlp FULL-VIDEO download core.
 *
 * The mirror image of ytdlpAudioImport.js, extracted for the same reason: the
 * YouTube brain ingest (#3565) wants the exact video-download behavior the Dev
 * Tools downloader (#1946) already had — the format fallback chain, the merge/
 * remux flags, the `--progress-template` machine-readable markers, the
 * two-`--match-filters` duration bound, and the "find the produced file, because
 * the extension isn't knowable up front" logic — but as ONE step inside a larger
 * job rather than as its own SSE-owning service.
 *
 * Like the audio core, this is deliberately SSE-agnostic: it takes `onProgress`
 * and `registerProcess` callbacks and RETURNS an outcome. The caller owns the
 * job map, SSE broadcasting, terminal frames, and what happens to the produced
 * file. URL validation is the caller's job too, so the core never sees an
 * unvetted URL.
 */

import { spawn } from '../lib/childProcess.js';
import { readdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { ensureDir } from '../lib/fileUtils.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { createLineReader } from '../lib/streamLines.js';

const TITLE_PREFIX = 'PORTOS_TITLE:';
// Machine-readable progress markers via yt-dlp's --progress-template rather than
// scraping human-readable console lines — same rationale as ytdlpAudioImport.
const PROGRESS_PREFIX = 'PORTOS_PROGRESS:';
const STAGE_PREFIX = 'PORTOS_STAGE:';

/**
 * Locate the final produced file for a download prefix. yt-dlp writes
 * intermediate streams as `<prefix>.f<code>.<ext>` and a `.part`/`.ytdl` in
 * progress, then merges/remuxes to a single `<prefix>.<ext>` and deletes the
 * rest. We do NOT hardcode `.mp4`: the format fallback chain can land a
 * single-file webm/mkv (VP9/AV1) that `--merge-output-format`/`--remux-video
 * mp4` only converts on a best-effort basis, so assuming `.mp4` would miss a
 * perfectly-good download and then delete it as a "failure". Prefer an exact
 * `.mp4`, else the lone remaining non-intermediate file.
 *
 * @returns {Promise<string|null>} basename, or null when nothing was produced.
 */
export async function findProducedFile(filePrefix, dir) {
  const prefix = `${filePrefix}.`;
  const entries = await readdir(dir).catch(() => []);
  const candidates = entries.filter((n) =>
    n.startsWith(prefix)
    && !n.endsWith('.part')
    && !n.endsWith('.ytdl')
    && !/\.f\d+\.[^.]+$/.test(n), // format-fragment intermediates (.f137.mp4)
  );
  return candidates.find((n) => n === `${prefix}mp4`) || candidates[0] || null;
}

/**
 * A cancelled/failed run can leave yt-dlp's pre-merge fragment files behind
 * (`<prefix>.f137.mp4`, `.part`, etc.), so cleanup globs every file this
 * prefix touched rather than unlinking one assumed path.
 */
export async function cleanupProducedFiles(filePrefix, dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries.filter((name) => name.startsWith(filePrefix)).map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

/**
 * Download a full video (best mp4 video+audio, merged) into `outDir`.
 *
 * @param {object}   opts
 * @param {string}   opts.url             Already-validated source URL.
 * @param {string}   opts.ytDlp           yt-dlp binary path.
 * @param {string}   opts.ffmpeg          ffmpeg binary path (for merge/remux).
 * @param {string}   opts.outDir          Destination directory (created if missing).
 * @param {string}   opts.filePrefix      Unique per-job basename prefix (no extension).
 * @param {number}   opts.maxBytes        `--max-filesize` cap.
 * @param {number}   opts.maxDurationSec  `--match-filters duration<=` cap.
 * @param {function} opts.onProgress      ({ percent, stage }) => void — SSE-agnostic.
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ outcome:'complete'|'canceled'|'failed', filename?:string, title?:string, reason?:string }>}
 *
 * Never throws for a yt-dlp runtime failure (returns `failed` + `reason`); the
 * caller decides how to surface it. Cleans partial files on `canceled`/`failed`;
 * on `complete` the caller owns the produced file.
 */
export async function downloadVideoToDir({
  url, ytDlp, ffmpeg, outDir, filePrefix, maxBytes, maxDurationSec, onProgress, registerProcess,
}) {
  // On a fresh install the destination may not exist yet (setup-data.js doesn't
  // create data/videos, and no prior render/import may have); without this
  // yt-dlp points at a missing directory and fails before producing a file.
  await ensureDir(outDir);

  let title = '';
  const args = [
    // Prefer an mp4 (h264/aac) video+audio pair that merges cleanly for broad
    // browser playback; fall back to best single-file mp4, then best.
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    // Best-effort remux a single-file/non-mp4 result into an mp4 container so
    // browser playback is broad; when the codec can't be remuxed losslessly
    // yt-dlp leaves the native container, which findProducedFile handles.
    '--remux-video', 'mp4',
    '--no-playlist',
    '--ffmpeg-location', dirname(ffmpeg),
    '--newline',
    '--print', `${TITLE_PREFIX}%(title)s`,
    '--progress-template', `download:${PROGRESS_PREFIX}%(progress._percent_str)s`,
    '--progress-template', `postprocess:${STAGE_PREFIX}merging`,
    // --print implies --simulate AND suppresses normal progress reporting;
    // --no-simulate + --progress restore the real run + machine markers
    // (the yt-dlp quirk documented at length in ytdlpAudioImport).
    '--no-simulate',
    '--progress',
    '--max-filesize', String(maxBytes),
    // Two --match-filters are OR'd by yt-dlp: bound KNOWN-duration videos to the
    // cap, but let a post whose duration can't be resolved pre-download (common
    // on x.com/Twitter) through rather than silently rejecting it — the byte cap
    // above still bounds it. A known video longer than the cap matches neither
    // filter and is skipped.
    '--match-filters', `duration <= ${maxDurationSec}`,
    '--match-filters', '!duration',
    '-o', join(outDir, `${filePrefix}.%(ext)s`),
    url,
  ];

  const proc = spawn(ytDlp, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
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
  // Separate readers per stream — stdout and stderr chunks arrive independently,
  // so a shared buffer can complete a partial line from one stream with a chunk
  // from the other, corrupting a marker line.
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
    await cleanupProducedFiles(filePrefix, outDir);
    return { outcome: 'canceled' };
  }
  // Flush any final line the child wrote without a trailing newline before exit.
  stdoutReader.flush();
  stderrReader.flush();

  const filename = await findProducedFile(filePrefix, outDir);
  if (exit.code !== 0 || !filename) {
    // A --match-filters/--max-filesize rejection exits 0 with no output file
    // (yt-dlp treats a filtered-out video as "nothing to do") — and --print
    // suppresses the specific reason, so name the known bounds. x.com/Twitter
    // downloads also fail here on login-walled/rate-limited content.
    const reason = exit.code === 0
      ? `no video was produced — it may be longer than ${Math.round(maxDurationSec / 60)} minutes or larger than ${Math.round(maxBytes / 1024 / 1024 / 1024)}GB, or (for x.com) login-walled, rate-limited, or otherwise unavailable`
      : (exit.reason || `yt-dlp exited ${exit.code}`);
    await cleanupProducedFiles(filePrefix, outDir);
    return { outcome: 'failed', reason };
  }

  return { outcome: 'complete', filename, title };
}
