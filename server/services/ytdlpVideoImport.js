/**
 * Shared yt-dlp FULL-VIDEO download core, the mirror of ytdlpAudioImport.js.
 *
 * The YouTube brain ingest (#3565) reuses the Dev Tools downloader's (#1946)
 * behavior (format fallback chain, merge/remux flags, `--progress-template`
 * markers, two-`--match-filters` duration bound, finding the produced file since
 * the extension isn't knowable up front) as ONE step in a larger job. Spawn,
 * marker parsing and exit classification live in ytdlpRun.js.
 *
 * SSE-agnostic: takes `onProgress` and `registerProcess` hooks and RETURNS an
 * outcome. The caller owns the job map, SSE, terminal frames, the produced file
 * and URL validation, so the core never sees an unvetted URL.
 */

import { readdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { ensureDir } from '../lib/fileUtils.js';
import { runYtDlp, ytdlpMarkerArgs, describeYtDlpFailure } from './ytdlpRun.js';

/**
 * Locate the final produced file for a download prefix. yt-dlp writes
 * intermediate `<prefix>.f<code>.<ext>` streams and `.part`/`.ytdl`, then merges
 * to `<prefix>.<ext>`. Not hardcoded to `.mp4`: the fallback chain can land a
 * single-file webm/mkv, and assuming `.mp4` would miss a good download and delete
 * it as a failure. Prefers an exact `.mp4`, else the lone non-intermediate file.
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

/** Cleanup globs every file this prefix touched: a cancelled/failed run can leave pre-merge fragments (`<prefix>.f137.mp4`, `.part`). */
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
 * @param {function} opts.onProgress      ({ percent, stage }) => void
 * @param {function} opts.registerProcess (proc|null) => void — lets the caller wire cancel.
 * @returns {Promise<{ outcome:'complete'|'canceled'|'failed', filename?:string, title?:string, reason?:string }>}
 *
 * Never throws for a yt-dlp runtime failure (returns `failed` + `reason`). Cleans
 * partial files on `canceled`/`failed`; on `complete` the caller owns the file.
 */
export async function downloadVideoToDir({
  url, ytDlp, ffmpeg, outDir, filePrefix, maxBytes, maxDurationSec, onProgress, registerProcess,
}) {
  // The destination may not exist on a fresh install (setup-data.js doesn't create
  // data/videos); yt-dlp would fail before producing a file.
  await ensureDir(outDir);

  const args = [
    // Prefer an h264/aac mp4 pair that merges cleanly; then best single-file mp4, then best.
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    // Best-effort remux to mp4 for broad playback; otherwise yt-dlp leaves the
    // native container, which findProducedFile handles.
    '--remux-video', 'mp4',
    '--no-playlist',
    '--ffmpeg-location', dirname(ffmpeg),
    ...ytdlpMarkerArgs('merging'),
    '--max-filesize', String(maxBytes),
    // Two --match-filters are OR'd: bound KNOWN-duration videos to the cap, but let a
    // post whose duration can't be resolved pre-download (common on x.com) through;
    // the byte cap still bounds it.
    '--match-filters', `duration <= ${maxDurationSec}`,
    '--match-filters', '!duration',
    '-o', join(outDir, `${filePrefix}.%(ext)s`),
    url,
  ];

  const exit = await runYtDlp({ ytDlp, args, url, onProgress, registerProcess });

  if (exit.canceled) {
    await cleanupProducedFiles(filePrefix, outDir);
    return { outcome: 'canceled' };
  }

  const filename = await findProducedFile(filePrefix, outDir);
  if (exit.code !== 0 || !filename) {
    // A --match-filters/--max-filesize rejection exits 0 with no output file, and
    // --print hides the reason, so name the known bounds (x.com/Twitter also fails
    // here on login-walled content). describeYtDlpFailure owns the prose; what
    // yt-dlp printed outranks the guess.
    const reason = exit.code === 0
      ? describeYtDlpFailure(exit.code, exit.output, {
        url,
        fallback: `no video was produced — it may be longer than ${Math.round(maxDurationSec / 60)} minutes or larger than ${Math.round(maxBytes / 1024 / 1024 / 1024)}GB, or (for x.com) login-walled, rate-limited, or otherwise unavailable`,
      })
      : exit.reason; // always populated for a non-zero exit (see runYtDlp)
    await cleanupProducedFiles(filePrefix, outDir);
    return { outcome: 'failed', reason };
  }

  return { outcome: 'complete', filename, title: exit.title };
}
