/**
 * Hard-cut detection in a video file, by ffmpeg's scene-change score. Used to
 * hand a code model a reference clip's cut rhythm (codeAnimation/referenceVideo.js)
 * and to place a multi-shot Music Video take on its shots (#16128).
 */
import { FFMPEG_SCAN_TIMEOUT_MS, findFfmpeg, runFfmpegProcess } from './ffmpeg.js';

/** ffmpeg scene score above which a frame change counts as a cut. */
export const SCENE_CUT_THRESHOLD = 0.3;
const MAX_CUTS = 120;
// Two stamps closer than this are one cut (a flash or a two-frame transition).
const MIN_CUT_GAP_SEC = 0.2;

/** Test-only export. Parse `pts_time:` stamps from ffmpeg's showinfo log into rounded, ascending seconds. */
export function _parseSceneCutTimes(stderr, { maxCuts = MAX_CUTS } = {}) {
  const times = [];
  for (const match of String(stderr || '').matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Math.round(Number(match[1]) * 100) / 100;
    if (Number.isFinite(t) && t > 0 && (!times.length || t - times.at(-1) >= MIN_CUT_GAP_SEC)) times.push(t);
  }
  return times.slice(0, maxCuts);
}

/**
 * Cut times in seconds, or null when ffmpeg is missing or the pass fails, so a
 * failed pass never reads as "no cuts". `bin` skips the ffmpeg lookup.
 */
export async function detectVideoSceneCuts(videoPath, { threshold = SCENE_CUT_THRESHOLD, bin = null } = {}) {
  const ffmpeg = bin || await findFfmpeg();
  if (!ffmpeg || typeof videoPath !== 'string' || !videoPath) return null;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    // -nostats keeps progress lines out of the stderr tail the stamps are read from.
    args: ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', videoPath, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
    returnStderr: true,
    stderrTailBytes: 400000,
    timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
  });
  return result.ok ? _parseSceneCutTimes(result.stderr) : null;
}
