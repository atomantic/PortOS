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
import { writeFile } from 'fs/promises';
import { unlinkGuarded } from '../../lib/fileUtils.js';
import {
  findFfmpeg, runFfmpegProcess, probeFrameCount, probeVideoStreamInfo,
  audioFingerprint, sealAudioMaster, readAudioMasterFingerprint,
  probeVideoCodecSignature, videoFrameHashes,
  hasAudioStream, bt709TagFilter, buildExtendSpliceArgs, buildExtendNewSpanArgs, buildExtendCopyArgs,
  buildExtendConcatList, installEncodedVideo,
} from '../../lib/ffmpeg.js';
import { planExtendSplice } from '../../lib/videoContinuity.js';
import { extendMasterPath } from './extendMaster.js';

/** Linear crossfade at the source/generated audio seam (~one 25 Hz audio token). */
export const SEAM_CROSSFADE_SEC = 0.04;

const partPath = (path) => path.replace(/\.flac$/i, '.part.flac');

/**
 * The lossless master to read the SOURCE span's audio from, or null to use the
 * source clip's own track. A master only counts while it is provably the mix the
 * clip's soundtrack was encoded from: it carries the fingerprint of that decoded
 * soundtrack, so a clip whose audio was later trimmed, replaced or re-muxed in
 * place — even to the same length — no longer matches and is ignored.
 */
async function usableSourceMaster(sourcePath) {
  const masterPath = extendMasterPath(sourcePath);
  if (!masterPath || !existsSync(masterPath)) return null;
  const [sealed, current] = await Promise.all([readAudioMasterFingerprint(masterPath), audioFingerprint(sourcePath)]);
  if (!sealed || sealed !== current) {
    console.warn('⚠️ Extend audio master does not match its clip, using the clip\'s own track');
    return null;
  }
  return masterPath;
}

/**
 * Join the untouched source video to the render's new frames with `-c:v copy`.
 * Only the new span is encoded (a fresh GOP in the shared H.264 profile); the
 * source is never decoded. Returns `{ ok: true }` once `tmpPath` holds a result
 * whose frames are proven to be the source's exact frames followed by the new
 * span's, or `{ ok: false, reason }` for the caller to fall back to a re-encode.
 */
async function copyJoin({ ffmpeg, plan, sourcePath, outputPath, tmpPath, geometry, audio, sourceAudioPath, masterTmp, colorTagFilter }) {
  const spanPath = `${outputPath}.span.mp4`;
  const listPath = `${outputPath}.concat.txt`;
  const cleanup = () => Promise.all([spanPath, listPath].map((path) => unlinkGuarded(path).catch(() => {})));
  try {
    // A source cut mid-GOP can't be copied, and a source that is already longer
    // than the kept span would need a keyframe-aligned cut; both take the re-encode.
    if (plan.droppedSourceFrames !== 0) return { ok: false, reason: 'source span is not the whole source' };
    const [sourceSig, outputSig] = await Promise.all([probeVideoCodecSignature(sourcePath), probeVideoCodecSignature(outputPath)]);
    if (!sourceSig || sourceSig !== outputSig) return { ok: false, reason: 'source and render codec parameters differ' };
    const sourceInfo = await probeVideoStreamInfo(sourcePath);
    if (sourceInfo.width !== geometry.width || sourceInfo.height !== geometry.height
      || Math.abs((sourceInfo.fps || 0) - geometry.fps) > 0.001) {
      return { ok: false, reason: 'source and render canvas or frame rate differ' };
    }

    const spanArgs = buildExtendNewSpanArgs({
      generatedPath: outputPath, outPath: spanPath, newStartFrame: plan.newStartFrame, ...geometry, colorTagFilter,
    });
    if (!spanArgs) return { ok: false, reason: 'could not build the new-span encode' };
    const span = await runFfmpegProcess({ bin: ffmpeg, args: spanArgs });
    if (!span.ok) return { ok: false, reason: span.reason };

    await writeFile(listPath, buildExtendConcatList({
      sourcePath, newSpanPath: spanPath, keepFrames: plan.keepFrames, fps: geometry.fps,
    }));
    const joinArgs = buildExtendCopyArgs({
      listPath, generatedPath: outputPath, outPath: tmpPath, keepFrames: plan.keepFrames, fps: geometry.fps,
      audio, crossfadeSec: SEAM_CROSSFADE_SEC, sourceAudioPath, masterOutPath: masterTmp,
    });
    if (!joinArgs) return { ok: false, reason: 'could not build the stream-copy join' };
    const joined = await runFfmpegProcess({ bin: ffmpeg, args: joinArgs });
    if (!joined.ok) return { ok: false, reason: joined.reason };

    // Stream copy is only as good as the parameter sets the two halves share:
    // prove every frame decodes to exactly what each half decodes to alone.
    const [sourceHashes, spanHashes, joinedHashes] = await Promise.all([
      videoFrameHashes(sourcePath), videoFrameHashes(spanPath), videoFrameHashes(tmpPath),
    ]);
    if (!sourceHashes || !spanHashes || !joinedHashes) return { ok: false, reason: 'stream-copy join did not decode cleanly' };
    const expected = [...sourceHashes, ...spanHashes];
    if (joinedHashes.length !== expected.length || joinedHashes.some((hash, i) => hash !== expected[i])) {
      return { ok: false, reason: 'stream-copy join decodes differently from its parts' };
    }
    return { ok: true };
  } finally {
    await cleanup();
  }
}

