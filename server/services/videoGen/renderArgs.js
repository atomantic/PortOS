/** Dispatch local video renders and preserve the argument helpers used by callers. */
import { assertA2vLoraStageRequest } from '../../lib/videoLoraStageValidation.js';
import { existsSync } from 'fs';
import { ServerError } from '../../lib/errorHandler.js';
import { videoLoraFamily, isLtx2FamilyRuntime } from '../../lib/runners.js';
import { isIcLoraMode } from '../../lib/icLoraWeights.js';
import { continuationContract } from '../../lib/videoContinuity.js';
import { videoReferenceModeError, videoContinuityContractError } from './modeContract.js';
import { videoLoraUnsupportedError, routesToWindowsHelper } from './runtimes.js';
import { buildLtx2Args, buildLtx25CudaArgs, buildLtxUpscaleArgs } from './renderArgs/ltx.js';
import { buildFastVideoArgs } from './renderArgs/fastvideo.js';
import { buildWan22Args, buildWan22CudaArgs } from './renderArgs/wan22.js';
import { buildMiniMaxH3Args, buildMiniMaxH3CudaArgs, buildMiniMaxH3Ref2vaArgs } from './renderArgs/minimaxH3.js';
import { buildLegacyArgs } from './renderArgs/legacy.js';

export { assertRenderModeContract } from './modeContract.js';
export { buildFastVideoArgs, FASTVIDEO_FAMILIES, fastvideoFamily, FASTVIDEO_MLX_FORMATS, fastvideoMlxFormat } from './renderArgs/fastvideo.js';
export {
  buildLtxUpscaleArgs, computeFflfLtx2PixelBudget, computeFflfSafeFrames,
  ltx25TextEncoderArgs, resolveFflfLtx2PixelBudget, resolveT2vTwoStageOverride,
} from './renderArgs/ltx.js';
export { buildMiniMaxH3Ref2vaArgs } from './renderArgs/minimaxH3.js';
export { icLoraArgs, resolveVideoLoras } from './renderArgs/loras.js';

