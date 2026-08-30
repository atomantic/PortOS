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

import { execFile } from '../../lib/childProcess.js';
import { unlink, rm, mkdtemp } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  isDefaultI2vReferenceMode, normalizeI2vReferenceMode, resolveI2vReferenceStrength,
} from '../../lib/videoReferenceModes.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { getVideoModels, getDefaultVideoModelId, getTextEncoderRepo } from '../../lib/mediaModels.js';
import {
  captureSystemCapabilities,
  detectSystemCapabilities,
  isHardwareCompatible,
  withHardwareCompatibility,
} from '../../lib/systemCapabilities.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { inspectModelCache, findCachedRepoFile, findCachedRepoFiles } from '../../lib/hfCache.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { describeRenderConditioning, RENDER_INPUTS_VERSION } from './generateVideoHelpers.js';
import { readTriggerWordsByFilename } from '../loras.js';
import { weaveLoraTriggers } from '../../lib/loraTriggers.js';
import { isLtx2FamilyRuntime } from '../../lib/runners.js';
import {
  publicVideoTextEncoderOptions, resolveVideoTextEncoder,
} from '../../lib/videoTextEncoders.js';
import {
  isIcLoraMode, icLoraSpecForMode, resolveIcLoraWeight,
} from '../../lib/icLoraWeights.js';
import {
  BYOV_VIDEO_RUNTIMES,
  byovRuntimeLoraCapable,
  resolveByovRuntimeLoraCapable,
  modelAnchorsLastFrame,
  routesToWindowsHelper,
  byovRuntimeExpectedRevision,
  isByovRuntimeCurrent,
} from './runtimes.js';
import { loadHistory, saveHistory, mutateVideoHistory, getHistoryItem } from './history.js';
import { VIDEO_MODE_GATED_RUNTIMES } from './modeContract.js';
import { videoJobState } from './jobState.js';
import {
  assertRenderModeContract,
  buildArgs,
  DEFAULT_NUM_FRAMES,
  IC_STILL_REFERENCE_FRAMES,
  resolveVideoDimensions,
  resolveVideoLoras,
  resolveT2vTwoStageOverride,
} from './renderArgs.js';
import { spawnAndWatchVideo } from './spawnWatch.js';
import {
  resolveVideoSpeedProfile, speedProfileDeclineReason, resolveVideoSampler,
  inferEffectiveVideoMode,
} from '../../lib/videoSpeedProfiles.js';
import {
  isFullDecode,
  publicVideoDraftDecodeOptions,
  draftDecodeDeclineReason,
  resolveVideoDraftDecoder,
} from '../../lib/videoDraftDecoders.js';
// Re-export the extracted runtime + history surface so existing deep imports
// (`from '../videoGen/local.js'`) keep resolving every symbol they used to.
export * from './runtimes.js';
export * from './modeContract.js';
export * from './eta.js';
export {
  computeFflfLtx2PixelBudget,
  resolveFflfLtx2PixelBudget,
  computeFflfSafeFrames,
  resolveT2vTwoStageOverride,
  resolveVideoLoras,
  icLoraArgs,
  ltx25TextEncoderArgs,
  DEFAULT_NUM_FRAMES,
  IC_STILL_REFERENCE_FRAMES,
} from './renderArgs.js';
export { attachSseClient, cancel } from './jobState.js';
export { loadHistory, saveHistory, mutateVideoHistory, getHistoryItem };

const execFileAsync = promisify(execFile);

// Catalog comes from data/media-models.json (see server/lib/mediaModels.js).
// Cached as a plain object at boot for O(1) lookup by id, matching the prior shape.
// NOTE: this is a BOOT snapshot — a model added at runtime via the HuggingFace
// installer (mediaModels.addUserModelEntry hot-reloads the registry cache) is
// NOT in here. Render-time lookups must go through resolveVideoModel() so a
// just-added model is renderable without a restart (issue #2124). Kept exported
// for back-compat with any deep importer.
export const VIDEO_MODELS = Object.fromEntries(getVideoModels().map((m) => [m.id, m]));