/**
 * Replace the source region of `outputPath` with the original `sourcePath`.
 *
 * Video: the source's frames are stream-copied (bit-identical) when it shares
 * codec parameters, canvas and rate with the render and the join verifies;
 * otherwise source + new are encoded once. Audio: the source span is read from
 * the source's lossless master when it has one, the delivered AAC is encoded once
 * from the mix, and (unless `keepMaster` is false) the mix is kept as this
 * output's own master (`<id>.master.flac`) for the next round.
 *
 * Resolves `{ applied: true, keptFrames, droppedSourceFrames, streamCopied }` once
 * the spliced file is verified and installed over `outputPath`, or
 * `{ applied: false, reason }` with the render left exactly as the model wrote it.
 */
export async function spliceExtendSource({ sourcePath, outputPath, extendLatents, keepMaster = true }) {
  const tmpPath = `${outputPath}.splice.mp4`;
  const masterPath = extendMasterPath(outputPath);
  const masterTmp = keepMaster && masterPath ? partPath(masterPath) : null;
  const discardTemps = () => Promise.all([tmpPath, masterTmp].filter(Boolean).map((path) => unlinkGuarded(path).catch(() => {})));
  const skip = async (reason) => {
    await discardTemps();
    console.warn(`⚠️ Extend source splice skipped, keeping the model output: ${reason}`);
    return { applied: false, reason };
  };
  if (!sourcePath || !existsSync(sourcePath)) return skip('source file missing');
  if (!outputPath || !existsSync(outputPath)) return skip('rendered file missing');
  let ffmpeg;
  try {
    ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
  } catch (err) {
    return skip(err.message);
  }
  if (!ffmpeg) return skip('ffmpeg not found');
  // A relaunched render rewrites outputPath, so a master left by an earlier
  // attempt no longer describes it.
  if (masterPath) await unlinkGuarded(masterPath).catch(() => {});

  const [sourceFrames, outputFrames, outputInfo] = await Promise.all([
    probeFrameCount(sourcePath), probeFrameCount(outputPath), probeVideoStreamInfo(outputPath),
  ]);
  const plan = planExtendSplice({ sourceFrames, outputFrames, extendLatents });
  if (!plan) return skip(`frame layout does not match (source ${sourceFrames ?? '?'}, output ${outputFrames ?? '?'}, +${extendLatents} latents)`);
  if (!outputInfo.width || !outputInfo.height || !outputInfo.fps) return skip('render geometry unreadable');
  const geometry = { width: outputInfo.width, height: outputInfo.height, fps: outputInfo.fps };

  const [sourceHasAudio, outputHasAudio] = await Promise.all([hasAudioStream(sourcePath), hasAudioStream(outputPath)]);
  // A render with no track is one the user asked to be silent (`disableAudio`),
  // so the source's soundtrack is dropped with it, matching what Extend delivered before.
  const audio = !outputHasAudio ? 'none' : sourceHasAudio ? 'splice' : 'generated';
  const sourceMaster = audio === 'splice' ? await usableSourceMaster(sourcePath) : null;
  const sourceAudioPath = sourceMaster || sourcePath;
  const colorTagFilter = await bt709TagFilter();
  const wantMaster = audio !== 'none' ? masterTmp : null;

  let streamCopied = false;
  const copy = await copyJoin({
    ffmpeg, plan, sourcePath, outputPath, tmpPath, geometry, audio, sourceAudioPath, masterTmp: wantMaster, colorTagFilter,
  }).catch((err) => ({ ok: false, reason: err.message }));
  if (copy.ok) {
    streamCopied = true;
  } else {
    console.log(`ℹ️ Extend stream-copy not used, re-encoding the source span: ${copy.reason}`);
    await discardTemps();
    const args = buildExtendSpliceArgs({
      sourcePath, generatedPath: outputPath, outPath: tmpPath,
      keepFrames: plan.keepFrames, newStartFrame: plan.newStartFrame, ...geometry,
      audio, crossfadeSec: SEAM_CROSSFADE_SEC, colorTagFilter,
      sourceAudioPath: sourceMaster, masterOutPath: wantMaster,
    });
    if (!args) return skip('could not build the splice graph');
    const encoded = await runFfmpegProcess({ bin: ffmpeg, args });
    if (!encoded.ok) return skip(encoded.reason);
  }

  // Verify before replacing anything: the join must be exactly the render's
  // length (kept source frames + new frames), or the seam is off by a frame.
  const splicedFrames = await probeFrameCount(tmpPath);
  if (splicedFrames !== outputFrames) return skip(`spliced clip has ${splicedFrames ?? '?'} frames, expected ${outputFrames}`);
  const installed = await installEncodedVideo(tmpPath, outputPath, 'extend-spliced');
  if (!installed.ok) return skip(installed.reason);
  // The master is an optimization: without one the clip stays its own (AAC)
  // source of audio for the next round, exactly as before masters existed.
  if (wantMaster) {
    const fingerprint = await audioFingerprint(outputPath);
    const sealed = fingerprint ? await sealAudioMaster({ inPath: wantMaster, outPath: masterPath, fingerprint }) : { ok: false, reason: 'clip audio unreadable' };
    if (!sealed.ok) {
      console.warn(`⚠️ Extend audio master not kept: ${sealed.reason}`);
      await unlinkGuarded(masterPath).catch(() => {});
    }
    await unlinkGuarded(wantMaster).catch(() => {});
  }
  console.log(`🧵 Extend kept the original source${streamCopied ? ' (stream-copied)' : ''}: ${plan.keepFrames} source + ${plan.newFrames} new frames${audio === 'splice' ? ` (audio crossfaded at the seam${sourceMaster ? ', from the lossless master' : ''})` : ''}`);
  return { applied: true, keptFrames: plan.keepFrames, droppedSourceFrames: plan.droppedSourceFrames, streamCopied };
}
