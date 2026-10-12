import { execFile } from '../../lib/childProcess.js';
import { promisify } from 'util';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { isIcLoraMode, icLoraSpecForMode } from '../../lib/icLoraWeights.js';
import { modelAnchorsLastFrame, routesToWindowsHelper } from './runtimes.js';
import { IC_STILL_REFERENCE_FRAMES } from './renderArgs.js';

const execFileAsync = promisify(execFile);

// LTX-2.x was trained on video frames, so Lightricks' pipelines re-compress a
// conditioning still through H.264 before encoding it (CRF 33 for LTX-2.0 to
// 2.3, `DEFAULT_IMAGE_CRF` in ltx_pipelines). A pristine still is out of
// distribution: the model holds it for the first frame and then cuts away to
// a different scene. The dgrauet/MrMofer runtimes do this round trip in their
// own loader; the notapalindrome `mlx_video.generate_av` CLI does not, so
// PortOS does it here for that runtime.
const CONDITIONING_CRF_BY_RUNTIME = Object.freeze({ mlx_video: 33 });

/** Resolve local conditioning media and return its existing cleanup capability.
 * Derived files are always owned here; upload/audio cleanup stays caller-selected.
 */
export async function prepareVideoConditioningMedia({
  model, mode, sourceImagePath, lastImagePath, keyframes, icReferencePaths,
  w, h, parsedFps, jobId, uploadedTempPath, uploadedTempPaths, audioFilePath,
}) {
  // Resize conditioning images to match the model resolution. mlx_video and
  // ltx2 both require exact dimensions (they don't auto-pad), and pixie-forge
  // learned the hard way that letting the model upscale a portrait reference
  // makes garbled output.
  //
  // Skip the last-image resize when buildArgs / the Python child won't
  // actually consume it:
  //  - A last-frame-anchored runtime (see LAST_FRAME_ANCHORED_RUNTIMES) really
  //    consumes both frames — ltx2 via --image/--last-image, MiniMax H3 via
  //    --image/--anchor pairs — so resize the last frame even when a source
  //    image is also present.
  //  - On macOS/mlx_video the FFLF fallback only consumes the last image when
  //    no source image is also provided (single conditioning frame only).
  //    Anything else is a no-op, so resizing is wasted ffmpeg work.
  //  - A model that routes to generate_win.py takes --last-image only so the
  //    script can log status; the LTX-Video 0.9.5 pipeline reads --image
  //    alone, so it never opens the last-frame file. That gate keys on the
  //    RUNNER, not on the platform (see routesToWindowsHelper): both Windows
  //    and Linux have BYOV runtimes whose helper genuinely anchors the last
  //    frame, and a bare platform check would hand them an unresized frame.
  const lastImageWillBeUsed = !!lastImagePath && !routesToWindowsHelper(model) && mode === 'fflf'
    && (modelAnchorsLastFrame(model) || !sourceImagePath);
  // A non-null `keyframes` that ISN'T a length-≥2 array is malformed —
  // fail fast instead of silently dropping it (which would produce an
  // unexpected text/i2v render with the user's anchors ignored). The
  // route guarantees the array shape, but non-route callers (tests,
  // persisted queue replays) could pass a stray scalar/empty array.
  if (keyframes != null && !(Array.isArray(keyframes) && keyframes.length >= 2)) {
    throw new ServerError(
      `keyframes must be null OR an array of length >= 2; got ${Array.isArray(keyframes) ? `array(length=${keyframes.length})` : typeof keyframes}`,
      { status: 400, code: 'KEYFRAME_INVALID_SHAPE' },
    );
  }
  const hasMultiKeyframes = Array.isArray(keyframes) && keyframes.length >= 2;
  if (hasMultiKeyframes) {
    // The route validates shape, but a non-route caller (test, persisted
    // queue replay, future internal API) could pass malformed entries.
    // Validate before any resize subprocess starts so a rejection cannot
    // strand temp files created for the other conditioning inputs.
    keyframes.forEach((kf, i) => {
      if (!kf || typeof kf !== 'object') {
        throw new ServerError(`keyframes[${i}] must be an object: got ${typeof kf}`, { status: 400, code: 'KEYFRAME_INVALID_SHAPE' });
      }
      if (typeof kf.path !== 'string' || !kf.path) {
        throw new ServerError(`keyframes[${i}].path must be a non-empty string`, { status: 400, code: 'KEYFRAME_INVALID_SHAPE' });
      }
      // The Python helper enforces `index` is an int; a float or numeric
      // string here would crash mid-render. Coerce + verify integerness
      // up-front so non-route callers (tests, persisted queue replays)
      // get a clear 400 instead of a Python traceback.
      const n = Number(kf.index);
      if (!Number.isInteger(n)) {
        throw new ServerError(`keyframes[${i}].index must be an integer: got ${kf.index}`, { status: 400, code: 'KEYFRAME_INVALID_SHAPE' });
      }
    });
  }
  const ffmpeg = (sourceImagePath || lastImageWillBeUsed || hasMultiKeyframes) ? await findFfmpeg() : null;
  const ffprobe = model.runtime === 'minimax_h3_ref2va' ? await findFfprobe() : null;
  // Keyed on the runner, not just the runtime name: a model that routes to
  // generate_win.py also reads as mlx_video, but that pipeline is LTX-Video 0.9.
  const conditioningCrf = routesToWindowsHelper(model) ? null : (CONDITIONING_CRF_BY_RUNTIME[model.runtime || 'mlx_video'] ?? null);
  const resizeImage = async (srcPath, tag) => {
    if (!srcPath || !ffmpeg) return { resolved: srcPath, tempPath: null };
    const resizedPath = join(tmpdir(), `resized-${tag}-${jobId}.png`);
    const resizeResult = await execFileAsync(ffmpeg, [
      '-i', srcPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-update', '1', '-frames:v', '1',
      '-y', resizedPath,
    ], safeChildProcessOptions({ timeout: 10000 })).catch((err) => ({ error: err }));
    if (resizeResult.error) {
      console.log(`⚠️ Failed to resize ${tag} image, using original: ${resizeResult.error.message}`);
      return { resolved: srcPath, tempPath: null };
    }
    if (conditioningCrf != null) await recompressAsVideoFrame(ffmpeg, resizedPath, conditioningCrf, `${tag}-${jobId}`);
    return { resolved: resizedPath, tempPath: resizedPath };
  };
  // Two independent ffmpeg spawns — fan out for the same reason the keyframe
  // loop below does, so a true-FFLF render doesn't pay them back to back.
  const [
    { resolved: resolvedSourceImage, tempPath: resizedSrcTempPath },
    { resolved: resolvedLastImage, tempPath: resizedLastTempPath },
  ] = await Promise.all([
    resizeImage(sourceImagePath, 'src'),
    lastImageWillBeUsed
      ? resizeImage(lastImagePath, 'last')
      : { resolved: lastImagePath, tempPath: null },
  ]);
  // Resize each multi-keyframe image to the target resolution (the helper
  // requires exact W×H, same as i2v). Indices pass through unchanged.
  // Each ffmpeg subprocess is independent — fan out so 8 keyframes don't
  // serialize behind 7 unrelated ffmpeg startups.
  const resizedKeyframeTempPaths = [];
  let resolvedKeyframes = null;
  if (hasMultiKeyframes) {
    const results = await Promise.all(keyframes.map((kf, i) => resizeImage(kf.path, `kf${i}`)));
    resolvedKeyframes = results.map((r, i) => {
      if (r.tempPath) resizedKeyframeTempPaths.push(r.tempPath);
      // Normalize index to a real Number so the JSON we hand to the
      // Python helper is unambiguous (no '5' string sneaking through
      // from a multipart form).
      return { path: r.resolved, index: Number(keyframes[i].index) };
    });
  }

  // An `image`-kind IC weight (Ingredients) takes STILLS, but the pipeline's
  // reference channel is a video encoder end-to-end: iclora_utils probes the
  // reference with ffprobe and feeds it to the VAE, which requires a (1 + 8k)
  // frame count. A bare PNG has neither a probeable frame count nor 9 frames, so
  // materialize each still into a tiny 9-frame constant clip at the render
  // resolution first. 9 = the smallest legal (1 + 8k) count, so this is the
  // cheapest possible encode and every frame is identical — the reference is a
  // still either way.
  //
  // Done here rather than in the route because the target resolution is only
  // known after the resolution flooring in the renderer, and it mirrors resizeImage's contract:
  // temp paths are tracked for the same cleanup sites.
  const icReferenceTempPaths = [];
  // Both throw sites in this block land BEFORE the renderer's buildArgs try/catch
  // (whose catch is what normally unlinks resizedSrcTempPath/
  // resizedLastTempPath/resizedKeyframeTempPaths/icReferenceTempPaths) — a
  // throw here escapes uncaught by that cleanup, and the caller's outer catch
  // only unlinks the route-level upload/audio temp files, not these
  // internally-created resize/still-clip temp files. Clean them up explicitly
  // before either throw so a missing ffmpeg or a failed still-encode doesn't
  // leak every resized temp file for the request into os.tmpdir().
  const cleanupTempFiles = ({ includeUploads = false, includeUntrackedAudio = false } = {}) => {
    const paths = [
      resizedSrcTempPath,
      resizedLastTempPath,
      ...resizedKeyframeTempPaths,
      ...icReferenceTempPaths,
      ...(includeUploads ? [uploadedTempPath, ...uploadedTempPaths] : []),
      ...(includeUntrackedAudio && audioFilePath && !uploadedTempPaths.includes(audioFilePath)
        ? [audioFilePath]
        : []),
    ];
    return Promise.all(paths.filter(Boolean).map((path) => unlinkGuarded(path).catch(error => {
      if (error.code !== 'ENOENT') {
        maintenance.markCurrentUnsettled();
        maintenance.markResourceUnsettled('media', jobId);
      }
    })));
  };
  const resolvedIcReferencePaths = await materializeIngredientsReferences({
    mode, icReferencePaths, ffmpeg, w, h, parsedFps, jobId,
    icReferenceTempPaths, cleanupTempFiles,
  });
  return {
    resolvedSourceImage, resolvedLastImage, resolvedKeyframes, resolvedIcReferencePaths,
    hasMultiKeyframes, ffmpeg, ffprobe, cleanupTempFiles,
  };
}