// Resolve a model by id from the LIVE registry (getVideoModels reads the
// hot-reloadable cache), falling back to the boot snapshot. This is what the
// render path uses so a runtime-added model resolves without a server restart.
// Attach the runtime capabilities a model entry can't express on its own:
// whether an FFLF last frame is a real anchor, and whether the *installed* BYOV
// runner can apply user LoRAs (H3's DiT is quantized, so that depends on the
// pinned checkout plus PortOS's activation-space adapter — see runtimes.js
// `loraProbeArgs`). Both are declared in
// runtimes.js and surfaced here so the Video Gen form and videoLoraFamily() read
// them off the model instead of keeping their own lists. Applied by BOTH model
// resolvers, so the render path and the API payload can never disagree about
// what a model supports.
// Also attached: the substitutable prompt conditioners the model's runtime can
// load (lib/videoTextEncoders.js). Decorated rather than declared on the
// registry entry so the picker can never offer an option this build's runner
// has no key-remap for — and empty for every runtime without substitutions, so
// the client renders no picker instead of a one-entry select.
const decorateVideoModel = (m) => (m ? {
  ...m,
  lastFrameAnchored: modelAnchorsLastFrame(m),
  runtimeLoraCapable: byovRuntimeLoraCapable(m.runtime),
  textEncoderOptions: publicVideoTextEncoderOptions(m),
  // The preview-fidelity decode choices this entry offers
  // (lib/videoDraftDecoders.js). Empty for every model that declares no draft
  // decoder, so the client renders no control instead of a one-entry select.
  draftDecodeOptions: publicVideoDraftDecodeOptions(m),
} : m);

export const resolveVideoModel = (modelId) =>
  decorateVideoModel(getVideoModels().find((m) => m.id === modelId) || VIDEO_MODELS[modelId] || null);

export const listVideoModels = () => getVideoModels().map(decorateVideoModel);

export const defaultVideoModelId = (capabilities) => getDefaultVideoModelId(capabilities);

