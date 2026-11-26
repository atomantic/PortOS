import { isDefaultA2vLoraStages } from '../../../lib/videoLoraStageValidation.js';
import { existsSync } from 'fs';
import { totalmem } from 'os';
import { ServerError } from '../../../lib/errorHandler.js';
import { isDefaultI2vReferenceMode, normalizeI2vReferenceMode } from '../../../lib/videoReferenceModes.js';
import { isDefaultVideoStreamingMode } from '../../../lib/videoStreamingMode.js';
import { extendLatentFrames } from '../../../lib/videoContinuity.js';
import { isLtx2FamilyRuntime } from '../../../lib/runners.js';
import { isIcLoraMode, icLoraSpecForMode, icLoraSupportsRuntime, icLoraFrameIssue } from '../../../lib/icLoraWeights.js';
import {
  LTX2_HELPER_SCRIPT,
  LTX25_ENCODER_SHIM_DIR,
  LTX25_VENV_PYTHON,
  LTX25_UPSCALE_HELPER_SCRIPT,
  LTX25_CUDA_VENV_PYTHON,
  LTX25_CUDA_HELPER_SCRIPT,
  LTX25_CUDA_UPSCALE_HELPER_SCRIPT,
  BYOV_RUNTIME_INFO,
  assertByovRuntimeInstalled,
} from '../runtimes.js';
import { assertRenderModeContract } from '../modeContract.js';
import { icLoraArgs } from './loras.js';

// FFLF/ltx2 stage-2 peak memory scales with the pixel-frame count
// (width × height × numFrames), so the cap is on that product. Anchors are
// measured on real renders:
//   •  48 GB unified RAM → 704×448×25 ≈ 7.9M pixel-frames is the largest that
//      fits stage 2 (704×448×97 OOMs there). This is the tested-safe value.
//   • 128 GB unified RAM → 768×512×97 ≈ 38.1M pixel-frames renders comfortably
//      (validated for issue #737). 97 frames is the threshold below which FFLF
//      interpolation visibly strobes (frames advance in near-duplicate pairs),
//      so a budget that can't reach 97 frames at a usable resolution forces the
//      poor-motion regime — the whole reason this scales with RAM now.
// HOLD the tested-safe value through 64 GB, THEN ramp 64→128 GB up to the
// validated value. The stage-2 path is documented to OOM on 64 GB Macs at full
// resolution (see buildLtx2Args below), so the 48–64 GB band keeps EXACTLY the
// previously-shipped cap — no machine that already ran is handed a larger,
// untested budget. The bump is reserved for the headroom above 64 GB, and the
// curve only ever raises the cap, never lowers it. FFLF_LTX2_PIXEL_BUDGET
// overrides entirely (raise it on a roomy box, lower it if a render OOMs).
const FFLF_BUDGET_FLOOR = 704 * 448 * 25; //  7,884,800 — tested-safe (held ≤64 GB)
const FFLF_BUDGET_128GB = 768 * 512 * 97; // 38,141,952 — validated on 128 GB (#737)
const FFLF_RAMP_START_GB = 64; // below this, hold the floor (64 GB Macs OOM at full res)
const FFLF_BUDGET_SLOPE = (FFLF_BUDGET_128GB - FFLF_BUDGET_FLOOR) / (128 - FFLF_RAMP_START_GB); // px-frames/GB above 64
const BYTES_PER_GB = 1024 ** 3;

// Pure: pixel-frame budget for a machine with `totalMemBytes` of unified RAM.
// Held at the tested-safe floor through 64 GB, then linear to the 128 GB anchor.
// Exported for unit testing; resolveFflfLtx2PixelBudget wraps it with os.totalmem().
export const computeFflfLtx2PixelBudget = (totalMemBytes) => {
  const gb = Number(totalMemBytes) / BYTES_PER_GB;
  if (!(gb > 0)) return FFLF_BUDGET_FLOOR;
  const overRamp = Math.max(0, gb - FFLF_RAMP_START_GB);
  return Math.round(FFLF_BUDGET_FLOOR + overRamp * FFLF_BUDGET_SLOPE);
};

