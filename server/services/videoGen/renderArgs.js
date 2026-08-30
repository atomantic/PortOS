/**
 * Local-video render argument assembly and runtime validation.
 *
 * This module is pure apart from cache/file existence checks used to validate
 * a requested render before the child process starts.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { totalmem } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  isDefaultI2vReferenceMode, normalizeI2vReferenceMode,
} from '../../lib/videoReferenceModes.js';
import { extendLatentFrames } from '../../lib/videoContinuity.js';
import { videoLoraLayoutIssue } from '../../lib/safetensors.js';
import { formatLoraEffect, loraEffectIssue } from '../../lib/loraEffect.js';
import { assertSafeLoraFilename, getLoraKeyLayout } from '../loras.js';
import { LORA_EFFECT_PROBE_BUDGET_MS, probeLoraEffect } from '../loraEffectProbe.js';
import { videoLoraFamily, isLtx2FamilyRuntime } from '../../lib/runners.js';
import {
  isIcLoraMode, icLoraSpecForMode, assertIcReferenceCount, icResolutionIssue,
} from '../../lib/icLoraWeights.js';
import { videoModeContractError, videoReferenceModeError } from './modeContract.js';
import { minimaxH3ControlError } from './minimaxH3Controls.js';
import {
  MINIMAX_H3_HOST_RESERVE_GB,
  miniMaxH3MemoryDeclineReason,
  miniMaxH3MemoryProfiles,
  selectMiniMaxH3MemoryProfile,
} from '../../lib/minimaxH3Memory.js';
import {
  LTX2_HELPER_SCRIPT,
  LTX25_ENCODER_SHIM_DIR,
  WAN22_VENV_PYTHON,
  WAN22_HELPER_SCRIPT,
  MINIMAX_H3_VENV_PYTHON,
  MINIMAX_H3_HELPER_SCRIPT,
  MINIMAX_H3_REPO_DIR,
  MINIMAX_H3_ENCODER_SHIM_DIR,
  MINIMAX_H3_DRAFT_DECODER_SHIM_DIR,
  MINIMAX_H3_EXPECTED_REVISION,
  MINIMAX_H3_CUDA_VENV_PYTHON,
  MINIMAX_H3_CUDA_HELPER_SCRIPT,
  MINIMAX_H3_CUDA_OFFLOAD_PROFILES,
  FASTVIDEO_VENV_PYTHON,
  FASTVIDEO_HELPER_SCRIPT,
  FASTVIDEO_REPO_DIR,
  BYOV_RUNTIME_INFO,
  videoLoraUnsupportedError,
  routesToWindowsHelper,
  assertByovRuntimeInstalled,
} from './runtimes.js';

const AV_LORA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_av_lora.py');

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

// Resolve picker `{ filename, scale }` LoRA entries into absolute
// `{ path, strength }` pairs the ltx2 helper fuses via the pipeline's
// `_pending_loras` hook (see scripts/generate_ltx2.py). Validates each
// basename can't escape PATHS.loras (assertSafeLoraFilename) and that the file
// exists — a typo or a deleted LoRA would otherwise surface as an opaque
// Python FileNotFoundError deep inside the render. Returns [] for no LoRAs.
// The ltx2 and MiniMax H3 MLX runtimes consume the result; buildArgs rejects
// LoRAs on the other runtimes before this is even reached for a doomed job.
//
// Also gates on the safetensors KEY LAYOUT. The loader fuses `lora_A`/`lora_B`
// pairs after stripping a leading `diffusion_model.`. The MiniMax H3 adapter
// also normalizes kohya (lora_down/lora_up) and Diffusers/PEFT-prefixed files,
// so only the LTX loader keeps the older layout restriction. Refuse an
// unsupported LTX layout up front with the layout named.
export const resolveVideoLoras = async (loras, { probeEffect = false, runtime = null } = {}) => {
  if (!Array.isArray(loras) || loras.length === 0) return [];
  const out = [];
  // ONE budget for every selected adapter, not one each. This runs before
  // generateVideo mints a job id, so anything spent here is silence in the UI —
  // a 4-LoRA render must not be able to stall for four full probe budgets.
  const effectDeadline = probeEffect ? Date.now() + LORA_EFFECT_PROBE_BUDGET_MS : null;
  for (const l of loras) {
    assertSafeLoraFilename(l?.filename);
    const path = join(PATHS.loras, l.filename);
    if (!existsSync(path)) {
      throw new ServerError(`LoRA not found: ${l.filename}`, { status: 400, code: 'LORA_NOT_FOUND' });
    }
    const layout = await getLoraKeyLayout(l.filename);
    const issue = runtime === 'minimax_h3' && layout !== 'not_a_lora'
      ? null
      : videoLoraLayoutIssue(layout);
    if (issue) {
      throw new ServerError(
        `LoRA "${l.filename}" can't be used for video: ${issue}.`,
        { status: 400, code: 'LORA_LAYOUT_UNSUPPORTED' },
      );
    }
    if (layout == null) {
      console.log(`⚠️ LoRA key layout undetermined for ${l.filename} — fusing anyway`);
    }
    // Adapter-effect gate (#4872). Opt-in — a passive library read must never
    // spawn a probe — and the render path opts in, because this is the last
    // moment before GPU minutes are spent on weights that may be inert. The
    // measurement is cached in the sidecar, so this costs a Python child once
    // per LoRA file and nothing thereafter.
    //
    // Only a POSITIVE measurement of entirely-zero effect refuses. A probe that
    // could not run (no numpy anywhere), an unreadable adapter, or one whose
    // modules all measured NaN, all render exactly as they did before this
    // gate existed — see loraEffectIssue().
    if (probeEffect) {
      const report = await probeLoraEffect(l.filename, { deadline: effectDeadline });
      const effectIssue = loraEffectIssue(report);
      if (effectIssue) {
        throw new ServerError(
          `LoRA "${l.filename}" can't be used for video: ${effectIssue}.`,
          { status: 400, code: 'LORA_EFFECT_ZERO' },
        );
      }
      if (report?.measured > 0) {
        console.log(`🔬 LoRA effect ${l.filename}: ${formatLoraEffect(report)}`);
      }
    }
    const strength = Number.isFinite(l?.scale) ? l.scale : 1.0;
    out.push({ path, strength, filename: l.filename });
  }
  return out;
};

// Build the spawn args for dgrauet's ltx-2-mlx runtime via our Python helper.
// The helper lives in the ltx-2-mlx venv (so its `import ltx_pipelines_mlx`
// resolves) but the script file lives in the PortOS repo so updates ship
// with PortOS releases instead of the user's HF cache.
// Validate an IC-LoRA render against its weight's contract, then emit the
// helper flags. The rules themselves (reference count, resolution divisibility)
// live in the registry that owns the numbers; this asserts them and translates
// to argv.
//
// `icLoraWeightPath` is resolved asynchronously up in generateVideo (the HF
// cache lookup is I/O) and threaded down, so this stays synchronous like every
// other buildArgs branch.
//
// Exported for direct unit testing: generateVideo floors each edge to a
// multiple of 64 before buildArgs runs, so a factor-2 weight's
// resolution-divisibility branch is unreachable through the public entry point
// (64-step flooring always yields an even number). It becomes live the moment a
// weight ships with `referenceDownscaleFactor > 2`, so it's tested here rather
// than left unverified.
export const icLoraArgs = ({ mode, width, height, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2 }) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) {
    throw new ServerError(`Unknown IC-LoRA remix mode: ${mode}`, { status: 400, code: 'IC_LORA_UNKNOWN_MODE' });
  }
  if (!icLoraWeightPath) {
    // A `requiresPreDownload` weight lands here by design: resolveIcLoraWeight
    // refuses to hand the pipeline a bare repo id it would `snapshot_download`
    // (gated official repo / 708 GB mirror), so the ONLY way forward is the
    // explicit single-file download from the panel.
    throw new ServerError(
      `IC-LoRA weight for "${spec.mode}" is not downloaded — download ${spec.label} (${spec.filename}) from the model panel first.`,
      { status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' },
    );
  }
  const refs = Array.isArray(icReferencePaths) ? icReferencePaths : [];
  assertIcReferenceCount(spec, refs.length, (msg) => new ServerError(msg, {
    status: 400, code: 'IC_LORA_REFERENCE_COUNT',
  }));
  for (const ref of refs) {
    if (!ref || !existsSync(ref)) {
      throw new ServerError(
        `IC-LoRA reference not found on disk: ${ref || '(missing)'}`,
        { status: 400, code: 'IC_LORA_REFERENCE_MISSING' },
      );
    }
  }
  // Inside the pipeline a bad resolution surfaces as a bare ValueError mid-render,
  // after the model has already loaded — catch it here instead.
  const resolutionIssue = icResolutionIssue(spec, width, height);
  if (resolutionIssue) {
    throw new ServerError(resolutionIssue, { status: 400, code: 'IC_LORA_RESOLUTION_NOT_DIVISIBLE' });
  }
  const args = [
    '--ic-mode', spec.id,
    '--ic-lora-path', icLoraWeightPath,
    '--ic-strength', String(icStrength ?? 1.0),
    // Pass the bounds rather than letting the helper carry its own table: the
    // registry stays the single source of truth across both languages, and the
    // helper still enforces them for a direct/script caller.
    '--ic-min-references', String(spec.minReferences),
    '--ic-max-references', String(spec.maxReferences),
  ];
  for (const ref of refs) args.push('--ic-reference', ref);
  if (icAttentionStrength != null) args.push('--ic-attention-strength', String(icAttentionStrength));
  if (icSkipStage2) args.push('--ic-skip-stage-2');
  return args;
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

const buildLtx2Args = ({ model, ltxModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, disableAudio, outputPath, previewDir, textEncoderRepo, textEncoder, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile }) => {
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
  if (Array.isArray(loras) && loras.length > 0) {
    args.push('--user-loras', JSON.stringify(loras.map((l) => ({ path: l.path, strength: l.strength }))));
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
    args.push('--extend-frames', String(extendLatentFrames(numFrames)));
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
    args.push(...icLoraArgs({
      mode, width, height, icReferencePaths, icLoraWeightPath,
      icStrength, icAttentionStrength, icSkipStage2,
    }));
  }
  return { bin: BYOV_RUNTIME_INFO[model.runtime].venvPython, args };
};

// The render-side adapter for the shared mode/source contract: `prepareParams`
// wants the error value (it unlinks staged uploads first), this path just
// throws, and it names its inputs by resolved path rather than by presence.
// EVERY gated runtime goes through here — do not re-type a mode rule.
export const assertRenderModeContract = ({
  model, mode, sourceImagePath, lastImagePath, keyframes,
  extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths,
}) => {
  const err = videoModeContractError({
    model,
    mode,
    hasFirstImage: !!sourceImagePath,
    hasLastImage: !!lastImagePath,
    keyframes,
    extendFromVideo: extendFromVideoPath,
    audioFile: audioFilePath,
    audioStartSec,
    icReferences: icReferencePaths,
  });
  if (err) throw err;
};

// Build args for the FastVideo MLX helper on Apple Silicon.
export const buildFastVideoArgs = ({
  model, fastvideoModelPath, prompt, negativePrompt, width, height,
  numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath,
}) => {
  assertByovRuntimeInstalled('fastvideo');
  assertRenderModeContract({ model, mode, sourceImagePath });
  const args = [
    FASTVIDEO_HELPER_SCRIPT,
    '--repo-dir', FASTVIDEO_REPO_DIR,
    '--model-root', fastvideoModelPath || model.repo,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 1.0),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (sourceImagePath) args.push('--image', sourceImagePath);
  return { bin: FASTVIDEO_VENV_PYTHON, args };
};

// Build args for the pinned MLX-Gen Wan CLI. The helper itself never downloads:
// all base + profile weights must already be present through the UI flow.
const buildWan22Args = ({ model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath }) => {
  assertByovRuntimeInstalled('wan22');
  const requestedMode = mode || (sourceImagePath ? 'image' : 'text');
  assertRenderModeContract({ model, mode, sourceImagePath });
  const args = [
    WAN22_HELPER_SCRIPT,
    '--model-repo', wanModelPath,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 5.0),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (model.guidance2 != null) args.push('--guidance-2', String(model.guidance2));
  if (model.flowShift != null) args.push('--flow-shift', String(model.flowShift));
  if (model.solver) args.push('--solver', model.solver);
  // The contract above already rejected image mode without a source.
  if (requestedMode === 'image') args.push('--image', sourceImagePath);
  for (const weight of wanRequiredWeights) {
    args.push('--lora-path', weight.path);
    args.push('--lora-target-role', weight.role);
  }
  return { bin: WAN22_VENV_PYTHON, args };
};

// Everything both H3 builders must clear before they start assembling argv:
// the venv is installed, the mode/source combination is legal, H3's fixed
// controls were not overridden, and the entry carries its pin. The two lanes
// had carried byte-identical copies of all four — the same shape that put the
// control checks in `minimaxH3Controls.js` in the first place — so a field
// added to `assertRenderModeContract` can no longer be threaded into one H3
// runner and forgotten in the other. `repoLabel` is the only real difference:
// the MLX entry pins a *transformer* repo, the CUDA entry the model repo.
const assertMiniMaxH3Preflight = ({
  runtimeId, repoLabel, model, mode, sourceImagePath, lastImagePath, keyframes,
  extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths,
  negativePrompt, disableAudio, tiling, numFrames, fps,
}) => {
  assertByovRuntimeInstalled(runtimeId);
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
  const controlError = minimaxH3ControlError({ model, negativePrompt, disableAudio, tiling, numFrames, fps });
  if (controlError) throw controlError;
  if (typeof model.repo !== 'string' || typeof model.revision !== 'string') {
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned ${repoLabel}.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  // Capacity, before anything is spawned (issue #5420). H3's components fit
  // nowhere unassisted, so a box below every declared placement profile is not
  // a slow render — it is a multi-hour load that OOMs at the far end, after the
  // job has already taken the queue. A 400 here names the shortfall while the
  // user is still looking at the form. `null` when the host was not measured,
  // which defers to the runner's own check rather than blocking.
  const memoryDecline = miniMaxH3MemoryDeclineReason({
    model,
    modelId: model.id,
    totalMemoryGb: totalmem() / 1024 ** 3,
  });
  if (memoryDecline) throw new ServerError(memoryDecline.message, { status: 400, code: memoryDecline.code });
};

// The capacity contract both H3 runners are handed: the host floor below which
// NO declared placement profile can run, and the reserve PortOS holds back for
// the OS. Sent as argv rather than left to each runner's own constants so the
// server-side gate above and the runner-side enforcement cannot state different
// numbers. The floor is the SMALLEST across the entry's profiles, not the one
// the host-side selection landed on: on the CUDA lane the runner picks the tier
// from VRAM (the only side that can see the device), so a floor taken from a
// richer tier would reject a box that can in fact run a leaner one.
const miniMaxH3HostMemoryArgs = (model) => {
  const floors = miniMaxH3MemoryProfiles(model)
    .map((profile) => Number(profile.minMemoryGb))
    .filter((floor) => Number.isFinite(floor) && floor > 0);
  if (floors.length === 0) return [];
  return [
    '--min-system-memory-gb', String(Math.min(...floors)),
    '--memory-headroom-gb', String(MINIMAX_H3_HOST_RESERVE_GB),
  ];
};

// Build args for PipeNetwork's pinned MiniMax H3 MLX port. The helper resolves
// only exact, already-cached HF revisions; every network download remains an
// explicit Video Gen UI action guarded by the model's terms acknowledgement.
const buildMiniMaxH3Args = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, previewDir, loras, textEncoder, draftDecoder }) => {
  assertMiniMaxH3Preflight({
    runtimeId: 'minimax_h3',
    repoLabel: 'transformer repo or revision',
    model, mode, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath,
    audioFilePath, audioStartSec, icReferencePaths,
    negativePrompt, disableAudio, tiling, numFrames, fps,
  });
  const checkpoint = Array.isArray(model.requiredWeights) ? model.requiredWeights[0] : null;
  const files = Array.isArray(checkpoint?.files) ? checkpoint.files : [];
  if (!checkpoint?.repo || !checkpoint?.revision || files.length === 0) {
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned upstream checkpoint files.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    MINIMAX_H3_HELPER_SCRIPT,
    '--runtime-dir', MINIMAX_H3_REPO_DIR,
    '--runtime-revision', MINIMAX_H3_EXPECTED_REVISION,
    '--model-repo', model.repo,
    '--model-revision', model.revision,
    '--checkpoint-repo', checkpoint.repo,
    '--checkpoint-revision', checkpoint.revision,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--seed', String(seed),
    '--output', outputPath,
    ...miniMaxH3HostMemoryArgs(model),
  ];
  // The MLX lane's placement is unified-memory only, so the server picks the
  // profile and the runner enforces its limit against the machine's own RAM.
  // (The CUDA lane is the opposite: the tier is VRAM-driven, so it stays the
  // runner's call and rides on --offload-profile instead.)
  const mlxProfile = selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: totalmem() / 1024 ** 3 }).profile;
  if (mlxProfile) args.push('--memory-profile', mlxProfile.id);
  if (previewDir) args.push('--preview-dir', previewDir);
  for (const file of files) args.push('--checkpoint-file', file);
  // Anchor order is packed order: the helper stretches the FIRST keyframe onto
  // the canvas as the geometry anchor, so a first-frame image must lead.
  if (sourceImagePath) args.push('--image', sourceImagePath, '--anchor', 'first');
  if (lastImagePath) args.push('--image', lastImagePath, '--anchor', 'last');
  // Runtime (never fused) application — each --lora needs its own --lora-scale,
  // in the same order, mirroring the --image/--anchor pairing above. buildArgs
  // has already rejected LoRAs unless the probe proved this checkout plus the
  // PortOS adapter can apply them to the quantized DiT (see runtimes.js
  // `loraProbeArgs`).
  for (const l of loras ?? []) args.push('--lora', l.path, '--lora-scale', String(l.strength));
  // Substituted prompt conditioner (lib/videoTextEncoders.js). Absent for the
  // stock choice, so the argv of an unswapped render is byte-identical to what
  // it was before this feature existed. `textEncoder.paths` were already
  // resolved against the HF cache by generateVideo — the helper never downloads.
  // One --text-encoder-file per shard; the shim links them all into the same
  // `text_encoder/`, which the loader globs.
  if (textEncoder) {
    args.push('--text-encoder-id', textEncoder.id);
    for (const path of textEncoder.paths) args.push('--text-encoder-file', path);
    args.push('--text-encoder-shim-root', MINIMAX_H3_ENCODER_SHIM_DIR);
    for (const [from, to] of Object.entries(textEncoder.keyPrefixMap || {})) {
      args.push('--text-encoder-key-prefix', `${from}=${to}`);
    }
    // Only for a conditioner published without the final norm — H3 reads the
    // hidden state before it, but the pinned loader builds the full module tree
    // and refuses to load with any parameter missing.
    if (textEncoder.finalNormKey) args.push('--text-encoder-final-norm-key', textEncoder.finalNormKey);
  }
  // Preview-fidelity video decode (lib/videoDraftDecoders.js, #5423). Absent
  // for every full-decode render, so the argv of a delivery render is
  // byte-identical to what it was before this feature existed. `paths` were
  // already resolved against the HF cache by generateVideo — the helper never
  // downloads — and generateVideo has already refused the substitution for a
  // model the finish graph names as a delivery target, so nothing here can put
  // a draft decode on a delivery clip. One --draft-decoder-file per pinned
  // file; the helper links it into a shim `source/` beside the model's own
  // decoder config.
  if (draftDecoder) {
    args.push('--draft-decoder-id', draftDecoder.id);
    for (const path of draftDecoder.paths) args.push('--draft-decoder-file', path);
    args.push('--draft-decoder-shim-root', MINIMAX_H3_DRAFT_DECODER_SHIM_DIR);
  }
  return { bin: MINIMAX_H3_VENV_PYTHON, args };
};

// Build args for MiniMax H3 on CUDA — diffusers' MiniMaxH3ModularPipeline in a
// pip venv, which is the only H3 path an NVIDIA box has (the MLX port above is
// Apple-Silicon-only). Same cache-only contract: the helper resolves exactly
// the pinned revisions already on disk and never reaches the network, so every
// download stays an explicit, terms-gated Video Gen action.
//
// Unlike the MLX lane this is ONE repo — diffusers' modular layout keeps the
// transformer, conditioner, both VAEs and the schedulers in the model's own
// `repo`, so the file list rides on `repoFiles` and there is no separate
// upstream-checkpoint dependency to resolve.
const buildMiniMaxH3CudaArgs = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath }) => {
  assertMiniMaxH3Preflight({
    runtimeId: 'minimax_h3_cuda',
    repoLabel: 'repo or revision',
    model, mode, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath,
    audioFilePath, audioStartSec, icReferencePaths,
    negativePrompt, disableAudio, tiling, numFrames, fps,
  });
  const files = Array.isArray(model.repoFiles) ? model.repoFiles.filter((file) => typeof file === 'string' && file) : [];
  if (files.length === 0) {
    // Fail here rather than let the helper fall back to a repo-wide resolve:
    // `MiniMaxAI/MiniMax-H3` is ~498 GB and holds three layouts, so "load
    // whatever is cached" is not a recoverable default for this model.
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned diffusers component file list.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    MINIMAX_H3_CUDA_HELPER_SCRIPT,
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
    ...miniMaxH3HostMemoryArgs(model),
  ];
  for (const file of files) args.push('--repo-file', file);
  // A user-pinned offload recipe from data/media-models.json. Omitted, the
  // helper sizes one from the card's own VRAM — the right default, since the
  // registry entry is shared across every install that syncs it and can't know
  // what GPU is on the other end. Validated here rather than left to the
  // helper's `choices=`: argparse would reject a typo as an opaque non-zero
  // child exit, well after the render was queued.
  if (model.offloadProfile !== undefined && model.offloadProfile !== null && model.offloadProfile !== '') {
    if (!MINIMAX_H3_CUDA_OFFLOAD_PROFILES.includes(model.offloadProfile)) {
      throw new ServerError(
        `MiniMax H3 model "${model.id}" declares an unknown offloadProfile "${model.offloadProfile}"; `
        + `expected one of ${MINIMAX_H3_CUDA_OFFLOAD_PROFILES.join(', ')}.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    args.push('--offload-profile', model.offloadProfile);
  }
  // Anchor order is packed order, same as the MLX lane: diffusers takes the
  // first keyframe as `image` (which sets the canvas) and the last as
  // `last_image`, so a first-frame image must lead.
  if (sourceImagePath) args.push('--image', sourceImagePath, '--anchor', 'first');
  if (lastImagePath) args.push('--image', lastImagePath, '--anchor', 'last');
  return { bin: MINIMAX_H3_CUDA_VENV_PYTHON, args };
};

export const buildArgs = ({ pythonPath, modelId, model, wanModelPath, wanRequiredWeights, ltxModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, tiling, disableAudio, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, textEncoderRepo, textEncoder, outputPath, previewDir, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile, draftDecoder }) => {
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
    return buildLtx2Args({ model, ltxModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, i2vReferenceMode, disableAudio, outputPath, previewDir, textEncoderRepo, textEncoder, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2, speedProfile });
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
  // applicator. All of those macOS/mlx-only. The route already rejects the rest,
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
    return buildFastVideoArgs({ model, fastvideoModelPath: wanModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath });
  }
  if (model.runtime === 'wan22') {
    return buildWan22Args({ model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath });
  }
  if (model.runtime === 'minimax_h3') {
    return buildMiniMaxH3Args({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, previewDir, loras, textEncoder, draftDecoder });
  }
  if (model.runtime === 'minimax_h3_cuda') {
    return buildMiniMaxH3CudaArgs({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath });
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
      'a2v mode is only supported on the ltx2 runtime. Pick a model with runtime: "ltx2" in data/media-models.json.',
      { status: 400, code: 'A2V_REQUIRES_LTX2' },
    );
  }
  // Every BYOV runtime has declined above; the remaining declared CUDA runtime
  // is the legacy LTX-Video 0.9.5 diffusers wrapper.
  if (routesToWindowsHelper(model)) {
    const scriptPath = join(PATHS.root, 'scripts', 'generate_win.py');
    const args = [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--num-frames', String(numFrames), '--fps', String(fps), '--steps', String(steps), '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (sourceImagePath) args.push('--image', sourceImagePath);
    if (lastImagePath) args.push('--last-image', lastImagePath);
    return { bin: pythonPath, args };
  }
  // Flags shared by the bare `mlx_video.generate_av` CLI and the LoRA wrapper
  // (scripts/generate_av_lora.py forwards these untouched to generate_av.main()).
  const flags = [
    '--prompt', prompt,
    '--height', String(height),
    '--width', String(width),
    '--num-frames', String(numFrames),
    '--seed', String(seed),
    '--fps', String(fps),
    '--steps', String(steps),
    '--cfg-scale', String(guidance),
    '--output-path', outputPath,
    '--model-repo', model.repo,
    '--text-encoder-repo', textEncoderRepo,
    '--tiling', tiling,
  ];
  if (negativePrompt) flags.push('--negative-prompt', negativePrompt);
  if (disableAudio) flags.push('--no-audio');

  // Pick a single conditioning image and frame index. mlx_video.generate_av
  // accepts only one --image so true FFLF (both keyframes) isn't supported;
  // when only a last image was supplied for FFLF, we condition the LAST
  // latent frame instead. --image-frame-idx is a LATENT index — LTX
  // compression is `1 + (videoFrames - 1) / 8`, so passing a raw video
  // frame count silently fails the conditioning shape check.
  let condImage = sourceImagePath;
  let condFrameIdx = null;
  if (mode === 'fflf' && lastImagePath && !sourceImagePath) {
    condImage = lastImagePath;
    condFrameIdx = Math.max(0, Math.floor((Number(numFrames) - 1) / 8));
  } else if (mode === 'fflf' && lastImagePath && sourceImagePath) {
    console.log(`⚠️ FFLF requested but mlx_video CLI only supports single-frame conditioning — last image ignored`);
  }
  if (condImage) {
    flags.push('--image', condImage);
    if (condFrameIdx != null) flags.push('--image-frame-idx', String(condFrameIdx));
    // --image-strength uses mask = 1.0 - strength: 1.0 preserves the source
    // latent, 0.0 fully denoises (= T2V). mlx_video's help text describes
    // this inverted. Omit when no caller value so mlx_video's default (1.0)
    // applies.
    if (imageStrength != null) flags.push('--image-strength', String(imageStrength));
  }

  // LoRA renders on a capable LTX-2.x mlx_video model go through the wrapper,
  // which merges the LoRA deltas into the transformer before running
  // generate_av.main(). `--user-loras` carries the resolved {path,strength}
  // pairs — the same JSON shape buildLtx2Args emits for the dgrauet runtime.
  if (hasLoras) {
    return {
      bin: pythonPath,
      args: [AV_LORA_HELPER_SCRIPT, ...flags, '--user-loras', JSON.stringify(loras.map((l) => ({ path: l.path, strength: l.strength })))],
    };
  }
  return { bin: pythonPath, args: ['-m', 'mlx_video.generate_av', ...flags] };
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