export const buildArgs = ({ continuityStrategy, contextFrames, historyContext, upscale, pythonPath, modelId, model, wanModelPath, fastvideoModelPath, fastvideoOmniAssets, referenceImagePaths, referenceVideoPaths, referenceAudioPaths, wanRequiredWeights, ltxModelPath, ref2vaModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, tiling, disableAudio, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, a2vLoraStageStrengths, textEncoderRepo, textEncoder, outputPath, previewDir, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile, draftDecoder, streamingMode, ffmpegPath, ffprobePath }) => {
  // Generative upscale (#6511) declines FIRST. It is not a text/image render:
  // it carries no video model, no prompt and no reference mode, so every guard
  // below would either dereference a model it was never given or reject it for
  // lacking a conditioning contract it does not have.
  assertA2vLoraStageRequest({ strengths: a2vLoraStageStrengths, model, mode, hasLoras: loras?.length > 0 });
  if (upscale) return buildLtxUpscaleArgs({ ...upscale, outputPath });
  const continuityError = videoContinuityContractError({ model, continuityStrategy, contextFrames });
  if (continuityError) throw continuityError;
  if (historyContext) {
    const historyError = videoContinuityContractError({ model, continuityStrategy: 'window', contextFrames });
    if (historyError) throw historyError;
    const contract = continuationContract(model?.runtime);
    if (contract.adapter !== 'h3-history'
      || typeof historyContext.sourceVideoPath !== 'string' || !existsSync(historyContext.sourceVideoPath)
      || !Number.isSafeInteger(historyContext.endFrame) || historyContext.endFrame < contract.historyFrames
      || historyContext.frames !== contract.historyFrames || fps !== contract.fps
      || sourceImagePath || lastImagePath || keyframes?.length || speedProfile || loras?.length || draftDecoder) {
      throw new ServerError('H3 history requires its pinned baseline adapter, exact 17-frame video/audio interval and no image, profile, LoRA or decoder substitutions.', { status: 400, code: 'VIDEO_HISTORY_CONTRACT_INVALID' });
    }
  }
  // Reference-mode promise (#4874) — checked HERE rather than inside
  // buildLtx2Args because every runtime reaches this function and only one can
  // honor a loose reference. A wan22/mlx_video/H3 render that fell through to its
  // own branch would pin frame one while the request asked for guidance, which is
  // exactly the silent downgrade the contract forbids. The route rejects this too;
  // internal producers, persisted-queue replays and retries all land here instead.
  const referenceModeError = videoReferenceModeError({
    model,
    mode: mode || (sourceImagePath ? 'image' : 'text'),
    referenceMode: i2vReferenceMode,
    hasFirstImage: Boolean(sourceImagePath),
  });
  if (referenceModeError) throw referenceModeError;
  // Route to the dgrauet/ltx-2-mlx helper when the model declares the new
  // runtime. Existing notapalindrome models default to runtime: 'mlx_video'
  // (or undefined in legacy registries — see backfillRuntime in mediaModels.js).
  if (isLtx2FamilyRuntime(model.runtime)) {
    return buildLtx2Args({ model, ltxModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, a2vLoraStageStrengths, disableAudio, outputPath, previewDir, textEncoderRepo, textEncoder, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile, streamingMode });
  }
  // IC-LoRA remix modes are an LTX-2 primitive (ICLoraPipeline) — no other
  // runtime has an equivalent. The route guards this too, but a non-route
  // caller (test, persisted queue replay) would otherwise fall through to a
  // plain t2v render with the user's reference clip silently dropped.
  if (isIcLoraMode(mode)) {
    throw new ServerError(
      `IC-LoRA remix modes require an ltx2-runtime model. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: 'IC_LORA_REQUIRES_LTX2' },
    );
  }
  const hasLoras = Array.isArray(loras) && loras.length > 0;
  // Defense-in-depth: LoRAs run only where videoLoraFamily() says they can —
  // ltx2 (handled above), a non-quantized LTX-2.x mlx_video model (the wrapper
  // below), or a minimax_h3 checkout whose probe proved a quant-aware
  // applicator (including CUDA's separately probed adapter). The route rejects the rest,
  // but a non-route caller (test, queue replay) — or a Windows install with a
  // hand-edited/synced entry — could reach here. Fail clearly rather than fall
  // through to the generate_win.py branch below, which would silently drop the
  // LoRAs and produce a base render the user thinks is LoRA-styled.
  // The same predicate the enqueue gate uses, off the same decorated model, so
  // the two can't disagree — and the reason text comes from one factory. The
  // legacy-Windows-helper arm is keyed on the RUNNER, not the platform: a
  // Windows BYOV runtime now gets the same runner-based reason the enqueue gate
  // gives it, instead of a blanket "can't fuse LoRAs on Windows" that would
  // contradict it.
  const usesWindowsHelper = routesToWindowsHelper(model);
  if (hasLoras && (!videoLoraFamily(model) || usesWindowsHelper)) {
    throw usesWindowsHelper
      ? new ServerError(
        `LoRA fusion runs through the macOS-only mlx_video path; model "${modelId}" can't fuse LoRAs on the CUDA LTX-Video helper.`,
        { status: 400, code: 'LORAS_REQUIRE_LTX2' },
      )
      : videoLoraUnsupportedError(model, modelId);
  }
  if (model.runtime === 'fastvideo') {
    return buildFastVideoArgs({ model, fastvideoModelPath, fastvideoOmniAssets, referenceImagePaths, referenceVideoPaths, referenceAudioPaths, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, lastImagePath, mode, outputPath });
  }
  if (model.runtime === 'wan22') {
    return buildWan22Args({ model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath });
  }
  if (model.runtime === 'wan22_cuda') {
    return buildWan22CudaArgs({ model, wanModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath });
  }
  if (model.runtime === 'minimax_h3') {
    return buildMiniMaxH3Args({ historyContext, speedProfile, model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, previewDir, loras, textEncoder, draftDecoder });
  }
  if (model.runtime === 'minimax_h3_cuda') {
    return buildMiniMaxH3CudaArgs({ historyContext, model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, loras, speedProfile });
  }
  if (model.runtime === 'minimax_h3_ref2va') {
    return buildMiniMaxH3Ref2vaArgs({
      model, ref2vaModelPath, prompt, negativePrompt, width, height, numFrames,
      fps, steps, seed, sourceImagePath, audioFilePath, audioStartSec, mode,
      tiling, disableAudio, outputPath, ffmpegPath, ffprobePath,
    });
  }
  if (model.runtime === 'ltx25_cuda') {
    return buildLtx25CudaArgs({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, mode, imageStrength, disableAudio, outputPath });
  }
  // Migration 315 removes the shipped Hunyuan profile, but a user-repointed
  // or peer-synced historical entry may still declare its retired runtime.
  // Fail closed instead of falling through to a legacy MLX/CUDA helper that
  // cannot load the checkpoint.
  if (model.runtime === 'hunyuan') {
    throw new ServerError(
      `The "hunyuan" runtime was retired — model "${modelId}" can no longer be rendered. Pick a supported model such as FastMetal in data/media-models.json.`,
      { status: 400, code: 'VIDEO_RUNTIME_RETIRED' },
    );
  }
  if (Array.isArray(keyframes) && keyframes.length >= 2) {
    throw new ServerError(
      'Multi-keyframe mode (keyframes array) is only supported on the ltx2 runtime. Pick a model with runtime: "ltx2" in data/media-models.json.',
      { status: 400, code: 'KEYFRAMES_REQUIRE_LTX2' },
    );
  }
  if (mode === 'a2v') {
    throw new ServerError(
      'a2v mode requires an audio-to-video runtime.',
      { status: 400, code: 'A2V_RUNTIME_UNSUPPORTED' },
    );
  }
  return buildLegacyArgs({
    pythonPath, modelId, model, prompt, negativePrompt, width, height, numFrames, fps, steps,
    guidance, seed, sourceImagePath, lastImagePath, mode, imageStrength, disableAudio, outputPath,
    textEncoderRepo, tiling, loras, hasLoras, usesWindowsHelper,
  });
};

// Default frame count for LTX renders, matching the 8k+1 latent-boundary
// the model wants. Exported so the route layer can validate keyframe
// indices against the same effective number of frames the service will
// use (avoiding drift between two hardcoded constants).
export const DEFAULT_NUM_FRAMES = 121;

// Frame count for the throwaway clip an `image`-kind IC reference (Ingredients)
// is materialized into. The pipeline's reference channel runs every reference
// through ffprobe + the video VAE, whose `space_to_depth` reshape needs a
// (1 + 8k)-frame input — 9 is the smallest legal value, so it's the cheapest
// encode that satisfies the encoder. Every frame is identical; the reference is
// a still regardless of how many frames carry it.
export const IC_STILL_REFERENCE_FRAMES = 9;

const configuredVideoDimension = (value, fallback) => {
  const configured = Number(value);
  return Number.isFinite(configured) && configured >= 64 && configured <= 2048
    ? configured
    : fallback;
};

export const resolveVideoDimensions = (model, width, height) => ({
  width: width ?? configuredVideoDimension(model?.defaultWidth, 768),
  height: height ?? configuredVideoDimension(model?.defaultHeight, 512),
});