// Effective FFLF/ltx2 stage-2 pixel-frame budget. FFLF_LTX2_PIXEL_BUDGET wins
// (raise it on a big box, or lower it if a render OOMs); otherwise scale to
// detected unified memory. This is the SINGLE source of truth for the cap —
// `buildLtx2Args` enforces it server-side AND the /status route advertises it
// so the client can gate keyframe indices before submit (see computeFflfSafeFrames).
export const resolveFflfLtx2PixelBudget = () => {
  const envBudget = Number(process.env.FFLF_LTX2_PIXEL_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0) return envBudget;
  return computeFflfLtx2PixelBudget(totalmem());
};

// Back-solve the largest numFrames that fits `budget` at this resolution,
// rounded DOWN to the LTX 8k+1 latent boundary (so the model doesn't silently
// snap). Returns the input numFrames unchanged when it already fits. Pure and
// shared: the server clamps with it, the client mirrors it to validate keyframe
// indices against the same cap the worker will enforce.
export const computeFflfSafeFrames = (width, height, numFrames, budget = resolveFflfLtx2PixelBudget()) => {
  const wh = Number(width) * Number(height);
  const nf = Number(numFrames);
  if (!(wh > 0) || !(nf > 0) || !(budget > 0)) return nf;
  if (wh * nf <= budget) return nf;
  const safeRaw = Math.floor(budget / wh);
  const safeLatent = Math.max(1, Math.floor((safeRaw - 1) / 8));
  return safeLatent * 8 + 1;
};

// Env-gated LTX-2 T2V "two-stage" perf experiment (PORTOS_T2V_TWO_STAGE).
//
// Phosphene found that routing a plain T2V Standard render through the
// two-stage pipeline at a fast half-res config (8 stage-1 + 3 stage-2 steps,
// cfg 1.0) cuts ~30-35% of wall time. This DECISION has to live on the Node
// side, not in generate_ltx2.py: buildLtx2Args always emits `--cfg-scale`
// from model.guidance, so the Python helper can't tell a defaulted guidance
// from one the user set on purpose. Here we still know.
//
// Returns the override `{ guidance, steps, stage2Steps }` only when ALL hold:
// the runtime is ltx2, it's a no-conditioning text render, the user left
// guidance AND steps at their defaults (so we only ever hijack the "Standard"
// render, never a customized one), and the env knob is truthy. Otherwise null
// (no change → existing behavior). Pure + exported so it's unit-tested
// directly, mirroring the FFLF pixel-budget helpers above.
export const resolveT2vTwoStageOverride = ({
  runtime, mode, guidanceScale, steps,
  sourceImagePath, uploadedTempPath, uploadedTempPaths,
  keyframes, extendFromVideoPath, audioFilePath,
  env = process.env,
}) => {
  const enabled = ['1', 'true', 'yes', 'on']
    .includes(String(env.PORTOS_T2V_TWO_STAGE ?? '').trim().toLowerCase());
  if (!enabled || !isLtx2FamilyRuntime(runtime)) return null;
  // Only the default text mode — anything explicitly fflf/a2v/extend/image
  // is conditioned and out of scope for the T2V Standard experiment.
  if (mode != null && mode !== 'text') return null;
  // Customized renders opt out — the experiment is the Standard render only.
  const userSetGuidance = guidanceScale != null && guidanceScale !== '';
  const userSetSteps = !!steps;
  if (userSetGuidance || userSetSteps) return null;
  // Any conditioning input makes this not a plain T2V. This is a strict
  // subset of buildLtx2Args's helperMode==='text' inference — never broader —
  // so the experiment declines rather than over-fires on an edge case.
  const hasConditioning = !!sourceImagePath || !!uploadedTempPath
    || (Array.isArray(uploadedTempPaths) && uploadedTempPaths.length > 0)
    || (Array.isArray(keyframes) && keyframes.length > 0)
    || !!extendFromVideoPath || !!audioFilePath;
  if (hasConditioning) return null;
  return { guidance: 1.0, steps: 8, stage2Steps: 3 };
};

