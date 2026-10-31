/**
 * Stepped-medium frame hold (#14244) for a finished footage render.
 *
 * The render stays at its frame rate and duration; inside each held span every
 * other source frame plays twice, so frames come in identical pairs. A span
 * the plan leaves unheld (a lip-sync performance shot, the cold open, the
 * outro) is copied through frame for frame. The pass re-encodes the picture
 * and copies the audio untouched, in place, like the film look finish.
 */

import { rename, rm } from 'node:fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS, findFfmpeg, probeVideoGeometry, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { steppedHoldPlan } from '../../lib/musicVideoProductionMedium.js';

/**
 * The `-filter_complex` graph for `parts` (tiling the file, from
 * `steppedHoldPlan`). A held part keeps frames 0, 2, 4… of its span at half
 * rate, doubles them back to `fps`, and is cut to its exact length.
 */
function frameHoldGraph(parts, fps) {
  const chains = parts.map(({ startFrame, endFrame, held }, i) => {
    const length = endFrame - startFrame;
    const cut = `[0:v]trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`;
    const stepped = held
      ? `,select='not(mod(n\\,2))',setpts=N/(${fps}/2*TB),fps=${fps},tpad=stop_mode=clone:stop=2,trim=end_frame=${length},setpts=PTS-STARTPTS`
      : '';
    return `${cut}${stepped}[p${i}]`;
  });
  const joined = parts.map((_, i) => `[p${i}]`).join('');
  return [...chains, `${joined}concat=n=${parts.length}:v=1:a=0[outv]`].join(';');
}

/** The hold options for a project on the stepped medium; null for any other. */
export const projectFrameHold = (project) => (project?.productionMedium === 'stepped'
  ? { performanceSceneIds: (project.scenes || []).filter((scene) => scene.shotMode === 'performance').map((scene) => scene.sceneId) }
  : null);

/**
 * Hold `path`'s stepped spans in place. `sections` are the render's
 * `{ sceneId, startSec, endSec }` spans on song time; `performanceSceneIds`
 * names the shots left unstepped; `leadSec` is the cold open ahead of the song.
 * Resolves `{ held, exemptSceneIds }`, or `{ held: false }` when nothing is held.
 */
export async function applyFrameHold({ path, sections, performanceSceneIds = [], leadSec = 0, signal, ffmpeg: ffmpegBin }) {
  const ffmpeg = ffmpegBin || await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const geometry = await probeVideoGeometry(path);
  if (!geometry) throw new ServerError('The rendered video could not be measured for its frame hold', { status: 500, code: 'FRAME_HOLD_PROBE' });
  const { fps } = geometry;
  const totalFrames = Math.max(1, geometry.numFrames || Math.round(geometry.durationSec * fps));
  const { parts, exemptSceneIds } = steppedHoldPlan(sections, { performanceSceneIds, fps, leadSec, totalFrames });
  if (!parts.some((part) => part.held)) return { held: false, exemptSceneIds };
  const stepped = `${path}.hold.mp4`;
  try {
    const run = await runFfmpegProcess({
      bin: ffmpeg, signal,
      args: ['-hide_banner', '-loglevel', 'error', '-i', path, '-filter_complex', frameHoldGraph(parts, fps),
        '-map', '[outv]', '-map', '0:a?', '-r', String(fps), '-frames:v', String(totalFrames),
        ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-c:a', 'copy', '-movflags', '+faststart', '-y', stepped],
    });
    if (!run.ok) {
      signal?.throwIfAborted();
      throw new ServerError(`Frame hold failed: ${run.reason}`, { status: 500, code: 'FRAME_HOLD_ENCODE' });
    }
    await rename(stepped, path);
    console.log(`🪜 Frame hold: ${parts.filter((part) => part.held).length} stepped spans over ${totalFrames} frames at ${fps} fps${exemptSceneIds.length ? `, ${exemptSceneIds.length} performance shot(s) left unstepped` : ''}`);
    return { held: true, exemptSceneIds };
  } finally {
    await rm(stepped, { force: true }).catch(() => {});
  }
}
