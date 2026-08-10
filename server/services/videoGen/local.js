/**
 * Video Gen — Local provider (mlx_video on macOS, diffusers on Windows).
 *
 * Spawns a Python child to render an LTX video. Output lives in `data/videos/`
 * with thumbnails in `data/video-thumbnails/`. History is appended to
 * `data/video-history.json` so the Media History page can grid-view them.
 *
 * Image-to-video accepts either an in-PortOS image filename (from data/images)
 * or an upload — both get resized via ffmpeg to match target resolution before
 * the model sees them.
 */

import { execFile, spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { unlink, writeFile, copyFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir, totalmem } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS, UUID_RE } from '../../lib/fileUtils.js';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { createLineReader } from '../../lib/streamLines.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { getVideoModels, getDefaultVideoModelId, getTextEncoderRepo } from '../../lib/mediaModels.js';
import {
  findFfmpeg, safeUnder, generateThumbnail, optimizeForStreaming, upscaleVideo2x,
  extractEvaluationFrames, probeFrameCount, trimVideoFromFrame,
  hasAudioStream, buildTrimConcatArgs,
} from '../../lib/ffmpeg.js';
import {
  resolveContextFrames, resolveContinuityStrategy, extendLatentFrames,
  contextPrefixFrames, tailWindowStartFrame,
} from '../../lib/videoContinuity.js';
import { hfChildEnv } from '../../lib/hfToken.js';
import { inspectModelCache, findCachedRepoFile } from '../../lib/hfCache.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { makeVideoGenLineHandler, finalizeGeneratedVideo, isWatchdogSuccess, describeSignalDeath, describeRenderConditioning, RENDER_INPUTS_VERSION } from './generateVideoHelpers.js';
import { assertSafeLoraFilename } from '../loras.js';
import { isMlxVideoLtxLoraCapable } from '../../lib/runners.js';
import {
  isVideoModelTermsAccepted, acceptedVideoModelTerms, videoModelTermsGateId, videoModelTermsError,
} from '../../lib/videoDisclosure.js';
import { getSettings } from '../settings.js';
import {
  isIcLoraMode, icLoraSpecForMode, resolveIcLoraWeight,
  assertIcReferenceCount, icResolutionIssue,
} from '../../lib/icLoraWeights.js';
import {
  LTX2_VENV_PYTHON,
  LTX2_HELPER_SCRIPT,
  WAN22_VENV_PYTHON,
  WAN22_HELPER_SCRIPT,
  MINIMAX_H3_VENV_PYTHON,
  MINIMAX_H3_HELPER_SCRIPT,
  MINIMAX_H3_REPO_DIR,
  MINIMAX_H3_EXPECTED_REVISION,
  HUNYUAN_VENV_PYTHON,
  HUNYUAN_HELPER_SCRIPT,
  HUNYUAN_REPO_DIR,
  BYOV_RUNTIME_INFO,
  BYOV_VIDEO_RUNTIMES,
  modelAnchorsLastFrame,
  assertByovRuntimeInstalled,
  invalidateByovReadyCache,
  pickDeathFingerprint,
} from './runtimes.js';
import { loadHistory, saveHistory, mutateVideoHistory } from './history.js';
import { videoModeContractError, videoChainUnsupportedError, VIDEO_MODE_GATED_RUNTIMES } from './modeContract.js';
// Re-export the extracted runtime + history surface so existing deep imports
// (`from '../videoGen/local.js'`) keep resolving every symbol they used to.
export * from './runtimes.js';
export * from './modeContract.js';
export { loadHistory, saveHistory, mutateVideoHistory };

// LoRA wrapper for the notapalindrome `mlx_video` runtime. The stock
// `mlx_video.generate_av` CLI has no --lora flag, but the package ships an
// LTX-aware LoRA subsystem (`mlx_video.lora`) — this helper imports generate_av,
// merges the user LoRAs into the transformer weights, then runs generate_av's
// own main(), so it emits the identical STAGE:/STATUS:/DOWNLOAD: protocol. Runs
// in the SAME venv as the bare `-m mlx_video.generate_av` path (the configured
// pythonPath), not a separate BYOV venv. See isMlxVideoLtxLoraCapable.
const AV_LORA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_av_lora.py');

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';

const MODULE_NOT_FOUND_RE = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/;

// Panel-side SIGKILL watchdog (defense-in-depth at the Node layer).
//
// Some video runtimes finish all real work — decode, mux, write the file, and
// print the final `{"video_path": ...}` JSON — yet the python process lingers
// instead of exiting (a known mlx/torch teardown hang where a daemon thread or
// GPU context keeps the interpreter alive). The helper-side `os._exit(0)` is the
// first line of defense; this watchdog is the second. Once we observe the
// render's completion marker on stdout (the muxing-done line or the result
// JSON), we arm a grace timer; if the child still hasn't emitted 'close' by the
// time it fires, we SIGKILL it so the job (and the serialized gpu lane) doesn't
// wedge forever. The timer is cleared in every exit path so it can never fire
// against a recycled PID.
const COMPLETION_WATCHDOG_GRACE_MS = (() => {
  const raw = parseInt(process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 40000;
})();

// Pre-output idle-stall deadline (defense against a render that wedges BEFORE
// emitting anything).
//
// The completion watchdog above only arms once a completion marker/result JSON
// reaches stdout — it guards a post-completion teardown hang, NOT a render that
// stalls before producing any output (a known MLX/Metal failure mode where a
// job never exits and never prints). Left alone, that pins the serialized GPU
// lane (mediaJobQueue) until a manual cancel. This idle timer is armed at spawn
// and RESET on every child output line; if it fires it SIGKILLs the child, and
// the 'close' handler surfaces the timeout as a FAILED job so the lane frees for
// the next queued render. A manual cancel still works and always wins.
//
// The window is deliberately generous — a big model's first-token render can
// spend minutes loading weights + compiling Metal kernels before its first
// progress line, and we must never kill a legitimately-slow render. Sentinel +
// validate: a missing/non-numeric/non-positive VIDEOGEN_IDLE_STALL_MS falls back
// to the default (10 min) instead of collapsing to 0/NaN. Set it to 0 or a
// negative value only by editing the code path — the env knob can only raise or
// lower a positive window, never disable the guard silently.
const IDLE_STALL_DEADLINE_MS = (() => {
  const raw = parseInt(process.env.VIDEOGEN_IDLE_STALL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 600000; // 10 minutes of no output
})();

// Upstream prints this when the final decode+mux finishes, just before it should
// exit. Matching it (case-insensitive) lets us arm the watchdog even for
// runtimes that don't emit the result JSON on stdout.
const MUXING_DONE_RE = /\[Decoding video \+ audio \+ muxing\]\s+done in/i;

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
export const resolveVideoModel = (modelId) =>
  getVideoModels().find((m) => m.id === modelId) || VIDEO_MODELS[modelId] || null;

// Decorated with the one runtime capability the client can't derive: whether an
// FFLF last frame is a real anchor. Declared in runtimes.js, surfaced here so
// the Video Gen form reads it off the model instead of keeping its own list.
export const listVideoModels = () => getVideoModels()
  .map((m) => ({ ...m, lastFrameAnchored: modelAnchorsLastFrame(m) }));

export const defaultVideoModelId = () => getDefaultVideoModelId();

const jobs = new Map();
let activeProcess = null;
// Chain state for multi-chunk renders. cancel() flips `stopped` so the chain
// loop bails before kicking off the next chunk; the in-flight chunk's child
// is killed via the existing activeProcess SIGTERM path. There is at most
// one chain in flight at a time (mediaJobQueue serializes the gpu lane).
let activeChain = null;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = () => {
  // Flag the chain (if any) so the loop stops between chunks. We still
  // kill the in-flight child below — without that the current chunk would
  // run to completion before the chain saw the stop flag.
  if (activeChain) activeChain.stopped = true;
  if (!activeProcess) return !!activeChain;
  const proc = activeProcess;
  // KEEP activeProcess set until proc.on('close') clears it. Without this,
  // the BUSY guard immediately allows a new generation while the SIGTERM'd
  // child is still running (mlx_video can ignore SIGTERM mid-tensor-op),
  // and we'd lose the handle for a follow-up SIGKILL. The `activeProcess ===
  // proc` guard escalates only when this is still the tracked child.
  killWithEscalation(proc, { label: 'video child', stillRunning: () => activeProcess === proc });
  return true;
};

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
  if (!enabled || runtime !== 'ltx2') return null;
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
// Only the ltx2 runtime consumes the result; buildArgs rejects LoRAs on the
// other runtimes before this is even reached for a doomed job.
export const resolveVideoLoras = (loras) => {
  if (!Array.isArray(loras) || loras.length === 0) return [];
  return loras.map((l) => {
    assertSafeLoraFilename(l?.filename);
    const path = join(PATHS.loras, l.filename);
    if (!existsSync(path)) {
      throw new ServerError(`LoRA not found: ${l.filename}`, { status: 400, code: 'LORA_NOT_FOUND' });
    }
    const strength = Number.isFinite(l?.scale) ? l.scale : 1.0;
    return { path, strength, filename: l.filename };
  });
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

const buildLtx2Args = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, disableAudio, outputPath, textEncoderRepo, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2 }) => {
  assertByovRuntimeInstalled('ltx2');
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
    '--model', model.repo,
    '--gemma', textEncoderRepo,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--seed', String(seed),
    '--steps', String(steps),
    '--cfg-scale', String(guidance),
  ];
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
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (imageStrength != null) args.push('--image-strength', String(imageStrength));
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
  return { bin: LTX2_VENV_PYTHON, args };
};