/**
 * Shim flags for a substituted LTX-2.5 prompt conditioner (#4320), or `[]` for
 * the stock choice — so an unswapped render's argv is byte-identical to what it
 * was before the feature existed.
 *
 * A 2.5 pack's own Gemma 4 tower wins unconditionally inside the pinned fork
 * (`PromptEncoder._text_encoder_source` ignores `gemma_model_id` whenever the
 * pack ships a local `text_encoder/` reporting `model_type: "gemma4"`), so the
 * substitution is a shim directory the runner builds and then points that
 * resolution at — NOT a repo id on `--gemma`, which is why this shares no flag
 * with the ltx2 path. `textEncoder.paths` were already resolved against the HF
 * cache by generateVideo; the helper runs offline and never downloads.
 *
 * `--text-encoder-config-json` is emitted only when the entry declares
 * `configOverrides`, mirroring how the H3 builder omits its key-remap flags for
 * a checkpoint that needs none.
 */
export const ltx25TextEncoderArgs = (textEncoder) => {
  if (!textEncoder) return [];
  const args = ['--text-encoder-id', textEncoder.id];
  for (const path of textEncoder.paths) args.push('--text-encoder-file', path);
  args.push('--text-encoder-shim-root', LTX25_ENCODER_SHIM_DIR);
  if (Object.keys(textEncoder.configOverrides || {}).length > 0) {
    args.push('--text-encoder-config-json', JSON.stringify(textEncoder.configOverrides));
  }
  return args;
};

