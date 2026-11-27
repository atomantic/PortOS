import { listVideoModels, resolveVideoModel, defaultVideoModelId } from './modelCatalog.js';
import { prepareVideoConditioningMedia } from './conditioningMedia.js';
import { planVideoBatch, validateVideoBatch } from './batch.js';
import { normalizeVideoFailure } from '../../lib/videoFailure.js';
/**
 * Video Gen — local render runner (mlx_video on macOS, diffusers on Windows).
 *
 * Spawns a Python child to render an LTX video. Output lives in `data/videos/`
 * with thumbnails in `data/video-thumbnails/`. History is appended to
 * `data/video-history.json` so the Media History page can grid-view them.
 *
 * Image-to-video accepts either an in-PortOS image filename (from data/images)
 * or an upload — both get resized via ffmpeg to match target resolution before
 * the model sees them.
 */

import { mkdtemp } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { recordVideoExecution, recordVideoExecutionDiagnostics } from './executionRecorder.js';
import { federatedSourceAudioSchema } from '../../lib/federatedMediaWire.js';
import { wan22FrameCountError } from './wan22Controls.js';
import {
  isDefaultI2vReferenceMode, normalizeI2vReferenceMode, resolveI2vReferenceStrength,
} from '../../lib/videoReferenceModes.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, dispatchCanceledJob, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { getTextEncoderRepo } from '../../lib/mediaModels.js';
import { hardwareUnavailableReason, isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { resolveVideoModelSelection } from './modelSelection.js';
import { findCachedRepoFile, findCachedRepoFiles } from '../../lib/hfCache.js';
import { describeRenderConditioning, RENDER_INPUTS_VERSION } from './generateVideoHelpers.js';
import { readTriggerWordsByFilename, readLoraLicensesByFilename } from '../loras.js';
import { provenanceForRender } from '../../lib/assetProvenance.js';
import { weaveLoraTriggers } from '../../lib/loraTriggers.js';
import { isLtx2FamilyRuntime } from '../../lib/runners.js';
import {
  resolveVideoTextEncoder,
} from '../../lib/videoTextEncoders.js';
import {
  isIcLoraMode, icLoraSpecForMode, icLoraSupportsRuntime, icLoraFrameIssue, resolveIcLoraWeight,
} from '../../lib/icLoraWeights.js';
import {
  BYOV_VIDEO_RUNTIMES,
  resolveByovRuntimeLoraCapable,
  routesToWindowsHelper,
} from './runtimes.js';
import { getSettings } from '../settings.js';
import { loadHistory, saveHistory, mutateVideoHistory, getHistoryItem } from './history.js';
import { sanitizeContinuation } from '../../lib/videoContinuationProvenance.js';
import { VIDEO_MODE_GATED_RUNTIMES, videoContinuityContractError } from './modeContract.js';
import { videoJobState, beginPreparation } from './jobState.js';
import {
  assertRenderModeContract,
  buildArgs,
  DEFAULT_NUM_FRAMES,
  resolveVideoDimensions,
  resolveVideoLoras,
  resolveT2vTwoStageOverride,
} from './renderArgs.js';
import { spawnAndWatchVideo } from './spawnWatch.js';
import { resolvePinnedSnapshotPath } from './pinnedSnapshot.js';
import {
  resolveVideoSpeedProfile, speedProfileDeclineReason, resolveVideoSampler,
  inferEffectiveVideoMode,
} from '../../lib/videoSpeedProfiles.js';
import { isDefaultVideoStreamingMode } from '../../lib/videoStreamingMode.js';
import { isMiniMaxH3SpeedProfileRequest } from '../../lib/minimaxH3SpeedProfiles.js';
import { extendLatentFrames, supportsContextWindow, resolveContinuityRequest } from '../../lib/videoContinuity.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';
// Re-export the extracted runtime + history surface so existing deep imports
// (`from '../videoGen/local.js'`) keep resolving every symbol they used to.
export * from './runtimes.js';
export * from './modeContract.js';
export * from './eta.js';
export { resolveFflfLtx2PixelBudget, resolveVideoLoras, DEFAULT_NUM_FRAMES } from './renderArgs.js';
export { attachSseClient, cancel } from './jobState.js';
export { loadHistory, saveHistory, mutateVideoHistory, getHistoryItem, buildLocalVideoJobRecord };


export { listVideoModels, resolveVideoModel, defaultVideoModelId };

/**
 * The prompt a local video render sends, with each selected LoRA's trigger word
 * woven in, and its record (#11317). Shared by the render and the Video Gen
 * form's preview.
 */
export async function localVideoSentPrompt({ prompt = '', negativePrompt, loraFilenames = [], promptAdditions = [] }) {
  const triggerWordsByLora = await readTriggerWordsByFilename(loraFilenames);
  const { prompt: renderPrompt, added: addedTriggerWords } = weaveLoraTriggers(
    prompt,
    loraFilenames.map((filename) => triggerWordsByLora[filename]),
  );
  return {
    renderPrompt, addedTriggerWords,
    record: sentPromptRecord({ sentPrompt: renderPrompt, sentNegativePrompt: negativePrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [promptAddition('lora-triggers', 'LoRA trigger words', addedTriggerWords.join(', '))] }),
  };
}

// History records references by basename, never by staging path.
const referenceNames = (pathsByField) => Object.fromEntries(
  Object.entries(pathsByField)
    .filter(([, paths]) => Array.isArray(paths) && paths.length > 0)
    .map(([field, paths]) => [field, paths.map((p) => basename(p))]),
);

// FastH3 Omni renders from five separately pinned downloads: the BF16 export
// (the model snapshot), the base snapshot's text encoder / tokenizer / audio VAE,
// the FastH3 quality decoder and the LightVAE reference encoder. The helper
// composes them, so hand it the resolved cache paths — a missing file fails here
// as a clean 400 rather than minutes into the render.
async function resolveFastH3OmniAssets(model) {
  const byRole = (role) => (model.requiredWeights || []).find((dep) => dep?.role === role);
  const [base, decoder, encoder] = ['base', 'vaeDecoder', 'vaeEncoder'].map(byRole);
  const missing = () => new ServerError(
    `${model.name} is missing downloaded weights. Download or repair them in Video Gen.`,
    { status: 400, code: 'FASTVIDEO_OMNI_WEIGHTS_NOT_CACHED' },
  );
  if (!base?.repo || !decoder?.repo || !encoder?.repo) {
    throw new ServerError(`Video model "${model.id}" is missing its required weights.`, { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
  }
  const resolveDep = async (dep) => {
    const paths = await findCachedRepoFiles(dep.repo, dep.files, { revision: dep.revision });
    if (!paths) throw missing();
    return paths;
  };
  const [basePaths, [vaeDecoder], [vaeEncoder]] = await Promise.all([base, decoder, encoder].map(resolveDep));
  const configIndex = base.files.indexOf('vae/config.json');
  const baseRoot = basePaths[configIndex].slice(0, -'/vae/config.json'.length);
  return { baseRoot, vaeDecoder, vaeEncoder };
}

// Resolve required render assets before staging media or acquiring GPU work.
// Runtime-specific pin/fallback policies and dependency ordering stay explicit.
async function resolveVideoModelAssets({ model, modelId, textEncoderId }) {
  let wanModelPath = null;
  const wanRequiredWeights = [];
  if (model.runtime === 'wan22' || model.runtime === 'wan22_cuda') {
    wanModelPath = await resolvePinnedSnapshotPath(model, {
      notCachedCode: 'WAN22_MODEL_NOT_CACHED',
      onMissingRevision: 'throw',
      missingRevisionMessage: `Wan model "${modelId}" is missing an immutable Hugging Face revision.`,
    });
    for (const dep of Array.isArray(model.requiredWeights) ? model.requiredWeights : []) {
      const files = Array.isArray(dep?.files) ? dep.files : [];
      const roles = Array.isArray(dep?.targetRoles) ? dep.targetRoles : [];
      if (!dep?.repo || !dep?.revision || files.length === 0 || files.length !== roles.length) {
        throw new ServerError(
          `Wan model "${modelId}" has an invalid requiredWeights entry.`,
          { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
        );
      }
      const paths = await Promise.all(files.map((file) => findCachedRepoFile(
        dep.repo, file, { revision: dep.revision },
      )));
      for (let i = 0; i < files.length; i += 1) {
        if (!paths[i]) {
          throw new ServerError(
            `${model.name} is missing required weight ${files[i]}. Download or repair its dependencies in Video Gen.`,
            { status: 400, code: 'WAN22_REQUIRED_WEIGHT_NOT_CACHED' },
          );
        }
        wanRequiredWeights.push({ path: paths[i], role: roles[i] });
      }
    }
  }
  let fastvideoModelPath = null;
  let fastvideoOmniAssets = null;
  if (model.runtime === 'fastvideo') {
    // The Omni piece lookups don't depend on the primary snapshot, so overlap them.
    [fastvideoModelPath, fastvideoOmniAssets] = await Promise.all([
      resolvePinnedSnapshotPath(model, {
        notCachedCode: 'FASTVIDEO_MODEL_NOT_CACHED',
        onMissingRevision: 'best-effort',
        // A null miss preserves the legacy handoff: buildFastVideoArgs falls
        // back to the repo id only when no unpinned snapshot is resident.
      }),
      model.fastvideoFamily === 'fasth3omni' ? resolveFastH3OmniAssets(model) : null,
    ]);
  }
  // Pinned LTX family entries (LTX-2.5 today) must render the verified
  // snapshot, not whatever `main` snapshot_download would follow. Unpinned
  // 2.3 entries keep passing the repo id so the helper's existing Hub resolve
  // stays unchanged.
  let ltxModelPath = model.repo;
  if (isLtx2FamilyRuntime(model.runtime)) {
    ltxModelPath = await resolvePinnedSnapshotPath(model, {
      notCachedCode: 'LTX2_MODEL_NOT_CACHED',
      onMissingRevision: 'passthrough-repo',
      fallback: model.repo,
    });
  }
  let ref2vaModelPath = null;
  if (model.runtime === 'minimax_h3_ref2va') {
    ref2vaModelPath = await resolvePinnedSnapshotPath(model, {
      notCachedCode: 'MINIMAX_H3_REF2VA_MODEL_NOT_CACHED',
      onMissingRevision: 'throw',
      missingRevisionMessage: `MiniMax H3 Ref2VA model "${modelId}" is missing an immutable Hugging Face revision.`,
    });
  }
  // Substituted prompt conditioner (#4081). `resolveVideoTextEncoder` returns
  // null for the stock choice — the whole override path stays dormant then —
  // and throws a 400 when the model's runtime has no remap for the requested
  // id. The weight is resolved against the HF cache HERE rather than in the
  // helper so a missing download fails as a clean 400 before any GPU work,
  // matching how wan22's required weights are handled above.
  const textEncoderOption = resolveVideoTextEncoder(model, textEncoderId);
  let resolvedTextEncoder = null;
  if (textEncoderOption) {
    // All-or-nothing across every pinned shard: a partially-cached multi-shard
    // conditioner must fail here as a clean 400 rather than loading a module
    // tree with missing parameters minutes into the render.
    const encoderPaths = await findCachedRepoFiles(
      textEncoderOption.repo, textEncoderOption.files, { revision: textEncoderOption.revision },
    );
    if (!encoderPaths) {
      throw new ServerError(
        `Text encoder "${textEncoderOption.label}" is not downloaded. Download it in Video Gen before rendering.`,
        { status: 400, code: 'VIDEO_TEXT_ENCODER_NOT_CACHED' },
      );
    }
    // Runtime-agnostic: each runner's arg builder reads only the loader
    // mechanics its own helper understands (H3 the key remap and final norm,
    // ltx25 the config overrides), so one resolution serves both.
    resolvedTextEncoder = {
      id: textEncoderOption.id,
      paths: encoderPaths,
      keyPrefixMap: textEncoderOption.keyPrefixMap,
      finalNormKey: textEncoderOption.finalNormKey,
      configOverrides: textEncoderOption.configOverrides,
    };
  }
  return { wanModelPath, wanRequiredWeights, fastvideoModelPath, fastvideoOmniAssets, ltxModelPath, ref2vaModelPath, resolvedTextEncoder };
}

// Negotiates the user-facing speed profile (#4875) and the opt-in T2V two-stage
// override. A profile that cannot apply degrades to the default sampler (logged);
// MiniMax H3 refuses instead, since it has no meaningful default schedule.
async function resolveLocalSpeedProfile({
  model, jobId, speedProfileId, mode, keyframes, sourceImagePath, extendFromVideoPath, audioFilePath, lastImagePath,
  w, h, steps, guidanceScale, resolvedLoras, uploadedTempPath, uploadedTempPaths,
}) {
  // Resolved against the mode the runner will actually INFER, not the raw
  // (possibly absent) request field: buildLtx2Args derives fflf from keyframes
  // and image from a source frame, so gating on a bare `mode` would hand a
  // two-stage schedule to a KeyframeInterpolation render for any direct caller
  // that omits it (Writers Room batch dispatch, scripts).
  const speedProfileMode = inferEffectiveVideoMode({
    mode, keyframes, sourceImagePath, extendFromVideoPath, audioFilePath,
  });
  let speedProfile = resolveVideoSpeedProfile({ model, profileId: speedProfileId, mode: speedProfileMode });
  if (isMiniMaxH3SpeedProfileRequest(speedProfileId)) {
    const { prepareMiniMaxH3SpeedProfile } = await import('./ensureWeights.js');
    speedProfile = await prepareMiniMaxH3SpeedProfile({
      model, profileId: speedProfileId, mode: speedProfileMode,
      width: w, height: h, steps, guidanceScale,
      keyframes, lastImagePath, extendFromVideoPath, audioFilePath,
    });
  }
  if (['minimax_h3', 'minimax_h3_cuda'].includes(model.runtime) && resolvedLoras.length) {
    const { validateMiniMaxH3CudaLoras, validateMiniMaxH3MlxLoras } = await import('./ensureWeights.js');
    const validate = model.runtime === 'minimax_h3' ? validateMiniMaxH3MlxLoras : validateMiniMaxH3CudaLoras;
    await validate(resolvedLoras, speedProfile);
  }
  const speedProfileDeclined = speedProfile ? null : speedProfileDeclineReason({ model, profileId: speedProfileId, mode: speedProfileMode });
  if (speedProfileDeclined && ['minimax_h3', 'minimax_h3_cuda'].includes(model.runtime)) {
    throw new ServerError(speedProfileDeclined.message, { status: 400, code: speedProfileDeclined.code });
  }
  if (speedProfileDeclined) {
    console.log(`⚠️ Speed profile declined [${jobId.slice(0, 8)}] ${speedProfileDeclined.code}: ${speedProfileDeclined.message}`);
  }
  // Skipped once a speed profile applied: the profile IS the user-chosen
  // schedule, and the env experiment must not overwrite it.
  const t2vTwoStage = speedProfile ? null : resolveT2vTwoStageOverride({
    runtime: model.runtime, mode, guidanceScale, steps,
    sourceImagePath, uploadedTempPath, uploadedTempPaths,
    keyframes, extendFromVideoPath, audioFilePath,
  });
  return { speedProfile, speedProfileDeclined, t2vTwoStage };
}

function logSpeedProfileSchedule({ speedProfile, jobId, steps, guidance, stage2Steps }) {
  if (!speedProfile) return;
  const schedule = speedProfile.denoisingSteps != null
    ? `${speedProfile.denoisingSteps} updates (${steps} sigma points)` : `${steps}+${stage2Steps} steps`;
  console.log(`⚡ Speed profile "${speedProfile.id}" [${jobId.slice(0, 8)}]: ${schedule}, cfg ${guidance}${speedProfile.teacache ? ', teacache' : ''}`);
}

// Projects already-resolved render values into the persisted job record. Key
// order is part of the contract: the record is stored in history and replayed
// on resume and Remix, so conditional spreads stay exactly where they are.
function buildLocalVideoJobRecord({
  jobId, batch, batchSize, prompt, negativePrompt, modelId, model, actualSeed, w, h, parsedNumFrames,
  parsedFps, actualSteps, actualGuidance, actualStage2Steps, tiling, disableAudio, sourceAudioProvenance,
  resolvedTextEncoder, filename, createdAt, mode, hasMultiKeyframes, sourceImagePath,
  effectiveReferenceMode, actualImageStrength, resolvedContinuation, resolvedSourceImage, resolvedLastImage,
  resolvedKeyframes, extendFromVideoPath, audioFilePath, resolvedIcReferencePaths, visualConditioning,
  t2vTwoStage, speedProfile, a2vLoraStageStrengths, resolvedLoras, streamingMode,
  actualIcStrength, actualIcAttentionStrength, icSkipStage2, icReferencePaths, referenceImagePaths,
  referenceVideoPaths, referenceAudioPaths, loraLicenses, addedTriggerWords, renderPrompt, sentRecord,
  hidden,
}) {
  return {
    id: jobId,
    ...(batch ? { batchId: jobId, batchSize, batchIndex: 0 } : {}),
    prompt,
    negativePrompt,
    modelId,
    seed: actualSeed,
    width: w,
    height: h,
    numFrames: parsedNumFrames,
    fps: parsedFps,
    // Persist the effective render settings so the lightbox Remix flow can
    // round-trip them back into the form. Without these, Remix would only
    // recover prompt/model/dims/frames/fps/seed and silently revert the
    // other dials to defaults.
    steps: actualSteps,
    guidanceScale: actualGuidance,
    tiling,
    disableAudio,
    ...(sourceAudioProvenance ? { audioConditioning: sourceAudioProvenance } : {}),
    // Which prompt conditioner read this prompt. Only recorded when it wasn't
    // the stock one, so pre-feature history and every unswapped render stay
    // byte-identical — and so a Remix of a stock render can't resurrect an
    // override the user has since deselected.
    ...(resolvedTextEncoder ? { textEncoderId: resolvedTextEncoder.id } : {}),
    filename,
    createdAt,
    // History mode reflects the EFFECTIVE mode — buildLtx2Args infers fflf
    // from `keyframes` even when caller omitted `mode`, so without this the
    // history entry would say 'text' for a multi-keyframe render.
    mode: mode || (hasMultiKeyframes ? 'fflf' : sourceImagePath ? 'image' : 'text'),
    // What the conditioning image promised, and the strength that delivered it
    // (#4874). Both are recorded only when they actually applied, so every text
    // render and every pre-feature row stays byte-identical — and a Remix of an
    // anchored render can't resurrect a mode the user never chose. The mode is the
    // EFFECTIVE one, so a record never claims a promise the render did not make.
    ...(isDefaultI2vReferenceMode(effectiveReferenceMode) ? {} : { i2vReferenceMode: effectiveReferenceMode }),
    ...(actualImageStrength != null ? { imageStrength: actualImageStrength } : {}),
    // Durable re-render provenance (#3696). `seed` above is ALWAYS the resolved
    // seed (a caller-omitted seed was rolled into `actualSeed` before the child
    // ever ran), so a random-seed render records the seed it actually used and
    // a Finish re-render reproduces the same composition rather than re-rolling.
    // `conditioning` inventories what else steered this render — empty means
    // prompt + seed + dials are the whole input. `renderInputsVersion` is the
    // marker that both are trustworthy; records without it are legacy and must
    // not be assumed unconditioned. Neither field carries a staging path.
    ...(resolvedContinuation ? { continuation: sanitizeContinuation(resolvedContinuation) } : {}),
    renderInputsVersion: RENDER_INPUTS_VERSION,
    conditioning: describeRenderConditioning({
      sourceImagePath: resolvedSourceImage,
      lastImagePath: resolvedLastImage,
      keyframes: resolvedKeyframes,
      extendFromVideoPath,
      audioFilePath,
      icReferencePaths: resolvedIcReferencePaths,
    }),
    ...(visualConditioning ? { visualConditioning } : {}),
    // Stamp the experimental fast-path so A/B analysis can tell a two-stage
    // render apart from a user who happened to pick 8 steps — comparing it
    // against the default Standard render is the whole point of the knob.
    ...(t2vTwoStage ? { twoStageT2v: true, stage2Steps: actualStage2Steps } : {}),
    // Speed profile (#4875). Recorded as the REQUESTED id so a Remix
    // round-trips the schedule the user picked, and — critically — so the ETA
    // estimator can keep fast and quality samples in separate cost buckets
    // (see timedRenderSamples in ./eta.js): a profile roughly halves render
    // time, which is a different cost curve, not sample noise. Absent on a
    // quality render, so every pre-feature history row stays byte-identical.
    // What the runner ACTUALLY managed to apply is stamped separately by
    // finalizeGeneratedVideo from the child's SPEEDPROFILE: report.
    ...(speedProfile ? { speedProfileId: speedProfile.id, stage2Steps: actualStage2Steps } : {}),
    // Block-streaming request (#6499). Recorded as the REQUESTED mode, same
    // convention as speedProfileId above — 'auto' and absence are
    // the same request, so a quality-default render's history row stays
    // byte-identical to one from before this setting existed. What the
    // bridge ACTUALLY did (active/reason/peakMb) is stamped separately by
    // finalizeGeneratedVideo from the child's STREAMPOLICY: report.
    ...(mode === 'a2v' && resolvedLoras.length ? { a2vLoraStageStrengths: a2vLoraStageStrengths ?? [1, 1] } : {}),
    ...(isDefaultVideoStreamingMode(streamingMode) ? {} : { streamingMode }),
    // IC-LoRA remix settings, stamped so the lightbox Remix flow can round-trip
    // them. The reference clip is recorded by BASENAME (not the absolute
    // staging path) — history is user-facing and a durable upload path is both
    // noise and machine-specific.
    ...(isIcLoraMode(mode) ? {
      icStrength: actualIcStrength,
      ...(actualIcAttentionStrength != null ? { icAttentionStrength: actualIcAttentionStrength } : {}),
      ...(icSkipStage2 ? { icSkipStage2: true } : {}),
      ...(Array.isArray(icReferencePaths) && icReferencePaths.length
        ? { icReferenceNames: icReferencePaths.map((p) => basename(p)) }
        : {}),
    } : {}),
    ...referenceNames({ referenceImageNames: referenceImagePaths, referenceVideoNames: referenceVideoPaths, referenceAudioNames: referenceAudioPaths }),
    // Stamp applied LoRAs using the SAME parallel-array contract image renders
    // use (`loraFilenames` + `loraScales`) so the existing history consumers —
    // normalizeVideo / getRenderConfigForItem (client/src/components/media/
    // normalize.js) and the Remix handler — surface and round-trip them with no
    // per-shape special-casing. A bespoke `loras` field would be invisible to
    // those readers.
    ...(resolvedLoras.length ? {
      loraFilenames: resolvedLoras.map((l) => l.filename),
      loraScales: resolvedLoras.map((l) => l.strength),
    } : {}),
    provenance: provenanceForRender({
      model: {
        id: modelId,
        name: model?.name || modelId,
        license: model?.license,
        repo: model?.repo,
        disclosure: model?.disclosure,
      },
      loras: resolvedLoras.map((l) => ({
        filename: l.filename,
        ...(loraLicenses[l.filename] || {}),
      })),
      capturedAt: createdAt,
    }),
    // Provenance for the trigger weave (#4665). `prompt` above stays the user's
    // own text, so Remix re-derives triggers from whatever LoRAs are selected
    // then instead of compounding this render's clause; these two record what
    // was actually rendered. Present only when something was woven, so every
    // other history row stays byte-identical to pre-feature renders.
    ...(addedTriggerWords.length ? { renderPrompt, addedTriggerWords } : {}),
    ...sentRecord,
    ...(hidden ? { hidden: true } : {}),
  };
}

// Every continuity contract check the render performs, in the order callers
// observe their errors: the explicit request, the history-window request, then
// the strategy replayed from a persisted `continuation`. Returns the
// continuation record to persist (null when no continuity was requested).
function resolveVideoContinuity({ model, continuityStrategy, contextFrames, continuation, historyContext, extendFromVideoPath }) {
  const continuityError = videoContinuityContractError({ model, continuityStrategy, contextFrames });
  if (continuityError) throw continuityError;
  if (historyContext) {
    const historyError = videoContinuityContractError({ model, continuityStrategy: 'window', contextFrames });
    if (historyError) throw historyError;
  }
  const safeContinuation = sanitizeContinuation(continuation);
  const requestedStrategy = continuityStrategy ?? (safeContinuation?.requestedStrategy === 'auto'
    ? undefined : safeContinuation?.requestedStrategy);
  const replayContinuityError = videoContinuityContractError({ model,
    continuityStrategy: requestedStrategy, contextFrames: contextFrames ?? safeContinuation?.contextFrames });
  if (replayContinuityError) throw replayContinuityError;
  const currentContinuation = resolveContinuityRequest({ model, continuityStrategy: requestedStrategy,
    contextFrames: contextFrames ?? safeContinuation?.contextFrames });
  if (!safeContinuation && continuityStrategy == null) return null;
  return {
    ...currentContinuation,
    actualHistoryFrames: (extendFromVideoPath || historyContext)
      && currentContinuation.effectiveStrategy === 'window'
      ? (historyContext?.frames ?? safeContinuation?.actualHistoryFrames ?? null) : 0,
  };
}

// IC-LoRA remix: resolve the per-mode weight before any GPU work. A cached
// weight resolves to the exact file inside the HF snapshot; an un-cached one
// falls back to the repo id, which ICLoraPipeline downloads itself — log that
// so a several-hundred-MB pull mid-render isn't a mystery in the server log.
async function resolveLocalIcLoraWeight(mode) {
  if (!isIcLoraMode(mode)) return null;
  const resolved = await resolveIcLoraWeight(mode);
  if (!resolved) {
    throw new ServerError(`Unknown IC-LoRA remix mode: ${mode}`, { status: 400, code: 'IC_LORA_UNKNOWN_MODE' });
  }
  if (!resolved.path && mode === 'ic-ingredients-25') {
    throw new ServerError('Download ' + resolved.spec.label + ' from the model panel first.',
      { status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' });
  }
  if (!resolved.cached && resolved.path) {
    console.log(`⬇️  IC-LoRA weight not cached — ${resolved.spec.repo} will download at render time`);
  }
  // A null path means the registry deliberately refused the repo-id fallback
  // (requiresPreDownload). icLoraArgs turns that into the user-facing 400; log
  // the reason here so the server log explains WHY there's no auto-download.
  if (!resolved.path) {
    console.warn(`⛔ IC-LoRA weight for ${mode} needs an explicit download (auto-fetch would snapshot ${resolved.spec.mirrorRepo || resolved.spec.repo})`);
  }
  return resolved.path;
}

// IC-LoRA mode / frame-count / Wan frame-count contract. Throws the 400.
function assertLocalFrameContract({ model, mode, numFrames, icSkipStage2 }) {
  const icSpec = icLoraSpecForMode(mode);
  if (icSpec && !icLoraSupportsRuntime(icSpec, model.runtime)) {
    throw new ServerError(mode + ' requires a ' + icSpec.baseModel + ' model.',
      { status: 400, code: 'IC_LORA_REQUIRES_LTX2' });
  }
  const icFrameIssue = icLoraFrameIssue(icSpec, numFrames);
  if (icFrameIssue) throw new ServerError(icFrameIssue, { status: 400, code: 'IC_LORA_REFERENCE_TOO_SHORT' });
  if (mode === 'ic-ingredients-25' && icSkipStage2) {
    throw new ServerError('LTX 2.5 References requires the refinement stage.',
      { status: 400, code: 'IC_LORA_SKIP_STAGE2_UNSUPPORTED' });
  }
  const frameCountError = wan22FrameCountError(model, numFrames);
  if (frameCountError) throw frameCountError;
}

// Model/hardware/continuity/mode validation plus asset and LoRA resolution —
// everything that can fail with a clean 4xx before any directory, job id or GPU
// work exists. Returns the resolved values the later phases consume (the raw
// `width`/`height`/`numFrames`/`sourceImagePath` it normalizes come back under
// the same names).
async function validateAndResolveLocalInputs(params) {
  const {
    pythonPath, modelId: requestedModelId, width = null, height = null, numFrames = null, batchSize = 1, seed,
    uploadedTempPath = null, lastImagePath = null, keyframes = null, extendFromVideoPath = null, audioFilePath = null,
    audioStartSec = null, mode = null, a2vLoraStageStrengths, loras = null, icReferencePaths = null,
    referenceImagePaths = null, referenceVideoPaths = null, referenceAudioPaths = null, icSkipStage2 = false,
    textEncoderId = null, continuityStrategy, contextFrames, continuation = null, historyContext = null,
  } = params;
  let { sourceImagePath = null } = params;

  const { modelId, model } = await resolveVideoModelSelection(requestedModelId, { resolveModel: resolveVideoModel });
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  const resolvedContinuation = resolveVideoContinuity({
    model, continuityStrategy, contextFrames, continuation, historyContext, extendFromVideoPath,
  });
  validateVideoBatch({ batchSize, seed }, model);
  if (!isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      hardwareUnavailableReason(`Video model "${modelId}"`, model.hardwareCompatibility),
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  // Validate the mode contract before cache lookups, image resize, or staging
  // work. Internal producers and persisted/retried jobs bypass route
  // preparation, so silently dropping one of these inputs here would render a
  // materially different video than the caller requested. Ungated runtimes
  // (ltx2 / mlx_video) fall through untouched.
  //
  // Promote before checking: the route sets both fields, but a direct caller
  // that only staged `uploadedTempPath` would otherwise pass the mode guard and
  // then render text-only with its image dropped.
  if (VIDEO_MODE_GATED_RUNTIMES.has(model.runtime)) sourceImagePath ||= uploadedTempPath;
  assertRenderModeContract({
    model, mode, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec,
    icReferencePaths, referenceImagePaths, referenceVideoPaths, referenceAudioPaths,
  });
  const { validateA2vLoraStages } = await import('./loraStages.js');
  await validateA2vLoraStages({ strengths: a2vLoraStageStrengths, model, mode, hasLoras: loras?.length > 0 });
  // Registry defaults are user-editable. Validate them at this internal-call
  // boundary so an empty or malformed value cannot turn into a 0/NaN runner
  // argument when the caller deliberately leaves the resolution unset.
  const dimensions = resolveVideoDimensions(model, width, height);
  const resolvedNumFrames = numFrames ?? model.defaultFrames ?? DEFAULT_NUM_FRAMES;
  assertLocalFrameContract({ model, mode, numFrames: resolvedNumFrames, icSkipStage2 });
  const assets = await resolveVideoModelAssets({ model, modelId, textEncoderId });

  // Only require the legacy mlx_video pythonPath when the chosen runtime
  // actually uses it. BYOV runtimes resolve their own venv path inside
  // buildArgs — gating them on the unrelated mlx_video setting locks users
  // out of the runtimes they just installed. Routes/videoGen.js reads the same
  // module-level set.
  if (!pythonPath && !BYOV_VIDEO_RUNTIMES.has(model.runtime)) {
    throw new ServerError('Python path not configured — set it in Media Gen Settings → Local', { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' });
  }
  // Every runner resolves its weights from a HuggingFace repo id EXCEPT the
  // legacy CUDA helper, which hardcodes Lightricks/LTX-Video. A user-edited
  // registry entry missing `repo` would otherwise pass `undefined` into spawn
  // args. Keyed on the runner rather than the platform, so a Windows BYOV
  // runtime — which does need its repo — is still held to it here.
  if (!routesToWindowsHelper(model) && (typeof model.repo !== 'string' || model.repo.length === 0)) {
    throw new ServerError(`Video model "${modelId}" is missing the required \`repo\` field in data/media-models.json`, { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
  }

  // Resolve LoRA basenames → absolute { path, strength } pairs up-front so a
  // missing/typo'd LoRA fails with a clean 400 before any GPU work. buildArgs
  // rejects LoRAs on runtimes without a compatible loader (the route also
  // guards), so this remains a no-op for those doomed jobs.
  const resolvedLoras = await resolveVideoLoras(loras, { probeEffect: true, runtime: model.runtime });
  // `model` was decorated from a SYNC cache read, which is false on a cold
  // cache. Resolve the probe and re-decorate from the settled verdict before
  // buildArgs reads it off the snapshot — otherwise the first LoRA render after
  // boot is refused on a capable install and only heals on retry.
  const loraCapableModel = resolvedLoras.length
    ? { ...model, runtimeLoraCapable: await resolveByovRuntimeLoraCapable(model.runtime) }
    : model;
  const icLoraWeightPath = await resolveLocalIcLoraWeight(mode);

  return {
    modelId, model, loraCapableModel, resolvedContinuation, sourceImagePath, resolvedLoras, icLoraWeightPath,
    width: dimensions.width, height: dimensions.height, numFrames: resolvedNumFrames, ...assets,
  };
}

// Resolves every numeric/derived knob the runner and the job record share:
// grid-snapped dimensions, seed/batch plan, speed profile,
// sampler schedule, and the i2v / IC-LoRA strengths. The returned names are the
// "actual" values; the raw request fields never reach `meta` or `buildParams`.
async function resolveLocalRenderPlan(params, inputs, jobId) {
  const {
    batchSize = 1, seed, fps = 24, steps, guidanceScale, uploadedTempPath = null, uploadedTempPaths, keyframes = null,
    extendFromVideoPath = null, audioFilePath = null, lastImagePath = null, mode = null, speedProfileId = null,
    imageStrength = null, i2vReferenceMode = null, icStrength = null, icAttentionStrength = null,
  } = params;
  const { model, width, height, numFrames, sourceImagePath, resolvedLoras } = inputs;
  // Most local runners use PortOS's shared 64px grid. H3's released canvas
  // resolver is explicitly 32px-aligned, including its native 21:9 height of
  // 672px; honor a model-declared step so that valid preset is not silently
  // floored to 640px at the final execution boundary.
  const declaredResolutionStep = Number(model.resolutionStep);
  const resolutionStep = Number.isInteger(declaredResolutionStep)
    && declaredResolutionStep > 0 && declaredResolutionStep <= 64
    ? declaredResolutionStep
    : 64;
  const w = Math.floor(Number(width) / resolutionStep) * resolutionStep;
  const h = Math.floor(Number(height) / resolutionStep) * resolutionStep;
  const batch = batchSize > 1 ? planVideoBatch({ jobId, batchSize, seed }) : null;
  const actualSeed = batch ? batch[0].seed : seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  // User-facing speed profile (#4875). Resolved BEFORE the sampler so it can
  // drive steps/guidance/stage-2 together — a half-applied schedule would make
  // the profile's speed claim false. `null` whenever the request is
  // incompatible (wrong mode, unpinned weights, samplerLocked model, unknown
  // id), in which case the render proceeds at its own default sampler and the
  // reason is logged rather than 400'd: a knob that only ever makes a render
  // faster must degrade, not reject.
  const { speedProfile, t2vTwoStage } = await resolveLocalSpeedProfile({
    model, jobId, speedProfileId, mode, keyframes, sourceImagePath, extendFromVideoPath, audioFilePath, lastImagePath,
    w, h, steps, guidanceScale, resolvedLoras, uploadedTempPath, uploadedTempPaths,
  });
  const sampler = resolveVideoSampler({ model, steps, guidanceScale, speedProfile });
  let actualSteps = sampler.steps;
  let actualGuidance = sampler.guidance;
  let actualStage2Steps = sampler.stage2Steps;
  logSpeedProfileSchedule({ speedProfile, jobId, steps: actualSteps, guidance: actualGuidance, stage2Steps: actualStage2Steps });
  // Opt-in T2V Standard two-stage perf experiment — overrides steps/guidance
  // (and adds an explicit stage-2 step count) only for a plain default text
  // render when PORTOS_T2V_TWO_STAGE is on. No-op otherwise. Skipped entirely
  // once a speed profile applied: the profile IS the user-chosen schedule, and
  // letting the env experiment overwrite it would silently render something
  // other than what the picker promised.
  if (t2vTwoStage) {
    actualGuidance = t2vTwoStage.guidance;
    actualSteps = t2vTwoStage.steps;
    actualStage2Steps = t2vTwoStage.stage2Steps;
    console.log(`🎬 PORTOS_T2V_TWO_STAGE on — T2V Standard via fast two-stage (${actualSteps}/${actualStage2Steps} steps, cfg ${actualGuidance}) [${jobId.slice(0, 8)}]`);
  }
  // Caller may pass null/'' to use the runtime's own default (1.0 = preserve
  // source). An unset strength under the "inspire" promise is the one exception:
  // "no value" there still has to mean "do not reproduce frame one", so the
  // contract substitutes its low default rather than deferring to a pipeline that
  // would anchor. An explicit slider value always wins on both modes.
  const effectiveReferenceMode = normalizeI2vReferenceMode(i2vReferenceMode);
  return {
    w, h, batch, actualSeed, speedProfile, t2vTwoStage, actualSteps, actualGuidance, actualStage2Steps,
    effectiveReferenceMode,
    actualImageStrength: resolveI2vReferenceStrength(effectiveReferenceMode, imageStrength),
    // IC-LoRA dials. `icStrength` weights the reference-video conditioning
    // channel (default 1.0 matches the pipeline); `icAttentionStrength` stays
    // null when unset so the pipeline applies its own default rather than us
    // pinning 1.0 and shadowing a future upstream change.
    actualIcStrength: icStrength != null && icStrength !== '' ? Number(icStrength) : 1.0,
    actualIcAttentionStrength: icAttentionStrength != null && icAttentionStrength !== ''
      ? Number(icAttentionStrength) : null,
    actualTextEncoderRepo: getTextEncoderRepo(),
    parsedNumFrames: Number(numFrames),
    parsedFps: Number(fps),
  };
}

// The "this render extends a source clip" splice contract handed to the watcher.
// A native Extend delivers the original source, not the model's re-decode of
// it. Chain chunks (`hidden`) are skipped — the chain trims the echoed context
// itself and a window hop's "source" is a temp tail clip — except a chain's
// FIRST chunk (`keepExtendSource`), whose source is the user's own clip. That
// chunk is spliced in place at its rendered length, so the chain's trim math
// and the tail window it cuts for chunk 1 are unaffected. Only a visible
// render keeps an audio master: a hidden chunk is never extended again.
function localExtendSplice({ model, mode, extendFromVideoPath, hidden, keepExtendSource, batch, parsedNumFrames }) {
  if (!(mode === 'extend' && extendFromVideoPath && (!hidden || keepExtendSource) && !batch && supportsContextWindow(model))) return null;
  return { runtime: model.runtime, sourcePath: extendFromVideoPath, extendLatents: extendLatentFrames(parsedNumFrames, model.runtime), keepMaster: !hidden };
}

// The argument bag `buildArgs` consumes. Resolved ("actual") values replace the
// raw request fields; passthrough fields keep the request's own value.
function buildLocalRunnerParams({ params, inputs, plan, media, renderPrompt, outputPath }) {
  const {
    pythonPath, negativePrompt = '', tiling = 'auto', disableAudio = false, extendFromVideoPath = null, audioFilePath = null,
    audioStartSec = null, mode = null, a2vLoraStageStrengths, referenceImagePaths = null, referenceVideoPaths = null,
    referenceAudioPaths = null, icSkipStage2 = false, streamingMode = null, continuityStrategy, contextFrames,
    historyContext = null,
  } = params;
  return {
    pythonPath,
    modelId: inputs.modelId,
    model: inputs.loraCapableModel,
    wanModelPath: inputs.wanModelPath,
    fastvideoModelPath: inputs.fastvideoModelPath,
    fastvideoOmniAssets: inputs.fastvideoOmniAssets,
    referenceImagePaths,
    referenceVideoPaths,
    referenceAudioPaths,
    wanRequiredWeights: inputs.wanRequiredWeights,
    ltxModelPath: inputs.ltxModelPath,
    ref2vaModelPath: inputs.ref2vaModelPath,
    prompt: renderPrompt,
    negativePrompt,
    width: plan.w,
    height: plan.h,
    numFrames: plan.parsedNumFrames,
    fps: plan.parsedFps,
    continuityStrategy, contextFrames, historyContext,
    steps: plan.actualSteps,
    stage2Steps: plan.actualStage2Steps,
    guidance: plan.actualGuidance,
    seed: plan.actualSeed,
    tiling,
    disableAudio,
    sourceImagePath: media.resolvedSourceImage,
    lastImagePath: media.resolvedLastImage,
    keyframes: media.resolvedKeyframes,
    extendFromVideoPath,
    audioFilePath,
    audioStartSec,
    mode,
    imageStrength: plan.actualImageStrength,
    i2vReferenceMode: plan.effectiveReferenceMode,
    a2vLoraStageStrengths,
    textEncoderRepo: plan.actualTextEncoderRepo,
    textEncoder: inputs.resolvedTextEncoder,
    outputPath,
    loras: inputs.resolvedLoras,
    icReferencePaths: media.resolvedIcReferencePaths,
    icLoraWeightPath: inputs.icLoraWeightPath,
    icStrength: plan.actualIcStrength,
    icAttentionStrength: plan.actualIcAttentionStrength,
    icSkipStage2,
    speedProfile: plan.speedProfile,
    streamingMode,
    ffmpegPath: media.ffmpeg,
    ffprobePath: media.ffprobe,
  };
}

async function renderLocalVideo(preparation, request) {
  // Callers may pass null/undefined; every downstream phase reads an array.
  const params = { ...request, uploadedTempPaths: Array.isArray(request.uploadedTempPaths) ? request.uploadedTempPaths : [] };
  const {
    prompt, negativePrompt = '', batchSize = 1, tiling = 'auto', disableAudio = false, audioConditioning = null,
    audioFilePath = null, mode = null, a2vLoraStageStrengths, extendFromVideoPath = null, keyframes = null,
    lastImagePath = null, icReferencePaths = null, referenceImagePaths = null, referenceVideoPaths = null,
    referenceAudioPaths = null, icSkipStage2 = false, streamingMode = null, visualConditioning = null, hidden = false,
    keepExtendSource = false, displaySleep = null, jobId: providedJobId = null, promptAdditions = [],
    executionParent = null, uploadedTempPath = null, uploadedTempPaths,
  } = params;
  const sourceAudioProvenance = audioConditioning == null ? null : federatedSourceAudioSchema.parse(audioConditioning);
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is now enforced by the mediaJobQueue worker upstream — only
  // one job is dequeued at a time, so we don't need a BUSY guard here. Direct
  // callers (legacy / tests) bypass the queue and would clobber the shared active process
  // on concurrent calls; that's an explicit "don't do that" contract.
  const inputs = await validateAndResolveLocalInputs(params);
  const { modelId, model, resolvedLoras, sourceImagePath } = inputs;

  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  // jobId may be supplied by the queue so SSE clients (which attached against
  // the queue's id) reach the same generation events.
  const jobId = providedJobId || randomUUID();

  // Weave each selected LoRA's activation token into the prompt the runner
  // actually receives (#4665) — a video LoRA whose trigger word never reaches
  // the model is loaded but inert, which reads to the user as "the LoRA didn't
  // work". Only the FIRST trigger word per LoRA is used, and one already in the
  // prompt is never duplicated. Done here rather than in the route so the chain
  // orchestrator's per-chunk beats (`chunkPrompts`) get the tokens too — each
  // chunk re-enters through this function with its own prompt.
  const loraLicenses = await readLoraLicensesByFilename(resolvedLoras.map((l) => l.filename));
  const { renderPrompt, addedTriggerWords, record: sentRecord } = await localVideoSentPrompt({
    prompt, negativePrompt, loraFilenames: resolvedLoras.map((l) => l.filename), promptAdditions,
  });
  if (addedTriggerWords.length) {
    console.log(`🔤 Video LoRA trigger words woven [${jobId.slice(0, 8)}]: ${addedTriggerWords.join(', ')}`);
  }
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const plan = await resolveLocalRenderPlan(params, inputs, jobId);
  const { w, h, batch, actualSeed, parsedNumFrames, parsedFps, speedProfile } = plan;

  const media = await prepareVideoConditioningMedia({
    model, mode, sourceImagePath, lastImagePath, keyframes, icReferencePaths,
    w, h, parsedFps, parsedNumFrames, jobId, uploadedTempPath, uploadedTempPaths, audioFilePath,
  });

  const createdAt = new Date().toISOString();
  const meta = buildLocalVideoJobRecord({
    jobId, batch, batchSize, prompt, negativePrompt, modelId, model, actualSeed, w, h, parsedNumFrames,
    parsedFps, actualSteps: plan.actualSteps, actualGuidance: plan.actualGuidance,
    actualStage2Steps: plan.actualStage2Steps, tiling, disableAudio, sourceAudioProvenance,
    resolvedTextEncoder: inputs.resolvedTextEncoder, filename, createdAt, mode,
    hasMultiKeyframes: media.hasMultiKeyframes, sourceImagePath,
    effectiveReferenceMode: plan.effectiveReferenceMode, actualImageStrength: plan.actualImageStrength,
    resolvedContinuation: inputs.resolvedContinuation, resolvedSourceImage: media.resolvedSourceImage,
    resolvedLastImage: media.resolvedLastImage, resolvedKeyframes: media.resolvedKeyframes, extendFromVideoPath,
    audioFilePath, resolvedIcReferencePaths: media.resolvedIcReferencePaths, visualConditioning,
    t2vTwoStage: plan.t2vTwoStage, speedProfile, a2vLoraStageStrengths,
    resolvedLoras, streamingMode, actualIcStrength: plan.actualIcStrength,
    actualIcAttentionStrength: plan.actualIcAttentionStrength, icSkipStage2, icReferencePaths,
    referenceImagePaths, referenceVideoPaths, referenceAudioPaths, loraLicenses, addedTriggerWords, renderPrompt,
    sentRecord, hidden,
  });
  await startPreparedLocalVideo({
    preparation, jobId, executionParent, meta, batch, cleanupTempFiles: media.cleanupTempFiles, displaySleep,
    buildParams: buildLocalRunnerParams({ params, inputs, plan, media, renderPrompt, outputPath }),
    watchParams: {
      encoder: inputs.resolvedTextEncoder,
      // Keeps this render's ETA samples in its own cost bucket — a speed profile
      // changes the slope, not just the step count.
      speedProfileId: speedProfile?.id ?? null,
      outputPath, filename, actualSeed, model, modelId, width: w, height: h, numFrames: parsedNumFrames,
      steps: plan.actualSteps,
      extendSplice: localExtendSplice({ model, mode, extendFromVideoPath, hidden, keepExtendSource, batch, parsedNumFrames }),
      lipsyncAlign: mode === 'a2v' && !batch,
    },
  });

  return { jobId, generationId: jobId, filename, mode: 'local', model: modelId };
}

// Owns everything between "conditioning media exists" and "the watcher owns the
// render": the preview directory, the running job record, argument construction
// and the watcher handoff. A failure before `spawnAndWatchVideo` is entered
// unwinds all of it here; once entered, the watcher is the single cleanup owner
// (its busy-claim, setup-error and child-terminal paths each release the same
// resources), so a throw out of it is rethrown untouched.
async function startPreparedLocalVideo({
  preparation, jobId, executionParent, meta, batch, cleanupTempFiles, displaySleep, buildParams, watchParams,
}) {
  const job = { ...meta, clients: [], status: 'running' };
  let stepwiseDir = null;
  let handedOff = false;
  try {
    await recordVideoExecution(jobId, { ...meta, ...(executionParent ? { executionParent } : {}), ...(batch ? { batchSeeds: batch.map(item => item.seed) } : {}) });
    // Each render gets one private preview directory. Runners overwrite the
    // fixed `preview.png` path atomically, so a long render cannot accumulate
    // one PNG per step and a stale preview can never cross job boundaries.
    stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-video-stepwise-'));
    videoJobState.jobs.set(jobId, job);

    // buildArgs throws synchronously on multi-keyframe pixel-budget overflow and
    // a few other validation paths; those failures converge with the allocation
    // and weight-download failures in the catch below.
    const { bin, args } = buildArgs({ ...buildParams, previewDir: stepwiseDir });
    if (batch) args.push('--batch-seeds', JSON.stringify(batch.map((item) => item.seed)));
    if (buildParams.textEncoder) {
      const { assertTextEncoderFilesComplete } = await import('./ensureWeights.js');
      await assertTextEncoderFilesComplete(buildParams.textEncoder);
    }
    if (buildParams.model.runtime === 'minimax_h3') {
      const { ensureMiniMaxH3Weights } = await import('./ensureWeights.js');
      await ensureMiniMaxH3Weights(buildParams.model, { cacheOnly: !!buildParams.speedProfile });
    }
    // Weights can take a long first-run download; honor a cancel that landed during it.
    preparation.throwIfCanceled();
    // This render's own choice (the `displaySleep` request field) wins over
    // the install-wide settings default so a page reload/resume replays the
    // choice the user actually made, not whatever Settings holds now.
    const videoGenSettings = {
      ...(await getSettings())?.videoGen,
      ...(displaySleep != null ? { displaySleep } : {}),
    };

    handedOff = true;
    await spawnAndWatchVideo({
      jobId, executionParent, preparation, batch, cleanupTempFiles, stepwiseDir, job, bin, args, meta, videoGenSettings, ...watchParams,
    });
  } catch (err) {
    if (handedOff) throw err;
    const canceled = preparation.wasCanceled();
    await recordVideoExecutionDiagnostics(jobId, { termination: {
      exitCode: null, signal: null, reason: canceled ? 'canceled' : 'refused', observedAt: new Date().toISOString(),
    } }, ...(executionParent ? [executionParent] : [])).catch(error => console.error(`❌ Video preparation evidence persistence failed [${jobId.slice(0, 8)}]: ${error.message}`));
    const cleanup = await Promise.allSettled([
      cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true }),
      stepwiseDir ? rmGuarded(stepwiseDir, { recursive: true, force: true }) : undefined,
    ]);
    if (cleanup.some(result => result.status === 'rejected')) {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
    }
    if (canceled) {
      dispatchCanceledJob(job, jobId, 'Video preparation', () => videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled' }));
    } else {
      job.status = 'error';
      const reason = err.message || 'Failed to prepare video generation';
      console.error(`❌ Video generation preparation error [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: reason });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason, failure: normalizeVideoFailure(err, { prompts: [meta.prompt, meta.negativePrompt] }) });
    }
    closeJobAfterDelay(videoJobState.jobs, jobId);
    throw err;
  }
}

// Pre-spawn work (weight download, memory preparation) runs with no child to
// signal, so cancel() answers 'pending' and the spawn gates abort the render.
export async function generateVideo(params) {
  const preparation = beginPreparation();
  try {
    return await renderLocalVideo(preparation, params);
  } finally {
    preparation.end();
  }
}
