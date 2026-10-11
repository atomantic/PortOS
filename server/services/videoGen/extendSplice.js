/**
 * Video Gen — keep the ORIGINAL source in a native Extend render's output.
 *
 * `ExtendPipeline.extend_from_video` returns `source + extension`, decoded in
 * one pass: the source half has been through the VAE again and its audio
 * through the audio VAE/vocoder. Extending an already-extended clip repeats
 * that over the whole accumulated clip, so picture and sound drift each round.
 * Conditioning is untouched; this changes DELIVERY — the source span comes
 * from the source file, the new span from the render, joined at the seam
 * (layout math: `planExtendSplice` in lib/videoContinuity.js).
 *
 * Best-effort by design: any failure (no ffmpeg, an unprobeable clip, a layout
 * that doesn't match, an encode that doesn't verify) leaves the model's own
 * output in place and reports why. The render is never failed over this.
 */

import { existsSync } from 'fs';
import { unlinkGuarded } from '../../lib/fileUtils.js';
import {
  findFfmpeg, runFfmpegProcess, probeFrameCount, probeVideoStreamInfo,
  hasAudioStream, bt709TagFilter, buildExtendSpliceArgs, installEncodedVideo,
} from '../../lib/ffmpeg.js';
import { planExtendSplice } from '../../lib/videoContinuity.js';

/** Linear crossfade at the source/generated audio seam (~one 25 Hz audio token). */
export const SEAM_CROSSFADE_SEC = 0.04;

/**
 * Replace the source region of `outputPath` with the original `sourcePath`.
 *
 * Resolves `{ applied: true, keptFrames, droppedSourceFrames }` once the
 * spliced file is verified and installed over `outputPath`, or
 * `{ applied: false, reason }` with the render left exactly as the model wrote it.
 */
export async function spliceExtendSource({ sourcePath, outputPath, extendLatents }) {
  const tmpPath = `${outputPath}.splice.mp4`;
  const skip = (reason) => {
    console.warn(`⚠️ Extend source splice skipped, keeping the model output: ${reason}`);
    return { applied: false, reason };
  };
  if (!sourcePath || !existsSync(sourcePath)) return skip('source file missing');
  if (!outputPath || !existsSync(outputPath)) return skip('rendered file missing');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return skip('ffmpeg not found');

  const [sourceFrames, outputFrames, outputInfo] = await Promise.all([
    probeFrameCount(sourcePath), probeFrameCount(outputPath), probeVideoStreamInfo(outputPath),
  ]);
  const plan = planExtendSplice({ sourceFrames, outputFrames, extendLatents });
  if (!plan) return skip(`frame layout does not match (source ${sourceFrames ?? '?'}, output ${outputFrames ?? '?'}, +${extendLatents} latents)`);
  if (!outputInfo.width || !outputInfo.height || !outputInfo.fps) return skip('render geometry unreadable');

  const [sourceHasAudio, outputHasAudio] = await Promise.all([hasAudioStream(sourcePath), hasAudioStream(outputPath)]);
  const audio = !outputHasAudio ? 'none' : sourceHasAudio ? 'splice' : 'generated';
  const args = buildExtendSpliceArgs({
    sourcePath, generatedPath: outputPath, outPath: tmpPath,
    keepFrames: plan.keepFrames, newStartFrame: plan.newStartFrame,
    width: outputInfo.width, height: outputInfo.height, fps: outputInfo.fps,
    audio, crossfadeSec: SEAM_CROSSFADE_SEC, colorTagFilter: await bt709TagFilter(),
  });
  if (!args) return skip('could not build the splice graph');

  const encoded = await runFfmpegProcess({ bin: ffmpeg, args });
  if (!encoded.ok) {
    await unlinkGuarded(tmpPath).catch(() => {});
    return skip(encoded.reason);
  }
  // Verify before replacing anything: the join must be exactly the render's
  // length (kept source frames + new frames), or the seam is off by a frame.
  const splicedFrames = await probeFrameCount(tmpPath);
  if (splicedFrames !== outputFrames) {
    await unlinkGuarded(tmpPath).catch(() => {});
    return skip(`spliced clip has ${splicedFrames ?? '?'} frames, expected ${outputFrames}`);
  }
  const installed = await installEncodedVideo(tmpPath, outputPath, 'extend-spliced');
  if (!installed.ok) return skip(installed.reason);
  console.log(`🧵 Extend kept the original source: ${plan.keepFrames} source + ${plan.newFrames} new frames${audio === 'splice' ? ' (audio crossfaded at the seam)' : ''}`);
  return { applied: true, keptFrames: plan.keepFrames, droppedSourceFrames: plan.droppedSourceFrames };
}