/** Materialize Ingredients stills, settling every encode before failure cleanup. */
async function materializeIngredientsReferences({
  mode, icReferencePaths, ffmpeg, w, h, parsedFps, jobId,
  icReferenceTempPaths, cleanupTempFiles,
}) {
  if (isIcLoraMode(mode) && icLoraSpecForMode(mode)?.referenceKind === 'image'
    && Array.isArray(icReferencePaths) && icReferencePaths.length) {
    const stillFfmpeg = ffmpeg || await findFfmpeg();
    if (!stillFfmpeg) {
      await cleanupTempFiles();
      throw new ServerError(
        'ffmpeg is required to prepare still references for Ingredients mode — install it (brew install ffmpeg) and retry.',
        { status: 400, code: 'IC_LORA_STILL_NEEDS_FFMPEG' },
      );
    }
    // Register EVERY target path up-front, before any encode starts, and settle
    // all of them before deciding. `Promise.all` + push-on-success would reject
    // at the first failure while sibling encodes were still in flight, so their
    // files would land after cleanup already ran and leak. Registering the paths
    // eagerly also means the outer error/close handlers can clean up regardless
    // of which encodes finished.
    const clipPaths = icReferencePaths.map((_, i) => join(tmpdir(), `ic-still-${i}-${jobId}.mp4`));
    icReferenceTempPaths.push(...clipPaths);
    const encodes = await Promise.all(icReferencePaths.map((stillPath, i) => execFileAsync(stillFfmpeg, [
      '-loop', '1', '-i', stillPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-frames:v', String(IC_STILL_REFERENCE_FRAMES),
      '-r', String(parsedFps),
      '-pix_fmt', 'yuv420p', '-an',
      '-y', clipPaths[i],
    ], safeChildProcessOptions({ timeout: 30000 })).catch((err) => ({ error: err }))));
    const failedAt = encodes.findIndex((r) => r?.error);
    if (failedAt !== -1) {
      // Unlike the resizeImage fallback (which degrades to the original), there is
      // no usable degradation here — a still handed straight to the pipeline fails
      // deep inside the VAE reshape. Fail loudly with the ffmpeg reason.
      // cleanupTempFiles() also unlinks clipPaths (already pushed into
      // icReferenceTempPaths above), plus any earlier resize temp files.
      await cleanupTempFiles();
      throw new ServerError(
        `Failed to prepare Ingredients reference ${basename(icReferencePaths[failedAt])}: ${encodes[failedAt].error.message}`,
        { status: 400, code: 'IC_LORA_STILL_PREP_FAILED' },
      );
    }
    return clipPaths;
  }

  return icReferencePaths;
}

/** Round-trip a still through one H.264 frame at `crf`, in place (see CONDITIONING_CRF_BY_RUNTIME). */
async function recompressAsVideoFrame(ffmpeg, pngPath, crf, tag) {
  const framePath = join(tmpdir(), `crf-${tag}.mp4`);
  const options = safeChildProcessOptions({ timeout: 10000 });
  const failed = await execFileAsync(ffmpeg, [
    '-i', pngPath, '-frames:v', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-y', framePath,
  ], options)
    .then(() => execFileAsync(ffmpeg, ['-i', framePath, '-frames:v', '1', '-update', '1', '-y', pngPath], options))
    .then(() => null, (err) => err);
  await unlinkGuarded(framePath).catch(() => {});
  // A still that keeps its pristine pixels is still a valid conditioning, so
  // a failed round trip degrades to the old behavior rather than the render.
  if (failed) console.warn(`⚠️ Could not re-compress the ${tag} conditioning frame: ${failed.message}`);
}
