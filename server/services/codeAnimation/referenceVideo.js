/**
 * Turn a Media History video into what a coding model can actually study: a
 * phone-sized contact sheet of the whole clip, two full-size keyframes, and the
 * measured shot-cut times. A code model cannot watch a video, so the cut rhythm
 * is handed over as numbers and the look as stills. Derived files are cached by
 * the source file's identity, so re-previewing a prompt never re-runs ffmpeg.
 */
import { createHash } from 'crypto';
import { readFile, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir } from '../../lib/fileCore.js';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/paths.js';
import { makePathResolver } from '../../lib/pathSafety.js';
import { trimTo } from '../../lib/textUtils.js';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'];
const resolveGalleryVideo = makePathResolver(() => PATHS.videos, { extensions: VIDEO_EXTENSIONS });

// ffmpeg scene score above which a frame change counts as a cut.
const CUT_THRESHOLD = 0.3;
const MAX_CUTS = 120;

const thumbUrl = (name) => `/data/video-thumbnails/${encodeURIComponent(name)}`;

/** Parse `pts_time:` stamps from ffmpeg's showinfo log into rounded seconds. */
function parseCutTimes(stderr) {
  const times = [];
  for (const match of String(stderr || '').matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Math.round(Number(match[1]) * 100) / 100;
    if (Number.isFinite(t) && t > 0 && (!times.length || t - times.at(-1) >= 0.2)) times.push(t);
  }
  return times.slice(0, MAX_CUTS);
}

async function detectCuts(ffmpeg, videoPath) {
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    // -nostats keeps progress lines out of the stderr tail the stamps are read from.
    args: ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', videoPath, '-an', '-vf', `scale=320:-2,select='gt(scene,${CUT_THRESHOLD})',showinfo`, '-f', 'null', '-'],
    returnStderr: true,
    stderrTailBytes: 400000,
  });
  // null, not [], so a failed pass never reads as "no cuts".
  return result.ok ? parseCutTimes(result.stderr) : null;
}

async function extractKeyframe(ffmpeg, videoPath, atSec, outputPath) {
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-hide_banner', '-loglevel', 'error', '-ss', atSec.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', '-y', outputPath],
  });
  if (!result.ok) throw new Error(`Reference keyframe failed: ${result.reason}`);
}

/**
 * Resolve and sample a brief's reference video.
 * @returns {Promise<{label, note, durationSec, cuts, images: Array<{label, origin, note, path, url}>}>}
 */
export async function resolveReferenceVideo(ref) {
  const path = resolveGalleryVideo(ref.filename);
  if (!path) throw new ServerError(`Reference video not found: ${ref.filename}`, { status: 400, code: 'REFERENCE_NOT_FOUND' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is required to study a reference video', { status: 503, code: 'FFMPEG_UNAVAILABLE' });
  const info = await stat(path);
  const key = createHash('sha256').update(`${path}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 16);
  const names = { sheet: `refvideo-${key}-sheet.png`, early: `refvideo-${key}-k1.jpg`, late: `refvideo-${key}-k2.jpg`, meta: `refvideo-${key}.json` };
  const at = (name) => join(PATHS.videoThumbnails, name);
  await ensureDir(PATHS.videoThumbnails);
  let meta = await readFile(at(names.meta), 'utf8').then(JSON.parse).catch(() => null);
  if (!meta) {
    const durationSec = await probeVideoDuration(path);
    if (!durationSec) throw new ServerError('Could not read the reference video', { status: 400, code: 'REFERENCE_UNREADABLE' });
    const { encodeReferenceContactSheet } = await import('../htmlComposition/encode.js');
    // ~48 tiles across the whole clip, never finer than every half second.
    const { times } = await encodeReferenceContactSheet(path, at(names.sheet), { everySec: Math.max(0.5, durationSec / 48) });
    await extractKeyframe(ffmpeg, path, durationSec * 0.3, at(names.early));
    await extractKeyframe(ffmpeg, path, durationSec * 0.7, at(names.late));
    meta = { durationSec, cuts: await detectCuts(ffmpeg, path), sheetEverySec: times.length > 1 ? times[1] - times[0] : durationSec };
    // An unmeasured rhythm is not cached, so the next request measures again.
    if (meta.cuts) await writeFile(at(names.meta), JSON.stringify(meta));
  }
  const label = trimTo(ref.label, 120) || ref.filename;
  const image = (name, what) => ({ label: `${label} — ${what}`, origin: 'reference-video', note: '', path: at(name), url: thumbUrl(name) });
  return {
    label,
    note: ref.note || '',
    durationSec: meta.durationSec,
    cuts: meta.cuts,
    images: [
      image(names.sheet, `contact sheet, one tile every ${meta.sheetEverySec.toFixed(1)}s, read left to right`),
      image(names.early, `frame at ${(meta.durationSec * 0.3).toFixed(1)}s`),
      image(names.late, `frame at ${(meta.durationSec * 0.7).toFixed(1)}s`),
    ],
  };
}