// The render-side adapter for the shared mode/source contract: `prepareParams`
// wants the error value (it unlinks staged uploads first), this path just
// throws, and it names its inputs by resolved path rather than by presence.
// EVERY gated runtime goes through here — do not re-type a mode rule.
const assertRenderModeContract = ({
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

// Build args for PipeNetwork's pinned MiniMax H3 MLX port. The helper resolves
// only exact, already-cached HF revisions; every network download remains an
// explicit Video Gen UI action guarded by the model's terms acknowledgement.
const buildMiniMaxH3Args = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath }) => {
  assertByovRuntimeInstalled('minimax_h3');
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
  if (negativePrompt?.trim()) {
    throw new ServerError(
      'MiniMax H3 is CFG-distilled and does not accept a negative prompt.',
      { status: 400, code: 'MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED' },
    );
  }
  if (disableAudio) {
    throw new ServerError(
      'MiniMax H3 jointly generates video and audio; its audio track cannot be disabled.',
      { status: 400, code: 'MINIMAX_H3_AUDIO_REQUIRED' },
    );
  }
  if (tiling && tiling !== 'auto') {
    throw new ServerError(
      'MiniMax H3 does not expose a tiling mode.',
      { status: 400, code: 'MINIMAX_H3_TILING_UNSUPPORTED' },
    );
  }
  if (!Array.isArray(model.frameOptions) || !model.frameOptions.includes(Number(numFrames))) {
    throw new ServerError(
      `MiniMax H3 requires a 17n+5 frame count between 124 and 362; got ${numFrames}.`,
      { status: 400, code: 'MINIMAX_H3_INVALID_FRAME_COUNT' },
    );
  }
  if (Number(fps) !== 24) {
    throw new ServerError(
      `MiniMax H3 runs at a fixed 24 fps; got ${fps}.`,
      { status: 400, code: 'MINIMAX_H3_INVALID_FPS' },
    );
  }
  if (typeof model.repo !== 'string' || typeof model.revision !== 'string') {
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned transformer repo or revision.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
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
  ];
  for (const file of files) args.push('--checkpoint-file', file);
  // Anchor order is packed order: the helper stretches the FIRST keyframe onto
  // the canvas as the geometry anchor, so a first-frame image must lead.
  if (sourceImagePath) args.push('--image', sourceImagePath, '--anchor', 'first');
  if (lastImagePath) args.push('--image', lastImagePath, '--anchor', 'last');
  return { bin: MINIMAX_H3_VENV_PYTHON, args };
};

// Allowed precision tokens for runners that expose dtype as a CLI flag. The
// Python side already gates argparse with `choices=`, but a bogus value in
// data/media-models.json would otherwise reach the helper and surface as a
// less-friendly "invalid choice" inside a Python traceback — failing here
// gives a stable PortOS error code the route + client error path knows.
const VIDEO_PRECISIONS = Object.freeze(['fp16', 'bf16', 'fp32']);