// Build the spawn args for dgrauet's ltx-2-mlx runtime via our Python helper.
// The helper lives in the ltx-2-mlx venv (so its `import ltx_pipelines_mlx`
// resolves) but the script file lives in the PortOS repo so updates ship
// with PortOS releases instead of the user's HF cache.
export const buildLtx2Args = ({ model, ltxModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, a2vLoraStageStrengths, disableAudio, outputPath, previewDir, textEncoderRepo, textEncoder, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile, streamingMode }) => {
  assertByovRuntimeInstalled(model.runtime);
  // Map PortOS UI modes to the helper's subcommand. Native extend on ltx2
  // routes to ExtendPipeline.extend_from_video — conditions on the entire
  // source video's latent (motion + visual content) rather than just the
  // last frame. Falls back to i2v only if the caller supplied no source
  // video (e.g., the chained-render orchestrator already handed us a frame).
  // When mode is omitted, infer i2v from a present sourceImagePath — matches
  // the route schema's documented "absence falls back to inferring" behavior.
  const wantsNativeExtend = mode === 'extend' && !!extendFromVideoPath;
  const hasMultiKeyframes = Array.isArray(keyframes) && keyframes.length >= 2;
  // When `mode` is omitted but multi-keyframes are supplied, infer fflf so a
  // direct caller (test, script) doesn't get a silent text-only render with
  // their keyframes dropped on the floor. The route handler always sets
  // mode='fflf' when keyframes are present, but defense-in-depth here covers
  // callers that bypass the route (e.g. Writers Room batch dispatch).
  const helperMode = isIcLoraMode(mode) ? 'ic'
    : mode === 'fflf' ? 'fflf'
    : mode === 'a2v' ? 'a2v'
    : wantsNativeExtend ? 'extend'
    : mode === 'image' || mode === 'extend' ? 'image'
    : (!mode && hasMultiKeyframes) ? 'fflf'
    : (!mode && sourceImagePath) ? 'image'
    : 'text';
  if (helperMode === 'ic' && !icLoraSupportsRuntime(icLoraSpecForMode(mode), model.runtime)) {
    throw new ServerError(`${mode} is not compatible with ${model.runtime}.`,
      { status: 400, code: 'IC_LORA_REQUIRES_LTX2' });
  }
  const icFrameIssue = icLoraFrameIssue(icLoraSpecForMode(mode), numFrames);
  if (icFrameIssue) throw new ServerError(icFrameIssue, { status: 400, code: 'IC_LORA_REFERENCE_TOO_SHORT' });
  if (mode === 'ic-ingredients-25' && icSkipStage2) {
    throw new ServerError('LTX 2.5 References requires the refinement stage.',
      { status: 400, code: 'IC_LORA_SKIP_STAGE2_UNSUPPORTED' });
  }
  if (helperMode === 'fflf' && !hasMultiKeyframes && (!sourceImagePath || !lastImagePath)) {
    throw new ServerError(
      'FFLF mode on the ltx2 runtime requires either a keyframes array (length >= 2) or BOTH a start image and an end image.',
      { status: 400, code: 'LTX2_FFLF_MISSING_KEYFRAMES' },
    );
  }
  if (helperMode === 'extend' && !existsSync(extendFromVideoPath)) {
    throw new ServerError(
      `Extend source video not found on disk: ${extendFromVideoPath}`,
      { status: 400, code: 'LTX2_EXTEND_SOURCE_MISSING' },
    );
  }
  if (helperMode === 'a2v') {
    if (!audioFilePath || !existsSync(audioFilePath)) {
      throw new ServerError(
        `Audio file not found on disk for a2v mode: ${audioFilePath || '(missing)'}`,
        { status: 400, code: 'LTX2_A2V_AUDIO_MISSING' },
      );
    }
  }
  // Stage-2 OOM clamp on the keyframe pipeline.
  //
  // The KeyframeInterpolationPipeline runs a 2× spatial upscale + full-res
  // refinement after stage 1, and memory pressure scales with both
  // (width × height) AND latent-frame count = 1 + (numFrames - 1) / 8.
  // Phosphene's panel notes the same path OOMs even on 64 GB Macs at full
  // resolution and clamps to 768×432 in their UI. We empirically verified
  // 25 frames @ 704×448 fits 48 GB; 97 frames @ 704×448 OOMs in stage 2.
  //
  // Approach: cap the pixel-frame budget (width × height × numFrames), then
  // back-solve numFrames. Round down to the LTX 8k+1 latent-boundary so the
  // model doesn't silently snap. The cap auto-scales with detected unified
  // memory (see resolveFflfLtx2PixelBudget) — 128 GB boxes reach the 97-frame
  // smooth-motion regime out of the box, 48 GB boxes keep the tested-safe
  // floor. FFLF_LTX2_PIXEL_BUDGET overrides the scaling either way.
  if (helperMode === 'fflf') {
    const pixelBudget = resolveFflfLtx2PixelBudget();
    const requested = Number(width) * Number(height) * Number(numFrames);
    if (requested > pixelBudget) {
      const safeFrames = computeFflfSafeFrames(width, height, numFrames, pixelBudget);
      // Multi-keyframe renders pin specific pixel-frame indices — clamping
      // numFrames below `max(keyframe.index)` would either drop a keyframe
      // or hand the Python helper an out-of-range index that hard-fails
      // mid-render. Surface a 400 with a clear "raise FFLF_LTX2_PIXEL_BUDGET
      // or lower resolution" message instead of silently clamping.
      if (hasMultiKeyframes) {
        // Reject non-numeric indices upfront — Math.max(..., NaN) is NaN,
        // which would silently bypass the safeFrames guard below and let
        // the Python helper hard-fail with an opaque error mid-render.
        const indices = keyframes.map((kf, i) => {
          const n = Number(kf.index);
          if (!Number.isFinite(n)) {
            throw new ServerError(
              `keyframes[${i}].index is not a finite number: ${kf.index}`,
              { status: 400, code: 'LTX2_KEYFRAME_INVALID' },
            );
          }
          return n;
        });
        const maxKfIndex = Math.max(...indices);
        if (maxKfIndex > safeFrames - 1) {
          throw new ServerError(
            `Multi-keyframe render exceeds the FFLF/ltx2 pixel budget: ${width}×${height}×${numFrames} > ${pixelBudget} pixel-frames, but max keyframe index is ${maxKfIndex} (would clamp to ${safeFrames} frames). Lower resolution or raise FFLF_LTX2_PIXEL_BUDGET.`,
            { status: 400, code: 'LTX2_FFLF_PIXEL_BUDGET_EXCEEDED' },
          );
        }
        // Otherwise the keyframes still fit — clamp is safe.
      }
      console.log(`⚠️  FFLF/ltx2 numFrames clamped ${numFrames} → ${safeFrames} to fit pixel budget ${pixelBudget} (export FFLF_LTX2_PIXEL_BUDGET=<n> to raise)`);
      numFrames = safeFrames;
    }
  }
  const args = [
    LTX2_HELPER_SCRIPT,
    '--mode', helperMode,
    '--prompt', prompt,
    '--output', outputPath,
    '--model', ltxModelPath || model.repo,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--seed', String(seed),
    '--steps', String(steps),
    '--cfg-scale', String(guidance),
  ];
  if (previewDir) args.push('--preview-dir', previewDir);
  // The bridge otherwise enables TeaCache automatically in A2V and Extend.
  // Its coefficients were calibrated for LTX-2.3, not the LTX-2.5 model.
  if (model.runtime === 'ltx25' && (helperMode === 'a2v' || helperMode === 'extend')) {
    args.push('--no-teacache');
  }
  // LTX-2.5 packs ship Gemma 4 under text_encoder/. Passing the shared 2.3
  // Gemma 3 encoder would either fail load or silently condition on the wrong
  // model. The 2.3 runtime still needs the explicit shared encoder.
  if (model.runtime === 'ltx2') args.push('--gemma', textEncoderRepo);
  // The 2.5 substitution, which overrides the pack's OWN conditioner rather
  // than naming a repo — the two runtimes share this builder but not a flag.
  if (model.runtime === 'ltx25') args.push(...ltx25TextEncoderArgs(textEncoder));
  // User LoRAs — fused into the transformer via the pipeline's _pending_loras
  // hook. Emitted as a JSON list of { path, strength }; generate_ltx2.py sets
  // pipe._pending_loras before generation so the deltas fuse at load time
  // (the same mechanism the upstream `ltx-2-mlx generate --lora` CLI uses).
  if (!isDefaultA2vLoraStages(a2vLoraStageStrengths)) args.push('--a2v-lora-stage-strengths', JSON.stringify(a2vLoraStageStrengths));
  if (Array.isArray(loras) && loras.length > 0) {
    args.push('--user-loras', JSON.stringify(loras.map((l) => ({ path: l.path, strength: l.strength }))));
  }
  // Block-streaming request (#6499). Emitted ONLY when it is NOT the default —
  // 'auto' (absence) is the bridge's own default, so an unswapped render's
  // argv stays byte-identical to one from before this setting existed. The
  // bridge, not this builder, decides whether the resolved MODE's pinned
  // pipeline can honor it — see scripts/ml/generate_ltx2.py#resolve_streaming_policy.
  if (!isDefaultVideoStreamingMode(streamingMode)) {
    args.push('--streaming-mode', streamingMode);
  }
  // Two-stage T2V experiment passes an explicit stage-2 step count; omitted
  // otherwise so the pipeline keeps its own default.
  if (stage2Steps != null) args.push('--stage2-steps', String(stage2Steps));
  // Speed-profile levers (#4875). Emitted ONLY for a resolved profile — a
  // quality render must build byte-identical args to one from before the
  // feature existed, so absence is the whole contract here.
  //
  // The helper, not this builder, decides whether each lever is actually
  // available: `--speed-profile` names the profile in the child's
  // SPEEDPROFILE: report, `--teacache` REQUESTS stage-1 caching (the helper
  // probes the pinned pipeline for the kwarg and reports `degraded` when it
  // isn't there), and `--require-adapter` names the distilled adapter the
  // schedule was measured with so a pack missing it degrades loudly instead
  // of rendering slower than the profile claims.
  if (speedProfile) {
    args.push('--speed-profile', speedProfile.id);
    if (speedProfile.teacache) {
      args.push('--teacache');
      if (speedProfile.teacacheThresh != null) {
        args.push('--teacache-thresh', String(speedProfile.teacacheThresh));
      }
    }
    // String()'d like every other value pushed here: spawn throws
    // ERR_INVALID_ARG_TYPE on a non-string argv entry, and a hand-edited
    // registry can put a number in this field.
    if (speedProfile.requiresAdapter) args.push('--require-adapter', String(speedProfile.requiresAdapter));
  }
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (imageStrength != null) args.push('--image-strength', String(imageStrength));
  // The reference-mode promise (#4874). Emitted only when it is NOT the default so
  // an anchored render's argv stays byte-identical to what it was before the flag
  // existed. buildArgs already rejected a mode this model cannot honor; the helper
  // re-checks against the LIVE pipeline API and fails rather than anchoring
  // silently, which is the failure the flag exists to make impossible.
  if (!isDefaultI2vReferenceMode(i2vReferenceMode)) {
    args.push('--i2v-reference-mode', normalizeI2vReferenceMode(i2vReferenceMode));
  }
  if (disableAudio) args.push('--no-audio');
  if (helperMode === 'image' && sourceImagePath) args.push('--image', sourceImagePath);
  if (helperMode === 'fflf') {
    if (hasMultiKeyframes) {
      // Emit the helper's JSON contract — the path field is the resized image
      // on disk (already cropped to (width, height) by generateVideo). The
      // helper reads paths verbatim, so any mismatch here is unrecoverable.
      args.push('--keyframes-json', JSON.stringify(
        keyframes.map((kf) => ({ path: kf.path, index: kf.index })),
      ));
    } else {
      args.push('--image', sourceImagePath);
      args.push('--last-image', lastImagePath);
    }
  }
  if (helperMode === 'extend') {
    args.push('--extend-from-video', extendFromVideoPath);
    // Translate the user's requested numFrames into a latent-frame count for
    // ExtendPipeline. Shared with the chain orchestrator, which needs the same
    // number to work out how much of the render is echoed source (see
    // `lib/videoContinuity.js`) — the two MUST agree or the trim is wrong.
    args.push('--extend-frames', String(extendLatentFrames(numFrames, model.runtime)));
    args.push('--extend-direction', 'after');
  }
  if (helperMode === 'a2v') {
    args.push('--audio', audioFilePath);
    if (audioStartSec != null) args.push('--audio-start', String(audioStartSec));
    // Optional first-frame conditioning — when the user supplied a source
    // image, AudioToVideoPipeline conditions frame 0 the same way I2V does
    // so motion + audio sync to the chosen still.
    if (sourceImagePath) args.push('--image', sourceImagePath);
  }
  if (helperMode === 'ic') {
    if (mode === 'ic-ingredients-25' && sourceImagePath) args.push('--image', sourceImagePath);
    args.push(...icLoraArgs({
      mode, width, height, icReferencePaths, icLoraWeightPath,
      icStrength, icAttentionStrength, icSkipStage2,
    }));
  }
  return { bin: BYOV_RUNTIME_INFO[model.runtime].venvPython, args };
};

