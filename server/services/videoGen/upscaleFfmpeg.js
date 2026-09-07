/**
 * The two ffmpeg passes that bracket a generative video upscale (#6511).
 *
 * The model renders on a fixed grid, so a source that does not already sit on
 * it has to be padded up before the render and cropped back after it. #6509
 * computes that plan; these apply exactly it and nothing else:
 *
 *   source ─padSourceForUpscale─▶ aligned copy ─(GPU render)─▶ padded output
 *          ─finalizeUpscaleOutput─▶ deliverable (cropped, trimmed, audio muxed)
 *
 * Both write to a NEW path and never touch their input — the source clip is the
 * user's original and the whole contract is that a failed or cancelled upscale
 * leaves it exactly as it was.
 *
 * These live beside the upscale service rather than in `lib/ffmpeg.js` because
 * their arguments are the alignment plan, not a general video operation: the
 * pad geometry, the crop-back geometry and the audio re-mux are one contract
 * that only makes sense together.
 */

import {
  findFfmpeg, runFfmpegProcess, bt709TagFilter,
  H264_ENCODE_ARGS, BT709_CONTAINER_ARGS,
} from '../../lib/ffmpeg.js';

// Right/bottom pad + tail-frame extension, in one filter chain. `tpad`'s
// `stop_mode=clone` repeats the LAST frame rather than inserting black, so the
// padding the model sees is a still hold of the final image instead of a hard
// cut to black that it would try to synthesize detail into.
const alignFilter = ({ width, height, padFrames, fps }) => {
  const chain = [`pad=${width}:${height}:0:0:color=black`];
  if (padFrames > 0) chain.push(`tpad=stop_mode=clone:stop_duration=${(padFrames / fps).toFixed(6)}`);
  return chain;
};

const withColorTag = async (chain) => {
  const tag = await bt709TagFilter();
  return (tag ? [...chain, tag] : chain).join(',');
};

/**
 * Write an aligned copy of `sourcePath` to `outPath`.
 *
 * Video only (`-an`): the source audio is re-muxed onto the FINAL deliverable
 * from the original file, so carrying it through the render input would only
 * risk the padded tail stretching it.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export const padSourceForUpscale = async (sourcePath, outPath, {
  width, height, padFrames = 0, fps, signal,
} = {}) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  if (!(Number(fps) > 0)) return { ok: false, reason: 'source frame rate unknown' };
  return runFfmpegProcess({
    bin: ffmpeg,
    signal,
    args: [
      '-i', sourcePath,
      '-vf', await withColorTag(alignFilter({ width, height, padFrames, fps })),
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-an',
      '-y', outPath,
    ],
  });
};

/**
 * Turn the model's padded output into the deliverable.
 *
 * Crops the alignment padding back off (top-left origin, matching how
 * `padSourceForUpscale` added it), trims the cloned tail frames back to the
 * source's own frame count, and muxes the ORIGINAL clip's audio track back on
 * at offset zero — the adapter is a spatial upscaler, so the timeline it was
 * handed is the timeline that comes back.
 *
 * `-map 1:a:0?` is optional-by-suffix: a source with no audio track yields a
 * silent output rather than an ffmpeg failure, which is the #6511 contract.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export const finalizeUpscaleOutput = async (renderedPath, outPath, {
  width, height, frameCount, audioSourcePath, signal,
} = {}) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  if (!(Number(width) > 0) || !(Number(height) > 0) || !(Number(frameCount) > 0)) {
    return { ok: false, reason: 'upscale output geometry unknown' };
  }
  return runFfmpegProcess({
    bin: ffmpeg,
    signal,
    args: [
      '-i', renderedPath,
      '-i', audioSourcePath,
      '-filter_complex', `[0:v]${await withColorTag([`crop=${width}:${height}:0:0`])}[v]`,
      '-map', '[v]',
      '-map', '1:a:0?',
      ...H264_ENCODE_ARGS,
      ...BT709_CONTAINER_ARGS,
      '-c:a', 'copy',
      '-frames:v', String(Math.round(frameCount)),
      '-shortest',
      '-movflags', '+faststart',
      '-y', outPath,
    ],
  });
};