// Build args for the HunyuanVideo MLX helper. Calls hyvideo.inference
// directly (see scripts/generate_hunyuan.py) so the steps / guidance /
// precision flags actually take effect — upstream's sample_video_mps.py
// silently hardcoded them.
const buildHunyuanArgs = ({ model, prompt, negativePrompt, width, height, numFrames, steps, guidance, seed, outputPath }) => {
  assertByovRuntimeInstalled('hunyuan');
  const precision = model.precision || 'fp16';
  if (!VIDEO_PRECISIONS.includes(precision)) {
    throw new ServerError(
      `Invalid precision "${precision}" on model "${model.id}" — expected one of ${VIDEO_PRECISIONS.join(', ')}`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    HUNYUAN_HELPER_SCRIPT,
    '--repo-dir', HUNYUAN_REPO_DIR,
    '--model-repo', model.repo,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 6.0),
    '--seed', String(seed),
    '--precision', precision,
    '--output', outputPath,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  return { bin: HUNYUAN_VENV_PYTHON, args };
};

const buildArgs = ({ pythonPath, modelId, model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, tiling, disableAudio, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, textEncoderRepo, outputPath, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2 }) => {
  // Route to the dgrauet/ltx-2-mlx helper when the model declares the new
  // runtime. Existing notapalindrome models default to runtime: 'mlx_video'
  // (or undefined in legacy registries — see backfillRuntime in mediaModels.js).
  if (model.runtime === 'ltx2') {
    return buildLtx2Args({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, stage2Steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength, disableAudio, outputPath, textEncoderRepo, loras, icReferencePaths, icLoraWeightPath, icStrength, icAttentionStrength, icSkipStage2 });
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
  // Defense-in-depth: LoRAs fuse only on ltx2 (handled above) or a non-quantized
  // LTX-2.x mlx_video model (the wrapper below), and the wrapper path is
  // macOS/mlx-only. The route already rejects other runtimes, but a non-route
  // caller (test, queue replay) — or a Windows install with a hand-edited/synced
  // mlx_video LTX-2.x entry — could reach here. Fail clearly rather than fall
  // through to the IS_WIN generate_win.py branch below, which would silently drop
  // the LoRAs and produce a base render the user thinks is LoRA-styled.
  if (hasLoras && (!isMlxVideoLtxLoraCapable(model) || IS_WIN)) {
    throw new ServerError(
      IS_WIN
        ? `LoRA fusion runs through the macOS-only mlx_video path; model "${modelId}" can't fuse LoRAs on Windows.`
        : `LoRAs aren't supported on this model. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: 'LORAS_REQUIRE_LTX2' },
    );
  }
  if (model.runtime === 'wan22') {
    return buildWan22Args({ model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath });
  }
  if (model.runtime === 'minimax_h3') {
    return buildMiniMaxH3Args({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath });
  }
  if (model.runtime === 'hunyuan') {
    return buildHunyuanArgs({ model, prompt, negativePrompt, width, height, numFrames, steps, guidance, seed, outputPath });
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
  if (IS_WIN) {
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

export async function generateVideo({ pythonPath, prompt, negativePrompt = '', modelId = defaultVideoModelId(), width = 768, height = 512, numFrames = null, fps = 24, steps, guidanceScale, seed, tiling = 'auto', disableAudio = false, sourceImagePath = null, uploadedTempPath = null, uploadedTempPaths = [], lastImagePath = null, keyframes = null, extendFromVideoPath = null, audioFilePath = null, audioStartSec = null, mode = null, imageStrength = null, loras = null, icReferencePaths = null, icStrength = null, icAttentionStrength = null, icSkipStage2 = false, hidden = false, jobId: providedJobId = null }) {
  uploadedTempPaths = Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [];
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is now enforced by the mediaJobQueue worker upstream — only
  // one job is dequeued at a time, so we don't need a BUSY guard here. Direct
  // callers (legacy / tests) bypass the queue and would clobber activeProcess
  // on concurrent calls; that's an explicit "don't do that" contract.

  const model = resolveVideoModel(modelId);
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  // Final execution-boundary gate for a restricted model's license. Route
  // preparation also rejects early, but internal producers, persisted jobs, and
  // retries all reach this function directly — so authorization is resolved
  // HERE, from the install's recorded acknowledgements, rather than trusted
  // from a caller-supplied parameter. Read at execution time, so a withdrawn
  // acknowledgement (or a license revision that mints a new id) fails a job
  // that was queued while it was still accepted. Ungated models never pay for
  // the settings read.
  if (videoModelTermsGateId(model)
    && !isVideoModelTermsAccepted(model, acceptedVideoModelTerms(await getSettings()))) {
    throw videoModelTermsError(model);
  }
  // Validate the mode contract before cache lookups, image resize, or staging
  // work. Internal producers and persisted/retried jobs bypass route
  // preparation, so silently dropping one of these inputs here would render a
  // materially different video than the caller requested. Ungated runtimes
  // (ltx2 / mlx_video / hunyuan) fall through untouched.
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
  // Only require the legacy mlx_video pythonPath when the chosen runtime
  // actually uses it. ltx2/wan22/hunyuan resolve their own venv path inside
  // buildArgs — gating them on the unrelated mlx_video setting locks users
  // out of the runtimes they just installed via INSTALL_WAN22 / INSTALL_LTX2
  // / INSTALL_HUNYUAN. Routes/videoGen.js reads the same module-level set.
  if (!pythonPath && !BYOV_VIDEO_RUNTIMES.has(model.runtime)) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' });
  }
  // macOS/mlx_video requires a HuggingFace repo id — Windows doesn't (the
  // diffusers wrapper hardcodes Lightricks/LTX-Video). A user-edited registry
  // entry missing `repo` would otherwise pass `undefined` into spawn args.
  if (!IS_WIN && (typeof model.repo !== 'string' || model.repo.length === 0)) {
    throw new ServerError(`Video model "${modelId}" is missing the required \`repo\` field in data/media-models.json`, { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
  }

  // Resolve LoRA basenames → absolute { path, strength } pairs up-front so a
  // missing/typo'd LoRA fails with a clean 400 before any GPU work. buildArgs
  // rejects LoRAs on non-ltx2 runtimes (the route also guards), so this is a
  // no-op there.
  const resolvedLoras = resolveVideoLoras(loras);

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
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const w = Math.floor(Number(width) / 64) * 64;
  const h = Math.floor(Number(height) / 64) * 64;
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  let actualSteps = model.samplerLocked ? model.steps : (steps ? Number(steps) : model.steps);
  let actualGuidance = model.samplerLocked
    ? model.guidance
    : (guidanceScale != null && guidanceScale !== '' ? Number(guidanceScale) : model.guidance);
  // Opt-in T2V Standard two-stage perf experiment — overrides steps/guidance
  // (and adds an explicit stage-2 step count) only for a plain default text
  // render when PORTOS_T2V_TWO_STAGE is on. No-op otherwise.
  let actualStage2Steps = null;
  const t2vTwoStage = resolveT2vTwoStageOverride({
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
  // Caller may pass null/'' to use mlx_video's default (1.0 = preserve source).
  const actualImageStrength = imageStrength != null && imageStrength !== '' ? Number(imageStrength) : null;
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
  //  - On Windows we forward --last-image to generate_win.py so it can log
  //    status, but the diffusers pipeline only reads --image — the script
  //    never opens the last-frame file, so no resize is needed there either.
  const lastImageWillBeUsed = !!lastImagePath && !IS_WIN && mode === 'fflf'
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
  const resizeImage = async (srcPath, tag) => {
    if (!srcPath || !ffmpeg) return { resolved: srcPath, tempPath: null };
    const resizedPath = join(tmpdir(), `resized-${tag}-${jobId}.png`);
    const resizeResult = await execFileAsync(ffmpeg, [
      '-i', srcPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-update', '1', '-frames:v', '1',
      '-y', resizedPath,
    ], { env: safeChildProcessEnv(), timeout: 10000 }).catch((err) => ({ error: err }));
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
  const cleanupResizeTempFiles = async () => {
    if (resizedSrcTempPath) await unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) await unlink(resizedLastTempPath).catch(() => {});
    for (const p of resizedKeyframeTempPaths) await unlink(p).catch(() => {});
    for (const p of icReferenceTempPaths) await unlink(p).catch(() => {});
  };
  if (isIcLoraMode(mode) && icLoraSpecForMode(mode)?.referenceKind === 'image'
    && Array.isArray(icReferencePaths) && icReferencePaths.length) {
    const stillFfmpeg = ffmpeg || await findFfmpeg();
    if (!stillFfmpeg) {
      await cleanupResizeTempFiles();
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
    ], { env: safeChildProcessEnv(), timeout: 30000 }).catch((err) => ({ error: err }))));
    const failedAt = encodes.findIndex((r) => r?.error);
    if (failedAt !== -1) {
      // Unlike the resizeImage fallback (which degrades to the original), there is
      // no usable degradation here — a still handed straight to the pipeline fails
      // deep inside the VAE reshape. Fail loudly with the ffmpeg reason.
      // cleanupResizeTempFiles() also unlinks clipPaths (already pushed into
      // icReferenceTempPaths above), plus any earlier resize temp files.
      await cleanupResizeTempFiles();
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
    filename,
    createdAt: new Date().toISOString(),
    // History mode reflects the EFFECTIVE mode — buildLtx2Args infers fflf
    // from `keyframes` even when caller omitted `mode`, so without this the
    // history entry would say 'text' for a multi-keyframe render.
    mode: mode || (hasMultiKeyframes ? 'fflf' : sourceImagePath ? 'image' : 'text'),
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
    // Stamp the experimental fast-path so A/B analysis can tell a two-stage
    // render apart from a user who happened to pick 8 steps — comparing it
    // against the default Standard render is the whole point of the knob.
    ...(t2vTwoStage ? { twoStageT2v: true, stage2Steps: actualStage2Steps } : {}),
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
    ...(hidden ? { hidden: true } : {}),
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  // buildArgs now throws synchronously on multi-keyframe pixel-budget
  // overflow and a few other validation paths — without this guard the
  // job would stay "running" forever in the jobs map and the resized
  // temp files would leak (the spawn close-handler that normally cleans
  // them up never runs because we never spawned). Mirror the cleanup
  // logic of the spawn-error handler so failure modes converge.
  let bin, args;
  try {
    ({ bin, args } = buildArgs({ pythonPath, modelId, model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, steps: actualSteps, stage2Steps: actualStage2Steps, guidance: actualGuidance, seed: actualSeed, tiling, disableAudio, sourceImagePath: resolvedSourceImage, lastImagePath: resolvedLastImage, keyframes: resolvedKeyframes, extendFromVideoPath, audioFilePath, audioStartSec, mode, imageStrength: actualImageStrength, textEncoderRepo: actualTextEncoderRepo, outputPath, loras: resolvedLoras, icReferencePaths: resolvedIcReferencePaths, icLoraWeightPath, icStrength: actualIcStrength, icAttentionStrength: actualIcAttentionStrength, icSkipStage2 }));
  } catch (err) {
    job.status = 'error';
    const reason = err.message || 'Failed to build video gen args';
    console.log(`❌ Video generation buildArgs error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    if (resizedSrcTempPath) unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) unlink(resizedLastTempPath).catch(() => {});
    for (const p of resizedKeyframeTempPaths) unlink(p).catch(() => {});
    for (const p of icReferenceTempPaths) unlink(p).catch(() => {});
    if (uploadedTempPath) unlink(uploadedTempPath).catch(() => {});
    for (const p of uploadedTempPaths) unlink(p).catch(() => {});
    if (audioFilePath && !uploadedTempPaths.includes(audioFilePath)) {
      unlink(audioFilePath).catch(() => {});
    }
    closeJobAfterDelay(jobs, jobId);
    throw err;
  }

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}]: ${modelId} ${w}x${h} frames=${parsedNumFrames} steps=${actualSteps}`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps, ...meta });

  // Clear PYTHONPATH so the child uses the venv's own site-packages instead
  // of the parent shell's PYTHONPATH. Setting to `undefined` in a spread does
  // NOT unset the var — Node coerces it to the literal string "undefined" —
  // so build the env explicitly and `delete`.
  // Build the complete HF child env so the Wan 2.2 / HunyuanVideo
  // python helpers can authenticate snapshot_download() against gated repos
  // (mirrors the imageGen child-spawn pattern). LTX-2 doesn't currently use
  // a gated repo, but the merge is harmless when no token is configured.
  const childEnv = model.runtime === 'minimax_h3'
    ? safeChildProcessEnv()
    : await hfChildEnv();
  delete childEnv.PYTHONPATH;
  // Force unbuffered Python I/O so tqdm + loguru + our own STAGE: prints flush
  // immediately. Without this, child stdio is line-buffered against a pipe and
  // long inference loops emit nothing to handleLine() for minutes — the UI
  // looks dead even when the model is making progress.
  childEnv.PYTHONUNBUFFERED = '1';
  if (model.runtime === 'minimax_h3') {
    // The H3 repositories are public and the runner is cache-only. Do not hand
    // it an ambient saved HF credential it neither needs nor may transmit.
    delete childEnv.HF_TOKEN;
    delete childEnv.HUGGING_FACE_HUB_TOKEN;
    childEnv.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
    childEnv.HF_HUB_OFFLINE = '1';
    childEnv.TRANSFORMERS_OFFLINE = '1';
  }
  // `spawnDetached` double-forks the render child so it reparents to init
  // (PPID=1) and leaves pm2's process tree — without this a `pm2 restart
  // portos-server` (e.g. on the memory ceiling) SIGINTs the in-flight render
  // mid-inference, since pm2's TreeKill walks PPIDs. (This child previously had
  // no detach at all, so it was fully exposed.) Output streams through on-disk
  // log files under `data/videos/.detached/<jobId>` that the server tails; we
  // still `proc.kill()` it directly by PID on cancel / watchdog. `cleanup: true`
  // lets the helper drop that scratch dir on every terminal path (close/error)
  // so it can't accumulate under data/videos.
  const proc = await spawnDetached(bin, args, {
    env: childEnv,
    controlDir: join(PATHS.videos, '.detached', jobId),
    cleanup: true,
    killProcessGroup: model.runtime === 'wan22' || model.runtime === 'minimax_h3',
  });
  activeProcess = proc;

  // Panel-side completion watchdog. Armed once we see the render's completion
  // marker on stdout; SIGKILLs the child if it hasn't exited after the grace
  // window. clearCompletionWatchdog() runs in every terminal path ('close',
  // 'error') so the timer can't outlive this child or fire against a recycled
  // PID. Armed at most once per child (re-seeing the marker is a no-op).
  let completionWatchdog = null;
  // Set when the watchdog itself fires the SIGKILL. The 'close' handler reads
  // it so it can treat that kill as success (the render already wrote its file —
  // we only killed a post-completion teardown hang) rather than reporting the
  // generic "killed, likely OOM" failure.
  let completionWatchdogFired = false;
  const clearCompletionWatchdog = () => {
    if (completionWatchdog) {
      clearTimeout(completionWatchdog);
      completionWatchdog = null;
    }
  };
  const armCompletionWatchdog = () => {
    if (completionWatchdog) return;
    completionWatchdog = setTimeout(() => {
      // Runs outside the Express request lifecycle — an uncaught throw here
      // would crash the Node process, so guard the whole body.
      try {
        completionWatchdog = null;
        // proc.killed covers a manual-cancel SIGTERM that hasn't reached close
        // yet (killWithEscalation sets it before exitCode/signalCode populate).
        if (activeProcess !== proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
        console.log(`⚠️ video child reported completion but never exited — SIGKILL [${jobId.slice(0, 8)}]`);
        completionWatchdogFired = true;
        proc.kill('SIGKILL');
      } catch (err) {
        console.error(`❌ completion watchdog failed [${jobId.slice(0, 8)}]: ${err.message}`);
      }
    }, COMPLETION_WATCHDOG_GRACE_MS);
    // Don't let the watchdog timer keep the event loop alive on its own.
    if (typeof completionWatchdog.unref === 'function') completionWatchdog.unref();
  };

  // Pre-output idle-stall deadline. Armed at spawn and reset on every child
  // output line (stdout OR stderr — a render loading weights logs to stderr via
  // loguru/tqdm well before any stdout progress). If it fires, the render has
  // produced NO output for the whole generous window — treat it as wedged,
  // SIGKILL it, and let the 'close' handler surface a failed job so the
  // serialized GPU lane frees. Cleared in every terminal path alongside the
  // completion watchdog so it can't fire against a recycled PID.
  let idleStallTimer = null;
  // Set when THIS timer fires the SIGKILL so the 'close' handler reports a
  // clear "stalled — no output" reason instead of the generic "killed, likely
  // OOM" message a bare SIGKILL would otherwise produce.
  let idleStallFired = false;
  const clearIdleStallTimer = () => {
    if (idleStallTimer) {
      clearTimeout(idleStallTimer);
      idleStallTimer = null;
    }
  };
  const armIdleStallTimer = () => {
    idleStallTimer = setTimeout(() => {
      // Outside the Express request lifecycle — guard so an uncaught throw
      // can't crash the Node process.
      try {
        idleStallTimer = null;
        // Also bail if the child is already being torn down by a manual
        // cancel: killWithEscalation() sends SIGTERM and sets `proc.killed`
        // BEFORE exitCode/signalCode populate on close. Without this check the
        // idle timer could still fire, set idleStallFired, and SIGKILL — and
        // the close handler would then finalize a user-canceled render (whose
        // partial .mp4 is on disk) as a SUCCESS instead of canceled/failed.
        if (activeProcess !== proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
        console.log(`⚠️ video child produced no output for ${IDLE_STALL_DEADLINE_MS}ms — stalled, SIGKILL [${jobId.slice(0, 8)}]`);
        idleStallFired = true;
        proc.kill('SIGKILL');
      } catch (err) {
        console.error(`❌ idle-stall watchdog failed [${jobId.slice(0, 8)}]: ${err.message}`);
      }
    }, IDLE_STALL_DEADLINE_MS);
    if (typeof idleStallTimer.unref === 'function') idleStallTimer.unref();
  };
  // Every output line means the render is alive — restart the countdown.
  const resetIdleStallTimer = () => {
    clearIdleStallTimer();
    armIdleStallTimer();
  };
  // Arm immediately: the highest-risk stall is a job that never emits its FIRST
  // line (weights load / kernel compile hangs), so the clock starts at spawn.
  armIdleStallTimer();

  // Hold a sleep-prevention lock for the lifetime of the python child, so a
  // 90s+ render doesn't get aborted by sleep on a laptop. `-s` blocks system
  // sleep (lid-close / low-power), `-i` blocks idle sleep, `-d` blocks display
  // sleep — together they survive everything short of the user forcing sleep
  // from the Apple menu. `-w` makes caffeinate self-exit when our pid does, so
  // no manual cleanup is needed and a server crash mid-render still releases
  // the assertion. macOS-only — `caffeinate` is a darwin binary.
  if (process.platform === 'darwin' && proc.pid) {
    spawn('caffeinate', ['-dis', '-w', String(proc.pid)], { stdio: 'ignore', detached: false }).on('error', () => {});
  }
  // Without an 'error' handler, a missing/non-executable pythonPath would
  // crash the server with an unhandled error event.
  proc.on('error', (err) => {
    clearCompletionWatchdog();
    clearIdleStallTimer();
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.log(`❌ Video generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    activeProcess = null;
    // Spawn failed, so proc.on('close') will never fire — clean up every
    // temp file we own here, including the multipart upload, otherwise
    // ENOENT/permission errors leak files in os.tmpdir().
    if (resizedSrcTempPath) unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) unlink(resizedLastTempPath).catch(() => {});
    for (const p of resizedKeyframeTempPaths) unlink(p).catch(() => {});
    for (const p of icReferenceTempPaths) unlink(p).catch(() => {});
    if (uploadedTempPath) unlink(uploadedTempPath).catch(() => {});
    for (const p of uploadedTempPaths) unlink(p).catch(() => {});
    // Defensive: a direct caller (bypassing the route) may pass audioFilePath
    // without also threading it through uploadedTempPaths. Unlink it here too —
    // double-unlink on the route's path is harmless (catch swallows ENOENT).
    if (audioFilePath && !uploadedTempPaths.includes(audioFilePath)) {
      unlink(audioFilePath).catch(() => {});
    }
    closeJobAfterDelay(jobs, jobId);
  });

  let missingPyModule = null;

  // The python child's STATUS:/STAGE:/DOWNLOAD:/tqdm → SSE-frame parser lives
  // in generateVideoHelpers.js so it can be unit-tested without a real child.
  // Returns true for a recognized progress/status/noise line (suppress raw
  // logging), false for an unhandled line worth raw-logging.
  const handleLine = makeVideoGenLineHandler({ job, jobId, pythonNoiseRe: PYTHON_NOISE_RE });

  // Per-stream line readers carry the partial trailing line across chunk
  // boundaries and decode through a StringDecoder, so a marker (or multibyte
  // char) split across a pipe chunk can't tear an event — and the final
  // unterminated line is emitted on 'close' via flush().
  const stdoutReader = createLineReader((raw) => {
    const line = raw.trim();
    if (!line) return;
    // mlx_video emits one JSON line on stdout when finished — capture it
    // for the result metadata; otherwise raw-log so we can debug failures.
    try {
      const parsed = JSON.parse(line);
      if (parsed.video_path) {
        job.resultJson = parsed;
        // The result JSON is the strongest "work is done" signal — arm the
        // watchdog so a post-completion teardown hang can't wedge the job.
        armCompletionWatchdog();
      }
      return;
    } catch { /* not JSON */ }
    // Some runtimes don't print the result JSON but do log the final
    // decode+mux line right before they should exit — treat it the same way.
    if (MUXING_DONE_RE.test(line)) armCompletionWatchdog();
    console.log(`🐍-out [${jobId.slice(0, 8)}] ${line}`);
  });
  const stderrReader = createLineReader((raw) => {
    // Record the root-cause module only — downstream imports in the same
    // traceback raise the same error against later names.
    if (!missingPyModule) {
      const m = raw.match(MODULE_NOT_FOUND_RE);
      if (m) missingPyModule = m[1];
    }
    if (!handleLine(raw)) console.log(`🐍 [${jobId.slice(0, 8)}] ${raw.trim()}`);
  }, { splitRe: /[\n\r]+/ });

  proc.stdout.on('data', (chunk) => {
    // Any output proves the render is progressing — restart the idle-stall
    // countdown before parsing so a slow-but-alive render is never killed.
    resetIdleStallTimer();
    stdoutReader.push(chunk);
  });

  proc.stderr.on('data', (chunk) => {
    // Weight-load / kernel-compile progress often streams to stderr (loguru,
    // tqdm) long before the first stdout line — count it as liveness too.
    resetIdleStallTimer();
    stderrReader.push(chunk);
  });

  proc.on('close', async (code, signal) => {
    // Flush any final unterminated line each stream buffered (the JSON result,
    // a missing-module trace) BEFORE clearing the watchdogs, so a flush that
    // captures the result JSON and re-arms the completion watchdog is then
    // immediately cancelled by clearCompletionWatchdog() rather than firing a
    // stray SIGKILL during teardown.
    stdoutReader.flush();
    stderrReader.flush();
    clearCompletionWatchdog();
    clearIdleStallTimer();
    activeProcess = null;
    // Wrap the whole teardown so a throw from finalizeGeneratedVideo (history
    // save, thumbnail, file move) can't leak as an unhandled rejection — on
    // Node ≥15 that kills the process AND strands the media job `running` with
    // no terminal SSE. The catch routes any failure through the job's error
    // finalizer so the client still gets a terminal 'failed' event.
    try {
      // Cleanup the resized temp images if we made them. Track via flags rather
      // than a path-prefix check — tmpdir() can return a symlinked path
      // (macOS /var → /private/var) so startsWith() can silently miss.
      if (resizedSrcTempPath) await unlink(resizedSrcTempPath).catch(() => {});
      if (resizedLastTempPath) await unlink(resizedLastTempPath).catch(() => {});
      for (const p of resizedKeyframeTempPaths) await unlink(p).catch(() => {});
      // The throwaway still→clip encodes for an image-kind IC reference. The
      // ORIGINAL stills are gallery files (or route-staged uploads) and are NOT
      // ours to remove — only these temp clips.
      for (const p of icReferenceTempPaths) await unlink(p).catch(() => {});
      // Cleanup the original multipart upload temp file too — without this,
      // every i2v request leaves a file in os.tmpdir() forever.
      if (uploadedTempPath) await unlink(uploadedTempPath).catch(() => {});
      for (const p of uploadedTempPaths) await unlink(p).catch(() => {});
      // Defensive: catch audioFilePath too in case a direct caller passed it
      // without threading through uploadedTempPaths. Skip when the route
      // already covered it (extraUploadedTempPaths.push(audioFilePath)).
      if (audioFilePath && !uploadedTempPaths.includes(audioFilePath)) {
        await unlink(audioFilePath).catch(() => {});
      }

      // A PortOS-fired SIGKILL (completion-teardown watchdog OR idle-stall
      // deadline) is a SUCCESS when the output file is already on disk and
      // non-empty — e.g. a runtime that wrote its .mp4 but never printed a
      // recognized completion marker, then hung: the idle timer kills it, but
      // the finished video must be kept, not discarded as "no output". A kill
      // with no output on disk (a genuine pre-output stall, or a marker from a
      // malformed runtime that wrote nothing) still fails loudly below.
      const watchdogSuccess = isWatchdogSuccess({ completionWatchdogFired, idleStallFired, signal, outputPath });

      if (code !== 0 && !watchdogSuccess) {
        job.status = 'error';
        let reason;
        if (missingPyModule) {
          const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
          if (runtimeInfo) {
            // The probe believed the venv was ready but a runtime import
            // disagreed — drop the cached "ready" so the next /runtime-status
            // re-probes and the install banner re-appears.
            invalidateByovReadyCache(runtimeInfo.id);
            reason = `Python module '${missingPyModule}' is missing from the ${runtimeInfo.label} runtime. Use Install / Repair in Video Gen's model setup panel.`;
          } else {
            reason = `Python module '${missingPyModule}' is missing. Install it into the configured Python environment and retry.`;
          }
        } else if (idleStallFired) {
          // Distinguish a stall-kill from a real OOM kill — both arrive as
          // SIGKILL, but this one means the render produced NO output for the
          // whole idle window and we terminated it to free the GPU lane.
          reason = `Render stalled — no output for ${Math.round(IDLE_STALL_DEADLINE_MS / 1000)}s; terminated to free the GPU queue (raise VIDEOGEN_IDLE_STALL_MS if this was a legitimately slow render)`;
        } else if (signal) {
          // Signal → actionable cause (SIGABRT = the macOS Metal command-buffer
          // watchdog, SIGBUS/SIGSEGV = a native MLX/Metal crash, SIGKILL = OOM),
          // stamped with the runtime fingerprint that died so the report is
          // self-documenting. See describeSignalDeath in generateVideoHelpers.js.
          reason = describeSignalDeath(signal, {
            fingerprint: await pickDeathFingerprint({ emitted: job.runtime, runtimeId: model.runtime }),
          });
        } else {
          reason = `Exit code ${code}`;
        }
        console.log(`❌ Video generation failed [${jobId.slice(0, 8)}]: ${reason}`);
        broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}` });
        videoGenEvents.emit('failed', { generationId: jobId, error: reason });
      } else {
        if (watchdogSuccess) {
          const killCause = idleStallFired ? 'idle-stall deadline' : 'completion teardown hang';
          console.log(`⚠️ video child force-killed (${killCause}) — output is intact [${jobId.slice(0, 8)}]`);
        }
        await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed, mutateHistory: mutateVideoHistory });
      }
    } catch (err) {
      // Finalize/teardown threw — fail the job loudly instead of crashing the
      // process. The job may already be partway through finalize, so force the
      // error state and emit the terminal event the client is waiting on.
      job.status = 'error';
      console.error(`❌ Video close handler failed [${jobId.slice(0, 8)}]: ${err.message}`);
      broadcastSse(job, { type: 'error', error: `Generation failed: ${err.message}` });
      videoGenEvents.emit('failed', { generationId: jobId, error: err.message });
    } finally {
      closeJobAfterDelay(jobs, jobId);
    }
  });

  return { jobId, generationId: jobId, filename, mode: 'local', model: modelId };
}

// Generate a chain of N video chunks, each conditioned on the one before it,
// then stitch them into a single longer clip. Reports progress + terminal
// events against the OUTER jobId (so the mediaJobQueue's dispatcher sees one
// logical job through the chain) while each inner chunk runs as a normal
// generateVideo() with its own inner jobId, file, and history entry.
//
// Continuation strategy (`lib/videoContinuity.js`, tunable via
// `contextFrames`):
//
//   'window' — chunk N+1 is an `extend` render conditioned on a clip cut from
//     the last `contextFrames` frames of chunk N, so the model inherits the
//     scene's MOTION, not just its final pose. Requires a runtime with an
//     extend pipeline (ltx2 today) and applies whatever mode the chain started
//     in. Because extend returns `source + extension`, each windowed chunk
//     opens with an echo of the window; that echo is measured and dropped
//     inside the stitch's concat filter graph, so the timeline holds each
//     frame exactly once while the chunk files stay as the model rendered
//     them.
//   'frame' — the historical hop: extract chunk N's last frame and run chunk
//     N+1 as image-to-video off that still. What every other runtime gets, and
//     what `contextFrames: 0` opts back into.
//
// On completion the inner chunk entries are hidden so only the stitched clip
// is visible by default; the user can toggle hidden in the gallery to
// inspect individual chunks.
//
// On cancel the chain stops before the next chunk; the in-flight chunk's
// child is SIGTERM'd by cancel() and surfaces a 'failed' event we translate
// into a chain-level failure. Already-completed inner chunks are hidden but
// not deleted (the partial output is still on disk if the user wants it).
//
// `chunkPrompts` (#3695) optionally steers each chunk individually: entry i is
// chunk i's prompt, and a null/blank/missing entry falls back to the main
// `prompt`. It is destructured out of `rest` on purpose so the per-chunk
// generateVideo() calls below never receive the whole list.
export async function generateChainedVideo({ chunks, chunkPrompts, contextFrames, jobId: outerJobId, ...rest }) {
  const totalChunks = Number(chunks) || 1;
  if (totalChunks === 1) {
    return generateVideo({ jobId: outerJobId, ...rest });
  }
  if (!outerJobId) throw new ServerError('generateChainedVideo requires jobId', { status: 500, code: 'INTERNAL' });

  const chainModel = resolveVideoModel(rest.modelId || defaultVideoModelId());
  const chainError = videoChainUnsupportedError(chainModel);
  if (chainError) throw chainError;

  // How chunk N+1 sees chunk N. 'window' hands LTX-2's extend pipeline the
  // prior chunk's last `windowFrames` frames (motion + appearance); 'frame'
  // is the historical single-still i2v hop, and is what every runtime without
  // an extend pipeline resolves to. See lib/videoContinuity.js.
  const windowFrames = resolveContextFrames(contextFrames);
  const continuity = resolveContinuityStrategy({ model: chainModel, contextFrames: windowFrames });
  // Mirrors generateVideo's own default — the trim math converts frame indices
  // to audio timestamps, so it can't run on an undefined rate.
  const chainFps = Number(rest.fps) > 0 ? Number(rest.fps) : 24;
  // Latents each chained chunk asks ExtendPipeline to append. buildLtx2Args
  // derives the same number from the same numFrames; the trim below subtracts
  // the pixel frames they decode to, so the two have to stay in step.
  const chunkExtendLatents = extendLatentFrames(rest.numFrames);

  const chainState = { stopped: false };
  activeChain = chainState;

  // Hold an outer job entry so attachSseClient(outerJobId) wires up against
  // the same SSE stream the queue sees. Without this, /api/video-gen/:id/events
  // attached at the outer id would 404 because no `jobs` map entry exists.
  const outerJob = { id: outerJobId, clients: [], status: 'running' };
  jobs.set(outerJobId, outerJob);

  const chunkIds = [];
  let currentSource = rest.sourceImagePath;
  // 'window' continuation: the tail slice of the prior chunk that the next one
  // conditions on. A fresh short clip per hop, NOT the prior chunk's whole
  // output — extend_from_video returns `source + extension`, so conditioning
  // on the full clip would make every chunk re-contain the one before it (the
  // stitch then repeats that content once per hop) while the conditioning cost
  // grew with the chain. Written under tmpdir and deleted when the chain ends.
  let currentContextClip = null;
  const contextClipPaths = [];
  // Echoed-context cut for each chunk that has one: where the chunk's own new
  // footage starts, and how many frames it therefore contributes. Handed to
  // stitchVideos, which applies the cuts in its concat filter graph — the
  // chunk files themselves are never rewritten, so the chain pays exactly one
  // encode (the stitch) instead of one per chunk plus the stitch.
  const chunkTrims = new Map();
  // First chunk always preserves the user's mode (text, image, fflf or extend)
  // and is never trimmed: in an extend chain its output is `source clip +
  // extension`, and the source clip belongs in the result exactly once — here.
  // Chunks 1+ take the resolved continuity path instead.
  const firstMode = rest.mode || (currentSource ? 'image' : 'text');

  const runChunk = (i) => new Promise((resolve, reject) => {
    const innerJobId = randomUUID();
    chunkIds.push(innerJobId);
    const onProgress = (e) => {
      if (e.generationId !== innerJobId) return;
      const innerProg = typeof e.progress === 'number' ? e.progress : 0;
      const aggregate = (i + Math.max(0, Math.min(1, innerProg))) / totalChunks;
      videoGenEvents.emit('progress', {
        generationId: outerJobId,
        progress: aggregate,
        step: typeof e.step === 'number' ? e.step : undefined,
        totalSteps: typeof e.totalSteps === 'number' ? e.totalSteps : undefined,
        message: `Chunk ${i + 1}/${totalChunks}${e.message ? ` — ${e.message}` : ''}`,
      });
      broadcastSse(outerJob, {
        type: 'progress',
        progress: aggregate,
        message: `Chunk ${i + 1}/${totalChunks}`,
      });
    };
    const detach = () => {
      videoGenEvents.off('progress', onProgress);
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
    };
    const onCompleted = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      resolve(e);
    };
    const onFailed = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      reject(new Error(e.error || 'chunk failed'));
    };
    videoGenEvents.on('progress', onProgress);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    // Bump the seed by chunk index when the user supplied one — keeps each
    // chunk visually varied while remaining reproducible from the user's
    // chosen seed. When seed is unset, generateVideo picks one randomly
    // per chunk (existing behavior).
    const chunkSeed = rest.seed != null && rest.seed !== ''
      ? Number(rest.seed) + i
      : undefined;

    // Chunks 1+ on a window-continuity chain re-enter as extend renders
    // conditioned on the tail clip built after the previous chunk, whatever
    // mode the chain STARTED in — a text or i2v chain gets the same motion
    // carry-over an extend chain does, instead of restarting from a still.
    const isWindowHop = continuity === 'window' && i > 0;
    // Per-chunk beat (#3695). `chunkPrompts` is already normalized (blank →
    // null) by prepareVideoGenParams, but re-guard on emptiness here too so a
    // direct service caller can't hand a chunk an empty prompt — an absent beat
    // must always resolve to the main prompt, never to ''.
    const beat = chunkPrompts?.[i];
    const chunkPrompt = (typeof beat === 'string' && beat.trim() !== '') ? beat : rest.prompt;

    generateVideo({
      ...rest,
      prompt: chunkPrompt,
      seed: chunkSeed,
      jobId: innerJobId,
      // window hop: condition on the tail clip cut from the prior chunk, so
      // the model reads motion out of it rather than a single static pose.
      // frame hop: condition on the prior chunk's extracted last frame.
      sourceImagePath: isWindowHop ? null : currentSource,
      extendFromVideoPath: isWindowHop ? currentContextClip : (i === 0 ? rest.extendFromVideoPath : null),
      // Only the first chunk consumes the user's uploadedTempPath (durable
      // copy under data/uploads). Later chunks condition on the prior chunk
      // instead — a tail window (window hop) or an extracted frame (frame hop).
      uploadedTempPath: i === 0 ? rest.uploadedTempPath : null,
      uploadedTempPaths: i === 0 ? (rest.uploadedTempPaths || []) : [],
      hidden: true,
      mode: isWindowHop ? 'extend' : (i === 0 ? firstMode : 'image'),
      // After the first chunk, drop FFLF-style last image — chained
      // continuation conditions on one thing, the tail of the chunk before it,
      // and has no second anchor to pin an end frame to.
      lastImagePath: i === 0 ? rest.lastImagePath : null,
      // Multi-keyframe interpolation only makes sense for the first chunk
      // (the user pinned specific frame indices in a single clip). Subsequent
      // chunks fall through to the image-chain path, conditioning on the
      // prior chunk's tail frame.
      keyframes: i === 0 ? rest.keyframes : null,
    }).catch((err) => {
      detach();
      reject(err);
    });
  });

  // The conditioning windows are scratch input to the next chunk, never
  // output — drop them on every terminal path (both of which always run) so a
  // long chain doesn't leave a trail of clips in tmpdir. Best-effort and
  // fire-and-forget: a leftover temp file must never fail a finished render.
  const cleanupContextClips = () => {
    for (const p of contextClipPaths) unlink(p).catch(() => {});
    contextClipPaths.length = 0;
  };
  const finishOk = (payload) => {
    if (activeChain === chainState) activeChain = null;
    cleanupContextClips();
    videoGenEvents.emit('completed', { generationId: outerJobId, ...payload });
    broadcastSse(outerJob, { type: 'complete', result: payload });
    closeJobAfterDelay(jobs, outerJobId);
  };
  const finishFail = (error) => {
    if (activeChain === chainState) activeChain = null;
    cleanupContextClips();
    videoGenEvents.emit('failed', { generationId: outerJobId, error });
    broadcastSse(outerJob, { type: 'error', error });
    closeJobAfterDelay(jobs, outerJobId);
  };

  // Schedule the chain on the next tick and return the descriptor
  // synchronously — matches generateVideo's spawn-then-emit contract.
  (async () => {
    for (let i = 0; i < totalChunks; i++) {
      if (chainState.stopped) {
        await setHistoryItemsHidden(chunkIds, true);
        finishFail('Canceled mid-chain');
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const completed = await runChunk(i).catch((err) => ({ error: err.message }));
      if (completed?.error) {
        await setHistoryItemsHidden(chunkIds, true);
        finishFail(completed.error);
        return;
      }
      // The chunk's output file is always <innerJobId>.mp4 under PATHS.videos
      // (see generateVideo: filename = `${jobId}.mp4`).
      const chunkId = chunkIds[chunkIds.length - 1];
      const chunkPath = join(PATHS.videos, `${chunkId}.mp4`);

      if (continuity === 'window') {
        // One probe serves both cuts below. Neither rewrites chunkPath, so the
        // count stays valid for both — worth keeping to one call because
        // probeFrameCount falls back to a full decode pass when the container
        // header carries no nb_frames.
        // eslint-disable-next-line no-await-in-loop
        const frames = await probeFrameCount(chunkPath);

        // A window hop's render is `context window + new frames`. The window is
        // the tail of the chunk before it, which the stitched timeline already
        // holds, so record where the new footage starts and let the stitch drop
        // the echo in its filter graph. Measured from the RENDERED length rather
        // than from the window we supplied: the VAE snaps the encoded context up
        // to a latent boundary, so the echo is usually a few frames longer than
        // what we handed in.
        let contextPrefix = 0;
        if (i > 0) {
          contextPrefix = contextPrefixFrames({ totalFrames: frames, extendLatents: chunkExtendLatents });
          if (contextPrefix > 0) {
            chunkTrims.set(chunkId, { startFrame: contextPrefix, frames: frames - contextPrefix });
          } else {
            console.log(`⚠️ Chunk ${i + 1}/${totalChunks} context prefix unmeasurable (frames=${frames ?? 'unknown'}), leaving it untrimmed`);
          }
        }

        if (i < totalChunks - 1) {
          // Cut the next hop's conditioning window off this chunk's tail. Both
          // the count and the cut clamp: a window longer than the chunk simply
          // conditions on all of it.
          //
          // An unprobeable length clamps the same way, which means the whole
          // chunk becomes the window — the unbounded conditioning this exists
          // to avoid, for one hop. It self-corrects (the next chunk's prefix
          // trim measures the echo off the render, not off the window), but say
          // so rather than letting the fallback be silent.
          if (frames == null) {
            console.log(`⚠️ Chunk ${i + 1}/${totalChunks} length unprobeable — conditioning the next chunk on the whole clip instead of a ${windowFrames}-frame window`);
          }
          const contextPath = join(tmpdir(), `chaincontext-${chunkId}.mp4`);
          // eslint-disable-next-line no-await-in-loop
          const cut = await trimVideoFromFrame(chunkPath, contextPath, {
            // Floored at the echo the stitch is going to drop: the window must
            // come from this chunk's OWN footage, never from the replay of the
            // one before it. (The chunk file still holds that replay now that
            // the cut happens at stitch time.)
            startFrame: Math.max(contextPrefix, tailWindowStartFrame({ totalFrames: frames, frames: windowFrames })),
            fps: chainFps,
          });
          if (!cut.ok) {
            await setHistoryItemsHidden(chunkIds, true);
            finishFail(`Failed to build the continuation context window between chunks: ${cut.reason}`);
            return;
          }
          contextClipPaths.push(contextPath);
          currentContextClip = contextPath;
        }
      } else if (i < totalChunks - 1) {
        // extractLastFrame caches by id, so re-clicks (e.g. from gallery
        // "Continue") don't re-spawn ffmpeg.
        // eslint-disable-next-line no-await-in-loop
        const frame = await extractLastFrame(chunkId).catch((err) => ({ error: err.message }));
        if (frame?.error) {
          await setHistoryItemsHidden(chunkIds, true);
          finishFail(`Failed to extract frame between chunks: ${frame.error}`);
          return;
        }
        currentSource = join(PATHS.images, frame.filename);
      }
    }

    const stitched = await stitchVideos(chunkIds, {
      id: outerJobId,
      filenamePrefix: 'chained',
      historyKey: 'chainedFrom',
      promptOverride: rest.prompt || null,
      // Persist the beats alongside the stitched clip so the gallery entry (and
      // a Remix off it) carries the same source of truth the chain rendered
      // from — the individual chunk entries only ever hold their own resolved
      // prompt, which loses which of them were explicit beats vs. fallbacks.
      chunkPrompts: chunkPrompts?.some(Boolean) ? chunkPrompts : null,
      // Echoed-context prefixes to cut out of each windowed chunk as the
      // timeline is assembled, rather than by pre-encoding the chunk files.
      trims: chunkTrims.size ? chunkTrims : null,
    }).catch((err) => ({ error: err.message }));
    if (stitched?.error) {
      await setHistoryItemsHidden(chunkIds, true);
      finishFail(`Stitch failed: ${stitched.error}`);
      return;
    }
    await setHistoryItemsHidden(chunkIds, true);
    finishOk({
      filename: stitched.filename,
      thumbnail: stitched.thumbnail,
      path: `/data/videos/${stitched.filename}`,
      chainedFrom: chunkIds,
    });
  })().catch((err) => {
    console.log(`❌ chain orchestration crashed [${outerJobId.slice(0, 8)}]: ${err.message}`);
    finishFail(err.message);
  });

  // Match the synchronous shape of generateVideo so the route's response
  // assembly doesn't need a chain-specific branch. The actual filename is
  // delivered via SSE 'complete' once the chain settles.
  return {
    jobId: outerJobId,
    generationId: outerJobId,
    filename: `chained-${outerJobId}.mp4`,
    mode: 'local',
    model: rest.modelId,
  };
}

// Hide many history entries in one load+save. The per-id setHistoryItemHidden
// would re-read + atomic-write the entire history file once per id; for an
// 8-chunk chain that's 16 file ops on every terminal path. Best-effort —
// errors are swallowed because the stitched clip is more important than
// the visibility flag.
async function setHistoryItemsHidden(ids, hidden) {
  if (!ids?.length) return;
  const wanted = new Set(ids);
  // Serialized through the shared history tail so a concurrent write path
  // (a download completing, a render finalizing) can't clobber this update.
  await mutateVideoHistory((history) => {
    for (const item of history) {
      if (wanted.has(item.id)) item.hidden = !!hidden;
    }
    return history;
  }).catch(() => {});
}

// Extract the last frame of a video as a PNG into data/images/ — used to
// chain a clip into Imagine for "continue from last frame" remixing.
export async function extractLastFrame(historyId) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  // Validate against tampered history entries — without this, a `../...`
  // filename could make ffmpeg read arbitrary files outside data/videos.
  const videoPath = safeUnder(PATHS.videos, item.filename);
  if (!videoPath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(videoPath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  await ensureDir(PATHS.images);
  // Same path-traversal concern as `item.filename` above — `item.id` could
  // contain path separators or `..` if history.json was tampered with.
  // generateVideo writes ids via randomUUID() (matches /^[a-f0-9-]{36}$/),
  // so reject anything else outright.
  if (!/^[a-f0-9-]{36}$/i.test(item.id)) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const frameFilename = `lastframe-${item.id}.png`;
  const framePath = join(PATHS.images, frameFilename);
  // Cache hit: ffmpeg-extracted frames are deterministic for a given video,
  // so a file already on disk is reusable. UI clicks "Continue" repeatedly
  // (palette → continue, gallery → continue, etc.) and re-extracting on
  // every click was wasting 1–2s per click + spawning ffmpeg children.
  // Validate non-zero size — a prior ffmpeg crash could leave a 0-byte
  // placeholder, which would otherwise be served as a broken image forever.
  // Treat ANY stat failure (EACCES, EIO, etc.) as a cache miss rather than
  // letting it abort the request.
  const safeStatSize = (path) => {
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      return s ? s.size : null;
    } catch {
      return null;
    }
  };
  // Sidecar carries the source video's prompt + provenance so the extracted
  // frame surfaces in the gallery with searchable metadata. Cache-hit path
  // calls this too so frames extracted before this change get backfilled.
  // `wx` flag makes the create-if-missing race-free — EEXIST is the no-op.
  const sidecarPath = join(PATHS.images, frameFilename.replace('.png', '.metadata.json'));
  const writeSidecar = async () => {
    const meta = {
      filename: frameFilename,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      modelId: item.modelId,
      width: item.width,
      height: item.height,
      seed: item.seed,
      extractedFromVideoId: item.id,
      extractedFromVideoFilename: item.filename,
      extractedAt: 'last-frame',
      kind: 'extracted-frame',
      createdAt: new Date().toISOString(),
    };
    await writeFile(sidecarPath, JSON.stringify(meta, null, 2), { flag: 'wx' }).catch(() => {});
  };

  const cachedSize = safeStatSize(framePath);
  if (cachedSize != null && cachedSize > 0) {
    await writeSidecar();
    return { filename: frameFilename, path: `/data/images/${frameFilename}` };
  }
  if (cachedSize === 0) await unlink(framePath).catch(() => {});

  return new Promise((resolve, reject) => {
    // -sseof -1.0 seeks 1s before end. The previous -0.1 was too tight on
    // videos with audio (B-frames + AV mux push the last keyframe earlier
    // than 100 ms from EOF), and ffmpeg silently returned 0 frames while
    // sometimes still exiting 0 — leaving a phantom-success log + missing
    // file. The output file gets a -update 1 flag so ffmpeg overwrites
    // any partial file from a prior failed run instead of erroring.
    const proc = spawn(ffmpeg, ['-sseof', '-1.0', '-i', videoPath, '-update', '1', '-vframes', '1', '-q:v', '2', '-y', framePath], { env: safeChildProcessEnv(), stdio: 'ignore' });
    proc.on('close', async (code) => {
      // Wrap the body so a throw (e.g. writeSidecar) routes to reject() instead
      // of leaking an unhandled rejection AND leaving this Promise forever
      // pending — the executor only settles via the explicit resolve/reject.
      try {
        // safeStatSize swallows throws so the async handler can't leak an
        // unhandled rejection on transient stat errors — null is treated as
        // "extraction failed".
        const writtenSize = safeStatSize(framePath);
        if (code !== 0 || writtenSize == null || writtenSize === 0) {
          // A 0-byte file is a partial extraction, not a cache-worthy result —
          // delete it so the next call retries instead of returning a broken
          // image from the cache hit above.
          if (writtenSize === 0) await unlink(framePath).catch(() => {});
          return reject(new ServerError('Failed to extract last frame', { status: 500, code: 'FFMPEG_FAILED' }));
        }
        await writeSidecar();
        console.log(`🎞️ Extracted last frame: ${frameFilename}`);
        resolve({ filename: frameFilename, path: `/data/images/${frameFilename}` });
      } catch (err) {
        reject(err instanceof ServerError ? err : new ServerError(`Failed to extract last frame: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' }));
      }
    });
    proc.on('error', (err) => {
      reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' }));
    });
  });
}

// Sample N evenly-spaced frames from a video for multi-frame LLM evaluation.
// Thin wrapper around the canonical lib/ffmpeg.js helper `extractEvaluationFrames`
// that derives the video path from the jobId so call-sites don't need to know
// the storage layout. Returns [] on any failure — callers fall back to the
// single-thumbnail prompt path.
export async function sampleEvaluationFrames(jobId, count = 5) {
  const videoPath = join(PATHS.videos, `${jobId}.mp4`);
  if (!existsSync(videoPath)) return [];
  const filenames = await extractEvaluationFrames(videoPath, jobId, count);
  if (filenames.length) console.log(`🎞️ CD sampled ${filenames.length} evaluation frames for ${jobId.slice(0, 8)}`);
  return filenames;
}

// Concat selected videos (preserving order) into a single MP4. Uses ffmpeg's
// concat demuxer with a stream copy, so it's fast and lossless — but the
// inputs must then share codec/resolution. The Media History page already only
// lets users stitch from a single model so this holds in practice.
//
// A caller that needs leading frames dropped from some inputs passes `trims`
// instead; that switches to a concat FILTER GRAPH, which applies the cuts and
// the concat in one encode. Nothing else reaches the filter graph, so the
// hand-stitch path from Media History keeps its stream-copy fast path.
//
// `opts` lets the chained-render code reuse the same ffmpeg path with a
// different identity (id, filename prefix, history-link key, prompt, per-chunk
// beats) without duplicating the validation + concat-manifest plumbing.
export async function stitchVideos(videoIds, opts = {}) {
  const {
    id = randomUUID(),
    filenamePrefix = 'stitched',
    historyKey = 'stitchedFrom',
    promptOverride = null,
    // Per-chunk prompt beats to record on the stitched entry (#3695) — chained
    // renders only; a hand-stitched clip has no beats.
    chunkPrompts = null,
    // Optional `Map<videoId, { startFrame, frames }>` — leading frames to drop
    // from an input, and the frame count it contributes once they're gone.
    //
    // A chained render's windowed chunks open with an echo of the tail window
    // they were conditioned on, which the timeline already holds. Cutting that
    // echo in this concat's filter graph costs nothing beyond the timeline
    // encode; pre-trimming each chunk file instead would add one full encode
    // per chunk and re-grade the trimmed chunks relative to their siblings.
    //
    // `frames` feeds the stitched entry's `numFrames`, because a history
    // entry's own `numFrames` is the count the clip was RENDERED at — a render
    // parameter Remix reuses, not a measurement of what it contributes here.
    trims = null,
  } = opts;
  if (!Array.isArray(videoIds) || videoIds.length < 2) {
    throw new ServerError('Need at least 2 videos to stitch', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const history = await loadHistory();
  const videos = videoIds.map((vid) => history.find((h) => h.id === vid)).filter(Boolean);
  if (videos.length < 2) throw new ServerError('Some videos not found', { status: 400, code: 'VALIDATION_ERROR' });

  // Validate every history-supplied filename through safeUnder before
  // letting it reach ffmpeg's concat manifest. Tampered history entries
  // could otherwise smuggle `..` segments into ffmpeg input.
  const videoPaths = videos.map((v) => safeUnder(PATHS.videos, v.filename));
  if (videoPaths.some((p) => !p)) {
    throw new ServerError('One or more video filenames failed validation', { status: 400, code: 'VALIDATION_ERROR' });
  }
  for (const p of videoPaths) {
    if (!existsSync(p)) throw new ServerError(`Missing: ${basename(p)}`, { status: 404, code: 'NOT_FOUND' });
  }

  // Leading-frame cut per input, in `videos` order. A zero/absent offset means
  // the input joins whole; any non-zero offset routes the whole concat through
  // the filter graph, since only that path can express a cut.
  const trimPlan = videos.map((v) => {
    const startFrame = Math.max(0, Math.floor(Number(trims?.get?.(v.id)?.startFrame) || 0));
    if (startFrame <= 0) return null;
    const frames = Number(trims.get(v.id).frames);
    return { startFrame, frames: Number.isFinite(frames) && frames >= 0 ? frames : null };
  });

  const listFile = join(tmpdir(), `concat-${id}.txt`);
  let listFileWritten = false;
  const writeConcatList = async () => {
    // ffmpeg concat-demuxer escape: per its docs, single quotes in filenames
    // must be replaced with `'\''`. Inside quoted strings ffmpeg also treats
    // backslash as an escape character — on Windows where paths are
    // `C:\foo\bar.mp4`, that corrupts the path. Normalize to forward slashes
    // (which ffmpeg accepts on Windows just fine) before quoting.
    const escapeForConcat = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
    await writeFile(listFile, videoPaths.map((p) => `file '${escapeForConcat(p)}'`).join('\n'));
    listFileWritten = true;
  };

  const outFilename = `${filenamePrefix}-${id}.mp4`;
  const outPath = join(PATHS.videos, outFilename);

  const runFfmpeg = (args) => new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { env: safeChildProcessEnv(), stdio: 'ignore' });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new ServerError('Stitch failed', { status: 500, code: 'FFMPEG_FAILED' })));
    proc.on('error', (err) => reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' })));
  });

  // Tracks whether the trims actually made it into the output, so `numFrames`
  // below reports the timeline that exists rather than the one we asked for.
  let trimsApplied = trimPlan.some(Boolean);
  // Use a try/finally so the concat list temp file is cleaned up even when
  // ffmpeg rejects — otherwise it leaks one file per failed stitch.
  try {
    if (trimsApplied) {
      const args = buildTrimConcatArgs({
        inputs: videoPaths.map((path, i) => ({ path, startFrame: trimPlan[i]?.startFrame || 0 })),
        outPath,
        // Canonical geometry/rate for the graph's normalization filters. Taken
        // from the first input the same way modelId/seed are below — every
        // caller that reaches here stitches one model's own output.
        width: videos[0].width,
        height: videos[0].height,
        fps: videos[0].fps,
        // `concat=a=1` needs an audio leg from EVERY input; one silent clip in
        // the set makes the whole graph video-only.
        withAudio: (await Promise.all(videoPaths.map((p) => hasAudioStream(p)))).every(Boolean),
      });
      const failure = args
        ? await runFfmpeg(args).then(() => null, (err) => err)
        : new Error('could not build the concat filter graph');
      if (failure) {
        // Degrade rather than throw away a whole chained render: the untrimmed
        // inputs were never re-encoded, so they're still in codec lockstep and
        // the stream-copy concat below can salvage the clip. The cost is the
        // echoed context replaying at each trimmed seam.
        console.log(`⚠️ Trimmed concat failed (${failure.message}) — falling back to a stream copy; ${trimPlan.filter(Boolean).length} seam(s) will repeat their context`);
        trimsApplied = false;
      }
    }
    if (!trimsApplied) {
      await writeConcatList();
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath]);
    }
    await optimizeForStreaming(outPath);
  } finally {
    if (listFileWritten) await unlink(listFile).catch(() => {});
  }

  const thumb = await generateThumbnail(outPath, id);
  const stitchedMeta = {
    id,
    prompt: promptOverride != null
      ? promptOverride
      : `Stitched: ${videos.map((v) => v.prompt).join(' + ')}`,
    modelId: videos[0].modelId,
    seed: videos[0].seed ?? 0,
    width: videos[0].width,
    height: videos[0].height,
    numFrames: videos.reduce((sum, v, i) => sum + (
      (trimsApplied ? trimPlan[i]?.frames : null) ?? v.numFrames ?? 0
    ), 0),
    fps: videos[0].fps,
    filename: outFilename,
    thumbnail: thumb,
    createdAt: new Date().toISOString(),
    [historyKey]: videoIds,
    ...(Array.isArray(chunkPrompts) ? { chunkPrompts } : {}),
    // Inherit applied LoRAs from the first constituent clip (a chunk chain
    // shares one LoRA set across all chunks), so the visible stitched entry
    // round-trips LoRAs on Remix the same way a single render does — mirrors
    // how modelId/seed/width above are taken from videos[0].
    ...(Array.isArray(videos[0].loraFilenames) && videos[0].loraFilenames.length ? {
      loraFilenames: videos[0].loraFilenames,
      loraScales: videos[0].loraScales,
    } : {}),
  };
  // Serialized append against the shared history tail (re-reads the freshest
  // list inside the mutator) so a concurrent download/render write can't drop
  // this stitched entry.
  await mutateVideoHistory((history) => { history.unshift(stitchedMeta); return history; });
  console.log(`🎬 Stitched ${videos.length} videos → ${outFilename}`);
  return stitchedMeta;
}

// 2× Lanczos upscale of an existing history item. Writes the upscaled clip
// to a new file (never overwrites the original) and inserts a new history
// entry pointing at it, so the user gets both versions side-by-side in the
// gallery. Doubles width and height; aspect-ratio is preserved exactly.
//
// Returns the new history entry on success; throws ServerError on any
// missing-input / ffmpeg / file-system failure so the route can map it to
// a clean HTTP status.
export async function upscaleHistoryItem(historyId) {
  // Validate the input arg first — failing here surfaces a clean 400 even if
  // the history file happens to contain a record with a malformed id, and
  // it short-circuits the loadHistory I/O for obviously-bogus requests.
  // Use the shared strict UUID regex (the prior /^[a-f0-9-]{36}$/i pattern
  // accepted non-UUID 36-char strings like all-hyphens).
  if (typeof historyId !== 'string' || !UUID_RE.test(historyId)) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  if (item.upscaledFrom) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  const sourcePath = safeUnder(PATHS.videos, item.filename);
  if (!sourcePath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(sourcePath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  // Copy first, then upscale-in-place — keeps the upscaler's atomic-rename
  // contract intact and means a mid-process kill leaves the source clip
  // untouched.
  await copyFile(sourcePath, newPath);
  console.log(`🔍 Upscaling video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}]: 2×`);
  const result = await upscaleVideo2x(newPath);
  if (!result.ok) {
    await unlink(newPath).catch(() => {});
    throw new ServerError(`Upscale failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  const thumbnail = await generateThumbnail(newPath, newId);
  // Build the new history entry from the original, but bump dimensions and
  // tag with `upscaledFrom: <id>` + a reusable suffix on the prompt so the
  // gallery row reads as "<original prompt> (2×)".
  const newEntry = {
    ...item,
    id: newId,
    filename: newFilename,
    width: (Number(item.width) || 0) * 2,
    height: (Number(item.height) || 0) * 2,
    thumbnail,
    createdAt: new Date().toISOString(),
    upscaledFrom: item.id,
    prompt: item.prompt ? `${item.prompt} (2×)` : '(upscaled 2×)',
    // Drop hidden so the upscaled version surfaces in the visible gallery
    // even when the source clip was hidden.
    hidden: false,
  };
  // Serialized append (re-reads inside the mutator) so a concurrent
  // download/render write can't drop the upscaled entry.
  await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
  console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height})`);
  return newEntry;
}

export async function setHistoryItemHidden(id, hidden) {
  let result;
  // Serialized find-and-set through the shared tail; a 404 throw inside the
  // mutator rejects before any save, preserving the not-found semantics.
  await mutateVideoHistory((history) => {
    const item = history.find((h) => h.id === id);
    if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
    item.hidden = !!hidden;
    result = { ok: true, hidden: item.hidden };
    return history;
  });
  return result;
}

export async function deleteHistoryItem(id) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === id);
  if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  // Same path-traversal guard as extractLastFrame — unlink only if the
  // filename resolves to inside the expected dir.
  const videoFile = safeUnder(PATHS.videos, item.filename);
  if (videoFile) await unlink(videoFile).catch(() => {});
  if (item.thumbnail) {
    const thumbFile = safeUnder(PATHS.videoThumbnails, item.thumbnail);
    if (thumbFile) await unlink(thumbFile).catch(() => {});
  }
  // Delete evaluation frame thumbnails written by sampleEvaluationFrames:
  // `${jobId}-f1.jpg` … `${jobId}-f9.jpg` (max count in sampleEvaluationFrames is 5,
  // but 9 is a safe upper bound to catch any future increase).
  for (let i = 1; i <= 9; i++) {
    const frameFile = safeUnder(PATHS.videoThumbnails, `${id}-f${i}.jpg`);
    if (frameFile) await unlink(frameFile).catch(() => {});
  }
  // Serialized removal through the shared tail (re-filters the freshest list),
  // so a concurrent download/render append isn't dropped by this save.
  await mutateVideoHistory((h) => h.filter((x) => x.id !== id));
  // Drop the derived index row with the entry (#2738) — keyed by job id, the
  // ref the index wrote it under. Non-fatal + dynamically imported; see the
  // matching hook in imageGen/local.js#deleteImage for the rationale.
  await import('../mediaAssetIndex/index.js')
    .then((m) => m.unindexVideo(id))
    .catch((err) => console.error(`❌ Media index video delete hook: ${err.message}`));
  console.log(`🗑️ Deleted video: ${item.filename}`);
  return { ok: true };
}