export const buildLtx25CudaArgs = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, mode, imageStrength, disableAudio, outputPath }) => {
  assertByovRuntimeInstalled('ltx25_cuda');
  assertRenderModeContract({ model, mode, sourceImagePath });
  if (!model?.repo || !model?.revision) {
    throw new ServerError(
      `LTX-2.5 model "${model?.id || 'unknown'}" is missing its pinned repo or revision.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const files = Array.isArray(model.repoFiles)
    ? model.repoFiles.filter((file) => typeof file === 'string' && file)
    : [];
  if (files.length === 0) {
    throw new ServerError(
      `LTX-2.5 model "${model.id}" is missing its split checkpoint file list.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  if (negativePrompt) {
    throw new ServerError(
      'The distilled LTX-2.5 CUDA pipeline does not consume a negative prompt.',
      { status: 400, code: 'VIDEO_NEGATIVE_PROMPT_UNSUPPORTED' },
    );
  }
  const args = [
    LTX25_CUDA_HELPER_SCRIPT,
    '--model-repo', model.repo,
    '--model-revision', model.revision,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  for (const file of files) args.push('--repo-file', file);
  if (sourceImagePath) args.push('--image', sourceImagePath, '--image-strength', String(imageStrength ?? 1));
  if (disableAudio) args.push('--disable-audio');
  return { bin: LTX25_CUDA_VENV_PYTHON, args };
};

// Which helper script + interpreter carries a generative upscale on each BYOV
// runtime. Keyed by runtime id (NOT platform) so the caller's resolved runtime
// is the single decision — `upscalePlan.ltxUpscaleRuntimeId()` already made it.
const LTX_UPSCALE_RUNNERS = Object.freeze({
  ltx25: { bin: LTX25_VENV_PYTHON, script: LTX25_UPSCALE_HELPER_SCRIPT },
  ltx25_cuda: { bin: LTX25_CUDA_VENV_PYTHON, script: LTX25_CUDA_UPSCALE_HELPER_SCRIPT },
});

/**
 * Argv for the generative 2× video upscale (#6511).
 *
 * The pass is an IC-LoRA render whose single reference is the clip being
 * upscaled, so it reuses the IC flag alphabet (`--ic-lora-path`,
 * `--ic-reference`, `--ic-min-references`, `--ic-max-references`) rather than
 * inventing a second one. The bounds are passed EXPLICITLY for the same reason
 * `icLoraArgs` passes them: the weight registry is the single source of truth
 * across both languages, and `run_ic_lora` requires them — a Python-side
 * default would be a second table free to drift from `icLoraWeights.js`.
 *
 * There is deliberately no model id here. The base LTX-2.5 checkpoint is the
 * runner's own pinned dependency (#6512 / #6513), not a user-selectable render
 * model, so naming one would invite an upscale conditioned on a checkpoint the
 * adapter was never trained against. `baseModelPath` is that pinned checkpoint
 * already RESOLVED to a local snapshot by the dispatch — a located dependency,
 * not a choice — because the runner must never resolve it itself: every LTX
 * pipeline's loader falls back to `snapshot_download` for a path it cannot
 * stat, which for a ~68 GB pack is an unannounced pull mid-render.
 *
 * `width`/`height`/`numFrames` are the ALIGNED target the caller already padded
 * its source up to, so this builder asserts the grid rather than re-deriving it.
 */
export const buildLtxUpscaleArgs = ({
  runtime, sourceVideoPath, baseModelPath, icLoraWeightPath, icMinReferences, icMaxReferences,
  width, height, numFrames, fps, seed, outputPath,
}) => {
  const runner = LTX_UPSCALE_RUNNERS[runtime];
  if (!runner) {
    throw new ServerError(
      `No generative upscale runner exists for runtime "${runtime || 'unknown'}".`,
      { status: 400, code: 'UPSCALE_RUNTIME_UNSUPPORTED' },
    );
  }
  assertByovRuntimeInstalled(runtime);
  if (!baseModelPath) {
    throw new ServerError(
      'The LTX-2.5 model pack this backend renders against is not cached — download or repair it in Video Gen first.',
      { status: 400, code: 'UPSCALE_BASE_MODEL_UNRESOLVED' },
    );
  }
  if (!icLoraWeightPath) {
    throw new ServerError(
      'The Pixel Spatial Upscaler weight is not downloaded — download it from the model panel first.',
      { status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' },
    );
  }
  if (!sourceVideoPath || !existsSync(sourceVideoPath)) {
    throw new ServerError(
      `Upscale source clip not found on disk: ${sourceVideoPath || '(missing)'}`,
      { status: 400, code: 'IC_LORA_REFERENCE_MISSING' },
    );
  }
  // The bounds ride in the job params so a persisted/replayed job stays
  // self-describing. A job written before they did — or hand-edited out of
  // media-jobs.json — must fail rather than silently borrow the helper's
  // default, which is the exact drift this contract exists to prevent.
  const bound = (value, flag) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new ServerError(
        `Generative upscale requires an explicit ${flag} from the weight registry; got ${value}.`,
        { status: 400, code: 'IC_LORA_REFERENCE_BOUNDS_MISSING' },
      );
    }
    return String(n);
  };
  const positive = (value, flag) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ServerError(
        `Generative upscale requires a positive ${flag}; got ${value}.`,
        { status: 400, code: 'UPSCALE_TARGET_INVALID' },
      );
    }
    return String(n);
  };
  return {
    bin: runner.bin,
    args: [
      runner.script,
      '--model', baseModelPath,
      '--ic-lora-path', icLoraWeightPath,
      '--ic-reference', sourceVideoPath,
      '--ic-min-references', bound(icMinReferences, '--ic-min-references'),
      '--ic-max-references', bound(icMaxReferences, '--ic-max-references'),
      '--width', positive(width, 'width'),
      '--height', positive(height, 'height'),
      '--num-frames', positive(numFrames, 'frame count'),
      '--fps', positive(fps, 'frame rate'),
      '--seed', String(Number(seed) >>> 0),
      '--output', outputPath,
    ],
  };
};