export async function generateVideo({ pythonPath, prompt, negativePrompt = '', modelId, width = null, height = null, numFrames = null, fps = 24, steps, guidanceScale, seed, tiling = 'auto', disableAudio = false, sourceImagePath = null, uploadedTempPath = null, uploadedTempPaths = [], lastImagePath = null, keyframes = null, extendFromVideoPath = null, audioFilePath = null, audioStartSec = null, mode = null, imageStrength = null, i2vReferenceMode = null, loras = null, icReferencePaths = null, icStrength = null, icAttentionStrength = null, icSkipStage2 = false, textEncoderId = null, speedProfileId = null, draftDecode = null, visualConditioning = null, hidden = false, jobId: providedJobId = null }) {
  uploadedTempPaths = Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [];
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is now enforced by the mediaJobQueue worker upstream — only
  // one job is dequeued at a time, so we don't need a BUSY guard here. Direct
  // callers (legacy / tests) bypass the queue and would clobber the shared active process
  // on concurrent calls; that's an explicit "don't do that" contract.

  const needsCuda = (requirements) => requirements?.requiresNvidiaGpu
    || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null;
  let capabilities = captureSystemCapabilities();
  // `undefined`/empty means the caller omitted the field and may use the
  // configured default. Explicit null is a routed-job sentinel and must remain
  // an unknown model so an older dispatcher cannot render a remote job locally.
  const modelWasOmitted = modelId === undefined || modelId === '';
  let selectedModelId = modelWasOmitted ? defaultVideoModelId(capabilities) : modelId;
  let resolvedModel = resolveVideoModel(selectedModelId);
  if (needsCuda(resolvedModel?.hardwareRequirements)) {
    capabilities = await detectSystemCapabilities();
    if (modelWasOmitted) selectedModelId = defaultVideoModelId(capabilities);
    resolvedModel = resolveVideoModel(selectedModelId);
  }
  modelId = selectedModelId;
  const model = resolvedModel && withHardwareCompatibility(
    resolvedModel,
    capabilities,
    resolvedModel.hardwareRequirements,
  );
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  if (!isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      `Video model "${modelId}" is unavailable on this machine: ${model.hardwareCompatibility.reasons.join(' · ')}`,
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
    model,
    mode,
    sourceImagePath,
    lastImagePath,
    keyframes,
    extendFromVideoPath,
    audioFilePath,
    audioStartSec,
    icReferencePaths,
  });
  // Registry defaults are user-editable. Validate them at this internal-call
  // boundary so an empty or malformed value cannot turn into a 0/NaN runner
  // argument when the caller deliberately leaves the resolution unset.
  ({ width, height } = resolveVideoDimensions(model, width, height));
  numFrames = numFrames ?? model.defaultFrames ?? DEFAULT_NUM_FRAMES;
  let wanModelPath = null;
  const wanRequiredWeights = [];
  if (model.runtime === 'wan22') {
    const frameStride = Number(model.frameStride);
    if (Number.isFinite(frameStride) && frameStride > 0 && (Number(numFrames) - 1) % frameStride !== 0) {
      throw new ServerError(
        `${model.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
        { status: 400, code: 'WAN22_INVALID_FRAME_COUNT' },
      );
    }
    if (typeof model.revision !== 'string' || !model.revision) {
      throw new ServerError(
        `Wan model "${modelId}" is missing an immutable Hugging Face revision.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    const baseCache = await inspectModelCache(model.repo, { revision: model.revision });
    if (!baseCache.cached || !baseCache.snapshotPath) {
      throw new ServerError(
        `${model.name} revision ${model.revision.slice(0, 8)} is not fully cached. Download or repair it in Video Gen before rendering.`,
        { status: 400, code: 'WAN22_MODEL_NOT_CACHED' },
      );
    }
    wanModelPath = baseCache.snapshotPath;
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
  if (model.runtime === 'fastvideo') {
    if (typeof model.revision === 'string' && model.revision) {
      const baseCache = await inspectModelCache(model.repo, { revision: model.revision });
      if (!baseCache.cached || !baseCache.snapshotPath) {
        throw new ServerError(
          `${model.name} revision ${model.revision.slice(0, 8)} is not fully cached. Download or repair it in Video Gen before rendering.`,
          { status: 400, code: 'FASTVIDEO_MODEL_NOT_CACHED' },
        );
      }
      wanModelPath = baseCache.snapshotPath;
    } else {
      const baseCache = await inspectModelCache(model.repo);
      if (baseCache.cached && baseCache.snapshotPath) {
        wanModelPath = baseCache.snapshotPath;
      }
    }
  }
  // Pinned LTX family entries (LTX-2.5 today) must render the verified
  // snapshot, not whatever `main` snapshot_download would follow. Unpinned
  // 2.3 entries keep passing the repo id so the helper's existing Hub resolve
  // stays unchanged.
  let ltxModelPath = model.repo;
  if (isLtx2FamilyRuntime(model.runtime) && typeof model.revision === 'string' && model.revision) {
    const cache = await inspectModelCache(model.repo, { revision: model.revision });
    if (!cache.cached || !cache.snapshotPath) {
      throw new ServerError(
        `${model.name} revision ${model.revision.slice(0, 8)} is not fully cached. Download or repair it in Video Gen before rendering.`,
        { status: 400, code: 'LTX2_MODEL_NOT_CACHED' },
      );
    }
    ltxModelPath = cache.snapshotPath;
  }
  let ref2vaModelPath = null;
  if (model.runtime === 'minimax_h3_ref2va') {
    if (typeof model.revision !== 'string' || !model.revision) {
      throw new ServerError(
        `MiniMax H3 Ref2VA model "${modelId}" is missing an immutable Hugging Face revision.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    const cache = await inspectModelCache(model.repo, { revision: model.revision });
    if (!cache.cached || !cache.snapshotPath) {
      throw new ServerError(
        `${model.name} revision ${model.revision.slice(0, 8)} is not fully cached. Download or repair it in Video Gen before rendering.`,
        { status: 400, code: 'MINIMAX_H3_REF2VA_MODEL_NOT_CACHED' },
      );
    }
    ref2vaModelPath = cache.snapshotPath;
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

  // Only require the legacy mlx_video pythonPath when the chosen runtime
  // actually uses it. BYOV runtimes resolve their own venv path inside
  // buildArgs — gating them on the unrelated mlx_video setting locks users
  // out of the runtimes they just installed. Routes/videoGen.js reads the same
  // module-level set.
  if (!pythonPath && !BYOV_VIDEO_RUNTIMES.has(model.runtime)) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' });
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

  // IC-LoRA remix: resolve the per-mode weight before any GPU work. A cached
  // weight resolves to the exact file inside the HF snapshot; an un-cached one
  // falls back to the repo id, which ICLoraPipeline downloads itself — log that
  // so a several-hundred-MB pull mid-render isn't a mystery in the server log.
  let icLoraWeightPath = null;
  if (isIcLoraMode(mode)) {
    const resolved = await resolveIcLoraWeight(mode);
    if (!resolved) {
      throw new ServerError(`Unknown IC-LoRA remix mode: ${mode}`, { status: 400, code: 'IC_LORA_UNKNOWN_MODE' });
    }
    icLoraWeightPath = resolved.path;
    if (!resolved.cached && resolved.path) {
      console.log(`⬇️  IC-LoRA weight not cached — ${resolved.spec.repo} will download at render time`);
    }
    // A null path means the registry deliberately refused the repo-id fallback
    // (requiresPreDownload). icLoraArgs turns that into the user-facing 400; log
    // the reason here so the server log explains WHY there's no auto-download.
    if (!resolved.path) {
      console.log(`⛔ IC-LoRA weight for ${mode} needs an explicit download (auto-fetch would snapshot ${resolved.spec.mirrorRepo || resolved.spec.repo})`);
    }
  }

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
  const triggerWordsByLora = await readTriggerWordsByFilename(resolvedLoras.map((l) => l.filename));
  const { prompt: renderPrompt, added: addedTriggerWords } = weaveLoraTriggers(
    prompt,
    resolvedLoras.map((l) => triggerWordsByLora[l.filename]),
  );
  if (addedTriggerWords.length) {
    console.log(`🔤 Video LoRA trigger words woven [${jobId.slice(0, 8)}]: ${addedTriggerWords.join(', ')}`);
  }
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
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
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  // User-facing speed profile (#4875). Resolved BEFORE the sampler so it can
  // drive steps/guidance/stage-2 together — a half-applied schedule would make
  // the profile's speed claim false. `null` whenever the request is
  // incompatible (wrong mode, unpinned weights, samplerLocked model, unknown
  // id), in which case the render proceeds at its own default sampler and the
  // reason is logged rather than 400'd: a knob that only ever makes a render
  // faster must degrade, not reject.
  //
  // Resolved against the mode the runner will actually INFER, not the raw
  // (possibly absent) request field: buildLtx2Args derives fflf from keyframes
  // and image from a source frame, so gating on a bare `mode` would hand a
  // two-stage schedule to a KeyframeInterpolation render for any direct caller
  // that omits it (Writers Room batch dispatch, scripts).
  const speedProfileMode = inferEffectiveVideoMode({
    mode, keyframes, sourceImagePath, extendFromVideoPath, audioFilePath,
  });
  const speedProfile = resolveVideoSpeedProfile({ model, profileId: speedProfileId, mode: speedProfileMode });
  const speedProfileDeclined = speedProfile ? null : speedProfileDeclineReason({ model, profileId: speedProfileId, mode: speedProfileMode });
  if (speedProfileDeclined) {
    console.log(`⚠️ Speed profile declined [${jobId.slice(0, 8)}] ${speedProfileDeclined.code}: ${speedProfileDeclined.message}`);
  }
  // Preview-fidelity video decode (#5423). Every gate lives in
  // lib/videoDraftDecoders.js and RETURNS its reason; the render always
  // proceeds, on the full decoder, because a decode substitution only ever
  // makes a render cheaper. Resolved here rather than in the arg builder for
  // the same reason the substituted conditioner is: a missing download has to
  // be discovered before any GPU work, and the decision has to be recorded on
  // the history row.
  //
  // Two gates need I/O and so cannot live in the pure module: whether the
  // installed runner checkout is the revision the asset was verified against
  // (an older one ignores the flags, which would let a full decode report
  // itself as a draft), and whether the pinned files are actually in the HF
  // cache. Both are only probed when a draft decode was requested AND the model
  // declares one, so a full-decode render costs nothing extra.
  let draftDecoder = null;
  if (!isFullDecode(draftDecode)) {
    const declared = model.draftDecoder;
    const runtimeRevision = (declared && await isByovRuntimeCurrent(model.runtime))
      ? byovRuntimeExpectedRevision(model.runtime)
      : null;
    // Only probed once the cheaper gates have passed — a model with no
    // declaration, or a checkout at the wrong revision, never touches the cache.
    const decoderPaths = (declared && runtimeRevision === declared.runtimeRevision)
      ? await findCachedRepoFiles(declared.repo, declared.files, { revision: declared.revision })
      : null;
    const gateArgs = {
      model,
      models: getVideoModels(),
      decodeId: draftDecode,
      runtimeRevision,
      assetCached: Array.isArray(decoderPaths) && decoderPaths.length > 0,
    };
    const resolved = resolveVideoDraftDecoder(gateArgs);
    if (resolved) {
      draftDecoder = { ...resolved, paths: decoderPaths };
      console.log(`🩻 Draft decode "${resolved.id}" [${jobId.slice(0, 8)}] via ${resolved.label}`);
    } else {
      const declined = draftDecodeDeclineReason(gateArgs);
      console.log(`⚠️ Draft decode declined [${jobId.slice(0, 8)}] ${declined?.code || 'UNKNOWN'}: ${declined?.message || 'rendering on the full decoder'}`);
    }
  }

  const sampler = resolveVideoSampler({ model, steps, guidanceScale, speedProfile });
  let actualSteps = sampler.steps;
  let actualGuidance = sampler.guidance;
  let actualStage2Steps = sampler.stage2Steps;
  if (speedProfile) {
    console.log(`⚡ Speed profile "${speedProfile.id}" [${jobId.slice(0, 8)}]: ${actualSteps}+${actualStage2Steps} steps, cfg ${actualGuidance}${speedProfile.teacache ? ', teacache' : ''}`);
  }
  // Opt-in T2V Standard two-stage perf experiment — overrides steps/guidance
  // (and adds an explicit stage-2 step count) only for a plain default text
  // render when PORTOS_T2V_TWO_STAGE is on. No-op otherwise. Skipped entirely
  // once a speed profile applied: the profile IS the user-chosen schedule, and
  // letting the env experiment overwrite it would silently render something
  // other than what the picker promised.
  const t2vTwoStage = speedProfile ? null : resolveT2vTwoStageOverride({
    runtime: model.runtime, mode, guidanceScale, steps,
    sourceImagePath, uploadedTempPath, uploadedTempPaths,
    keyframes, extendFromVideoPath, audioFilePath,
  });
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
  const actualImageStrength = resolveI2vReferenceStrength(effectiveReferenceMode, imageStrength);
  // IC-LoRA dials. `icStrength` weights the reference-video conditioning
  // channel (default 1.0 matches the pipeline); `icAttentionStrength` stays
  // null when unset so the pipeline applies its own default rather than us
  // pinning 1.0 and shadowing a future upstream change.
  const actualIcStrength = icStrength != null && icStrength !== '' ? Number(icStrength) : 1.0;
  const actualIcAttentionStrength = icAttentionStrength != null && icAttentionStrength !== ''
    ? Number(icAttentionStrength) : null;
  const actualTextEncoderRepo = getTextEncoderRepo();
  const parsedNumFrames = Number(numFrames);
  const parsedFps = Number(fps);

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
  const ffmpeg = (sourceImagePath || lastImageWillBeUsed || hasMultiKeyframes) ? await findFfmpeg() : null;
  const ffprobe = model.runtime === 'minimax_h3_ref2va' ? await findFfprobe() : null;
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
    // The route validates shape, but a non-route caller (test, persisted
    // queue replay, future internal API) could pass malformed entries.
    // Fail fast with a clear error instead of letting `undefined` paths
    // flow into ffmpeg or the Python helper, where the failure is opaque.
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
  // known after the 64-flooring above, and it mirrors resizeImage's contract:
  // temp paths are tracked for the same cleanup sites.
  const icReferenceTempPaths = [];
  let resolvedIcReferencePaths = icReferencePaths;
  // Both throw sites in this block land BEFORE the buildArgs try/catch below
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
    return Promise.all(paths.filter(Boolean).map((path) => unlink(path).catch(() => {})));
  };
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
    resolvedIcReferencePaths = clipPaths;
  }

  const meta = {
    id: jobId,
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
    // Which prompt conditioner read this prompt. Only recorded when it wasn't
    // the stock one, so pre-feature history and every unswapped render stay
    // byte-identical — and so a Remix of a stock render can't resurrect an
    // override the user has since deselected.
    ...(resolvedTextEncoder ? { textEncoderId: resolvedTextEncoder.id } : {}),
    filename,
    createdAt: new Date().toISOString(),
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
    // Preview-fidelity decode (#5423). Recorded as the REQUESTED id, so a Remix
    // round-trips the decode the user picked, and so the lightbox can say which
    // decoder produced the pixels being judged. Absent on a full decode, which
    // keeps every pre-feature history row byte-identical — and, because a
    // declined request never sets it, a record can never claim a draft decode
    // the render did not perform.
    ...(draftDecoder ? { draftDecode: draftDecoder.id } : {}),
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
    // Provenance for the trigger weave (#4665). `prompt` above stays the user's
    // own text, so Remix re-derives triggers from whatever LoRAs are selected
    // then instead of compounding this render's clause; these two record what
    // was actually rendered. Present only when something was woven, so every
    // other history row stays byte-identical to pre-feature renders.
    ...(addedTriggerWords.length ? { renderPrompt, addedTriggerWords } : {}),
    ...(hidden ? { hidden: true } : {}),
  };
  // Each render gets one private preview directory. Runners overwrite the
  // fixed `preview.png` path atomically, so a long render cannot accumulate
  // one PNG per step and a stale preview can never cross job boundaries.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-video-stepwise-'));
  const job = { ...meta, clients: [], status: 'running' };
  videoJobState.jobs.set(jobId, job);

  // buildArgs now throws synchronously on multi-keyframe pixel-budget
  // overflow and a few other validation paths — without this guard the
  // job would stay "running" forever in the shared jobs map and the resized
  // temp files would leak (the spawn close-handler that normally cleans
  // them up never runs because we never spawned). Mirror the cleanup
  // logic of the spawn-error handler so failure modes converge.
  let bin, args;
  try {
    ({ bin, args } = buildArgs({
      pythonPath,
      modelId,
      model: loraCapableModel,
      wanModelPath,
      wanRequiredWeights,
      ltxModelPath,
      ref2vaModelPath,
      prompt: renderPrompt,
      negativePrompt,
      width: w,
      height: h,
      numFrames: parsedNumFrames,
      fps: parsedFps,
      steps: actualSteps,
      stage2Steps: actualStage2Steps,
      guidance: actualGuidance,
      seed: actualSeed,
      tiling,
      disableAudio,
      sourceImagePath: resolvedSourceImage,
      lastImagePath: resolvedLastImage,
      keyframes: resolvedKeyframes,
      extendFromVideoPath,
      audioFilePath,
      audioStartSec,
      mode,
      imageStrength: actualImageStrength,
      i2vReferenceMode: effectiveReferenceMode,
      textEncoderRepo: actualTextEncoderRepo,
      textEncoder: resolvedTextEncoder,
      outputPath,
      previewDir: stepwiseDir,
      loras: resolvedLoras,
      icReferencePaths: resolvedIcReferencePaths,
      icLoraWeightPath,
      icStrength: actualIcStrength,
      icAttentionStrength: actualIcAttentionStrength,
      icSkipStage2,
      speedProfile,
      draftDecoder,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
    }));
  } catch (err) {
    job.status = 'error';
    const reason = err.message || 'Failed to build video gen args';
    console.log(`❌ Video generation buildArgs error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    void cleanupTempFiles({ includeUploads: true, includeUntrackedAudio: true });
    void rm(stepwiseDir, { recursive: true, force: true });
    closeJobAfterDelay(videoJobState.jobs, jobId);
    throw err;
  }

  await spawnAndWatchVideo({
    jobId,
    // Keeps this render's ETA samples in its own cost bucket — a speed profile
    // changes the slope, not just the step count.
    speedProfileId: speedProfile?.id ?? null,
    cleanupTempFiles,
    stepwiseDir,
    job,
    bin,
    args,
    outputPath,
    filename,
    meta,
    actualSeed,
    model,
    modelId,
    width: w,
    height: h,
    numFrames: parsedNumFrames,
    steps: actualSteps,
  });

  return { jobId, generationId: jobId, filename, mode: 'local', model: modelId };
}
