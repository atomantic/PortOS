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
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS, readJSONFile, atomicWrite, UUID_RE } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { getVideoModels, getDefaultVideoModelId, getTextEncoderRepo } from '../../lib/mediaModels.js';
import { findFfmpeg, safeUnder, generateThumbnail, optimizeForStreaming, upscaleVideo2x, extractEvaluationFrames } from '../../lib/ffmpeg.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { stripDebugMallocEnv } from '../../lib/processEnv.js';

// Path to the dgrauet/ltx-2-mlx venv populated by `INSTALL_LTX2=1
// scripts/setup-image-video.sh`. Used when a model entry has
// `runtime: 'ltx2'`. The companion helper at scripts/generate_ltx2.py
// imports `ltx_pipelines_mlx` from this venv and emits the same SSE
// progress protocol (STAGE:/STATUS:/DOWNLOAD:) as the mlx_video CLI.
const LTX2_VENV_PYTHON = join(homedir(), '.portos', 'ltx-2-mlx', '.venv', 'bin', 'python3');
const LTX2_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_ltx2.py');

// Wan 2.2 MLX runtime — osama-ata/Wan2.2-mlx cloned at
// ~/.portos/wan2.2-mlx/. The wrapper at scripts/generate_wan22.py
// subprocesses upstream generate.py so PortOS releases don't drift from
// upstream's CLI. Provisioned via `INSTALL_WAN22=1 bash scripts/setup-image-video.sh`.
const WAN22_VENV_PYTHON = join(homedir(), '.portos', 'wan2.2-mlx', '.venv', 'bin', 'python3');
const WAN22_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_wan22.py');
const WAN22_REPO_DIR = join(homedir(), '.portos', 'wan2.2-mlx');

// HunyuanVideo MLX runtime — gaurav-nelson/HunyuanVideo_MLX cloned at
// ~/.portos/hunyuan-video-mlx/. ~60 GB resident at bf16 so practical only
// with the 4-bit Gemma text encoder + everything else evicted. Provisioned
// via `INSTALL_HUNYUAN=1 bash scripts/setup-image-video.sh`.
const HUNYUAN_VENV_PYTHON = join(homedir(), '.portos', 'hunyuan-video-mlx', '.venv', 'bin', 'python3');
const HUNYUAN_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_hunyuan.py');
const HUNYUAN_REPO_DIR = join(homedir(), '.portos', 'hunyuan-video-mlx');

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';

const MODULE_NOT_FOUND_RE = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/;

// Catalog comes from data/media-models.json (see server/lib/mediaModels.js).
// Cached as a plain object at boot for O(1) lookup by id, matching the prior shape.
export const VIDEO_MODELS = Object.fromEntries(getVideoModels().map((m) => [m.id, m]));

// Per-runtime metadata for "bring-your-own-venv" video runtimes — those that
// resolve their own Python interpreter inside buildArgs (so the legacy
// mlx_video `settings.imageGen.local.pythonPath` is irrelevant). Single
// source of truth: the BYOV_VIDEO_RUNTIMES Set + the /setup/runtime-* routes
// + the client install banner all derive from this map's keys.
//
// `importProbe` is a tiny Python expression run by isByovRuntimeReady() to
// confirm the venv's *packages* are actually installed (not just the venv
// binary). A partial install (e.g. setup script aborted after `uv venv`
// before `uv pip install`) leaves the binary present but no torch — without
// this probe the UI would hide the install banner and renders would fail
// with a deep ImportError inside the runner script.
export const BYOV_RUNTIME_INFO = Object.freeze({
  hunyuan: {
    id: 'hunyuan',
    label: 'HunyuanVideo MLX',
    venvPython: HUNYUAN_VENV_PYTHON,
    repoDir: HUNYUAN_REPO_DIR,
    installEnvVar: 'INSTALL_HUNYUAN',
    repoUrl: 'https://github.com/gaurav-nelson/HunyuanVideo_MLX',
    // `hyvideo` isn't pip-installed — mirror the runner's sys.path prepend so
    // the probe walks the same transitive import chain (loguru, diffusers, …).
    importProbe: `import sys; sys.path.insert(0, ${JSON.stringify(HUNYUAN_REPO_DIR)}); import hyvideo.inference`,
  },
  wan22: {
    id: 'wan22',
    label: 'Wan 2.2 MLX',
    venvPython: WAN22_VENV_PYTHON,
    repoDir: WAN22_REPO_DIR,
    installEnvVar: 'INSTALL_WAN22',
    repoUrl: 'https://github.com/osama-ata/Wan2.2-mlx',
    // Walks the package's __init__ chain so transitive deps absent from
    // upstream's pyproject.toml (e.g. einops, imported by wan/modules/vae2_1.py)
    // fail the probe instead of slipping past a flat torch/transformers check.
    importProbe: 'import wan',
  },
  ltx2: {
    id: 'ltx2',
    label: 'LTX-2 MLX',
    venvPython: LTX2_VENV_PYTHON,
    repoDir: join(homedir(), '.portos', 'ltx-2-mlx'),
    installEnvVar: 'INSTALL_LTX2',
    repoUrl: 'https://github.com/dgrauet/ltx-2-mlx',
    // Matches the post-install check setup-image-video.sh runs after
    // `uv sync` (`import ltx_pipelines_mlx` is the canonical health signal
    // for this venv).
    importProbe: 'import ltx_pipelines_mlx',
  },
});

export const BYOV_VIDEO_RUNTIMES = Object.freeze(new Set(Object.keys(BYOV_RUNTIME_INFO)));

export function isByovRuntimeInstalled(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info) return false;
  return existsSync(info.venvPython);
}

// Cache the import-probe result per runtime for the life of the server
// process (or until invalidateByovReadyCache is called). The probe itself
// spawns python + imports torch — measured ~500ms-2s warm, ~5s cold — so
// repeating it on every status request is too slow. Positive results are
// stable (you don't accidentally uninstall packages); negative results we
// re-probe each request so a finished install reflects immediately. The
// install-completion path in routes/videoGen.js explicitly invalidates
// the entry for the runtime it just installed.
const readyCache = new Map();
export function invalidateByovReadyCache(runtimeId) {
  if (runtimeId) readyCache.delete(runtimeId); else readyCache.clear();
}
export async function isByovRuntimeReady(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info) return false;
  if (!existsSync(info.venvPython)) return false;
  if (readyCache.get(runtimeId) === true) return true;
  const probeOk = await new Promise((resolve) => {
    const child = spawn(info.venvPython, ['-c', info.importProbe], {
      env: stripDebugMallocEnv(process.env),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve(false); }, 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  if (probeOk) readyCache.set(runtimeId, true);
  return probeOk;
}

// Throws the same shape the per-runtime buildArgs used to throw inline — a
// 500 with a stable runtime-specific code the route layer and tests already
// match against. The error codes are LTX2_VENV_MISSING / WAN22_VENV_MISSING
// / HUNYUAN_VENV_MISSING; keep `runtimeId.toUpperCase()` to preserve them.
export function assertByovRuntimeInstalled(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info) return;
  if (existsSync(info.venvPython)) return;
  throw new ServerError(
    `${info.label} venv not found at ${info.venvPython}. Run \`${info.installEnvVar}=1 bash scripts/setup-image-video.sh\` to install.`,
    { status: 500, code: `${runtimeId.toUpperCase()}_VENV_MISSING` },
  );
}

export const listVideoModels = () => getVideoModels();

export const defaultVideoModelId = () => getDefaultVideoModelId();

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

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
  proc.kill('SIGTERM');
  // KEEP activeProcess set until proc.on('close') clears it. Without this,
  // the BUSY guard immediately allows a new generation while the SIGTERM'd
  // child is still running (mlx_video can ignore SIGTERM mid-tensor-op),
  // and we'd lose the handle for a follow-up SIGKILL. Escalate after 8s.
  setTimeout(() => {
    // proc.killed is set the moment proc.kill() is called; it does NOT mean
    // the child has exited. Check exitCode (null until 'close' fires) so the
    // SIGKILL escalation actually triggers when mlx_video ignores SIGTERM.
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ video child didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
};

export const loadHistory = () => readJSONFile(HISTORY_FILE, []);
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);

// Build the spawn args for dgrauet's ltx-2-mlx runtime via our Python helper.
// The helper lives in the ltx-2-mlx venv (so its `import ltx_pipelines_mlx`
// resolves) but the script file lives in the PortOS repo so updates ship
// with PortOS releases instead of the user's HF cache.
const buildLtx2Args = ({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, mode, imageStrength, disableAudio, outputPath, textEncoderRepo }) => {
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
  const helperMode = mode === 'fflf' ? 'fflf'
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
  // Approach: cap the pixel-frame budget (width × height × numFrames) at a
  // value that fit on the test box, then back-solve numFrames. Round down
  // to the LTX 8k+1 latent-boundary so the model doesn't silently snap.
  // FFLF_LTX2_PIXEL_BUDGET env var lets users with more RAM raise the cap.
  if (helperMode === 'fflf') {
    const envBudget = Number(process.env.FFLF_LTX2_PIXEL_BUDGET);
    const pixelBudget = Number.isFinite(envBudget) && envBudget > 0
      ? envBudget
      : 704 * 448 * 25; // ≈7.9M pixel-frames, confirmed to fit 48 GB unified RAM
    const requested = Number(width) * Number(height) * Number(numFrames);
    if (requested > pixelBudget) {
      const safeRaw = Math.floor(pixelBudget / (Number(width) * Number(height)));
      const safeLatent = Math.max(1, Math.floor((safeRaw - 1) / 8));
      const safeFrames = safeLatent * 8 + 1;
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
    // Translate the user's requested numFrames into a latent-frame count
    // for ExtendPipeline. 1 latent ≈ 8 pixel frames, with no leading +1
    // because the source already supplies the anchor frame. Floor at 1
    // so a too-small numFrames still produces something.
    const extendLatents = Math.max(1, Math.floor(Number(numFrames) / 8));
    args.push('--extend-frames', String(extendLatents));
    args.push('--extend-direction', 'after');
  }
  if (helperMode === 'a2v') {
    args.push('--audio', audioFilePath);
    // Optional first-frame conditioning — when the user supplied a source
    // image, AudioToVideoPipeline conditions frame 0 the same way I2V does
    // so motion + audio sync to the chosen still.
    if (sourceImagePath) args.push('--image', sourceImagePath);
  }
  return { bin: LTX2_VENV_PYTHON, args };
};

// Build args for the Wan 2.2 MLX helper. The helper subprocesses upstream
// `generate.py` from the cloned osama-ata/Wan2.2-mlx repo. The wrapper
// translates PortOS's stable arg surface (prompt, output, image) into
// upstream's --task / --size / --ckpt_dir form so PortOS releases don't
// fight upstream CLI changes.
const buildWan22Args = ({ model, prompt, width, height, numFrames, steps, guidance, seed, sourceImagePath, mode, outputPath }) => {
  assertByovRuntimeInstalled('wan22');
  const args = [
    WAN22_HELPER_SCRIPT,
    '--repo-dir', WAN22_REPO_DIR,
    '--task', model.mode === 'i2v' ? 'i2v-A14B' : 't2v-A14B',
    '--model-repo', model.repo,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 5.0),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  if (model.mode === 'i2v') {
    if (!sourceImagePath) {
      throw new ServerError(
        'Wan 2.2 i2v requires a source image — upload one before running this model.',
        { status: 400, code: 'WAN22_I2V_REQUIRES_IMAGE' },
      );
    }
    args.push('--image', sourceImagePath);
  }
  return { bin: WAN22_VENV_PYTHON, args };
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

const buildArgs = ({ pythonPath, modelId, model, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, tiling, disableAudio, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, mode, imageStrength, textEncoderRepo, outputPath }) => {
  // Route to the dgrauet/ltx-2-mlx helper when the model declares the new
  // runtime. Existing notapalindrome models default to runtime: 'mlx_video'
  // (or undefined in legacy registries — see backfillRuntime in mediaModels.js).
  if (model.runtime === 'ltx2') {
    return buildLtx2Args({ model, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, mode, imageStrength, disableAudio, outputPath, textEncoderRepo });
  }
  if (model.runtime === 'wan22') {
    return buildWan22Args({ model, prompt, width, height, numFrames, steps, guidance, seed, sourceImagePath, mode, outputPath });
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
  const args = [
    '-m', 'mlx_video.generate_av',
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
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (disableAudio) args.push('--no-audio');

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
    args.push('--image', condImage);
    if (condFrameIdx != null) args.push('--image-frame-idx', String(condFrameIdx));
    // --image-strength uses mask = 1.0 - strength: 1.0 preserves the source
    // latent, 0.0 fully denoises (= T2V). mlx_video's help text describes
    // this inverted. Omit when no caller value so mlx_video's default (1.0)
    // applies.
    if (imageStrength != null) args.push('--image-strength', String(imageStrength));
  }
  return { bin: pythonPath, args };
};

// Default frame count for LTX renders, matching the 8k+1 latent-boundary
// the model wants. Exported so the route layer can validate keyframe
// indices against the same effective number of frames the service will
// use (avoiding drift between two hardcoded constants).
export const DEFAULT_NUM_FRAMES = 121;

export async function generateVideo({ pythonPath, prompt, negativePrompt = '', modelId = defaultVideoModelId(), width = 768, height = 512, numFrames = DEFAULT_NUM_FRAMES, fps = 24, steps, guidanceScale, seed, tiling = 'auto', disableAudio = false, sourceImagePath = null, uploadedTempPath = null, uploadedTempPaths = [], lastImagePath = null, keyframes = null, extendFromVideoPath = null, audioFilePath = null, mode = null, imageStrength = null, hidden = false, jobId: providedJobId = null }) {
  uploadedTempPaths = Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [];
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is now enforced by the mediaJobQueue worker upstream — only
  // one job is dequeued at a time, so we don't need a BUSY guard here. Direct
  // callers (legacy / tests) bypass the queue and would clobber activeProcess
  // on concurrent calls; that's an explicit "don't do that" contract.

  const model = VIDEO_MODELS[modelId];
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
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
  const actualSteps = steps ? Number(steps) : model.steps;
  const actualGuidance = guidanceScale != null && guidanceScale !== '' ? Number(guidanceScale) : model.guidance;
  // Caller may pass null/'' to use mlx_video's default (1.0 = preserve source).
  const actualImageStrength = imageStrength != null && imageStrength !== '' ? Number(imageStrength) : null;
  const actualTextEncoderRepo = getTextEncoderRepo();
  const parsedNumFrames = Number(numFrames);
  const parsedFps = Number(fps);

  // Resize source image to match the model resolution. mlx_video requires
  // exact dimensions (it doesn't auto-pad), and pixie-forge learned the
  // hard way that letting the model upscale a portrait reference makes
  // garbled output.
  //
  // Skip the last-image resize when buildArgs / the Python child won't
  // actually consume it:
  //  - On macOS/mlx_video the FFLF fallback only triggers in `fflf` mode
  //    AND when no source image is also provided (single conditioning frame
  //    only). Anything else is a no-op, so resizing is wasted ffmpeg work.
  //  - On Windows we forward --last-image to generate_win.py so it can log
  //    status, but the diffusers pipeline only reads --image — the script
  //    never opens the last-frame file, so no resize is needed there either.
  const lastImageWillBeUsed = !!lastImagePath && !IS_WIN && mode === 'fflf' && !sourceImagePath;
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
    ], { timeout: 10000 }).catch((err) => ({ error: err }));
    if (resizeResult.error) {
      console.log(`⚠️ Failed to resize ${tag} image, using original: ${resizeResult.error.message}`);
      return { resolved: srcPath, tempPath: null };
    }
    return { resolved: resizedPath, tempPath: resizedPath };
  };
  const { resolved: resolvedSourceImage, tempPath: resizedSrcTempPath } = await resizeImage(sourceImagePath, 'src');
  const { resolved: resolvedLastImage, tempPath: resizedLastTempPath } = lastImageWillBeUsed
    ? await resizeImage(lastImagePath, 'last')
    : { resolved: lastImagePath, tempPath: null };
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
    ({ bin, args } = buildArgs({ pythonPath, modelId, model, prompt, negativePrompt, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, steps: actualSteps, guidance: actualGuidance, seed: actualSeed, tiling, disableAudio, sourceImagePath: resolvedSourceImage, lastImagePath: resolvedLastImage, keyframes: resolvedKeyframes, extendFromVideoPath, audioFilePath, mode, imageStrength: actualImageStrength, textEncoderRepo: actualTextEncoderRepo, outputPath }));
  } catch (err) {
    job.status = 'error';
    const reason = err.message || 'Failed to build video gen args';
    console.log(`❌ Video generation buildArgs error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    if (resizedSrcTempPath) unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) unlink(resizedLastTempPath).catch(() => {});
    for (const p of resizedKeyframeTempPaths) unlink(p).catch(() => {});
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
  // Merge HF_TOKEN/HF_HOME via hfTokenEnv() so the Wan 2.2 / HunyuanVideo
  // python helpers can authenticate snapshot_download() against gated repos
  // (mirrors the imageGen child-spawn pattern). LTX-2 doesn't currently use
  // a gated repo, but the merge is harmless when no token is configured.
  const childEnv = { ...stripDebugMallocEnv(process.env), ...(await hfTokenEnv()) };
  delete childEnv.PYTHONPATH;
  // Force unbuffered Python I/O so tqdm + loguru + our own STAGE: prints flush
  // immediately. Without this, child stdio is line-buffered against a pipe and
  // long inference loops emit nothing to handleLine() for minutes — the UI
  // looks dead even when the model is making progress.
  childEnv.PYTHONUNBUFFERED = '1';
  const proc = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
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

  let outputBuf = '';
  let missingPyModule = null;

  // Returns true when the line was a known progress/status message (already
  // broadcast over SSE) or python-noise — caller should suppress logging.
  // Returns false for unhandled lines that are worth raw-logging.
  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return true;
    if (PYTHON_NOISE_RE.test(line)) return true;
    // Heartbeat for the queue's idle watchdog (see imageGen/local.js).
    videoGenEvents.emit('activity', { generationId: jobId });
    if (line.startsWith('STATUS:')) {
      const message = line.slice(7);
      broadcastSse(job, { type: 'status', message });
      // Mirror status to videoGenEvents so the mediaJobQueue SSE dispatcher
      // forwards it to the client. Without this, only STAGE: progress
      // reaches the UI and long pre-render phases ("Loading pipeline…",
      // "Generating I2V…") display nothing.
      videoGenEvents.emit('status', { generationId: jobId, message });
      return true;
    }
    if (line.startsWith('STAGE:')) {
      const parts = line.split(':');
      // Three STAGE: shapes ship today:
      //   STAGE:<stage>:step:<cur>:<total>:<msg>  — explicit progress (parts[2]='step')
      //   STAGE:<stage>:heartbeat:<N>s            — idle-watchdog ping (parts[2]='heartbeat')
      //   STAGE:<stage>                           — terse phase marker (no extra fields)
      // The legacy "treat every STAGE: as step:" parse mangled heartbeat
      // lines: parts[3]='20s' → parseInt=20, parts[4]=undefined → total=1, so
      // a download-clip heartbeat broadcast progress=20.0 (= 2000%) to the UI.
      // Normalize tag case — generate_ltx2.py emits `STEP:` (uppercase),
      // generate_hunyuan.py emits `step:` and `heartbeat:` (lowercase).
      const tag = (parts[2] || '').toLowerCase();
      if (tag === 'heartbeat') {
        // Surface as a status message; the activity emit above already
        // resets the queue watchdog. Mirror to videoGenEvents so the
        // mediaJobQueue SSE dispatcher forwards it to the client.
        const message = `${parts[1]}: heartbeat ${parts[3] || ''}`;
        broadcastSse(job, { type: 'status', message });
        videoGenEvents.emit('status', { generationId: jobId, message });
        return true;
      }
      if (tag === 'step') {
        const step = parseInt(parts[3], 10) || 0;
        const total = parseInt(parts[4], 10) || 1;
        const label = parts.slice(5).join(':');
        broadcastSse(job, { type: 'progress', progress: step / total, message: label });
        // Pass the python-side label as `message` so the dispatcher surfaces
        // it to the client instead of falling back to the synthesized
        // "Rendering step X/Y" (which hides useful labels like "Loading
        // model" emitted at stage boundaries).
        videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total, message: label || undefined });
        return true;
      }
      // Bare phase marker (e.g. STAGE:load-pipeline, STAGE:from-pretrained) —
      // surface as a status line. No progress %, no division-by-undefined.
      // Mirror to videoGenEvents for client forwarding.
      const message = parts.slice(1).join(':');
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
      return true;
    }
    if (line.startsWith('DOWNLOAD:')) {
      const message = `Downloading model... ${line.slice(9)}`;
      broadcastSse(job, { type: 'status', message });
      videoGenEvents.emit('status', { generationId: jobId, message });
      return true;
    }
    const m = line.match(/(\d+)%\|/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      broadcastSse(job, { type: 'progress', progress: pct, message: line });
      // Omit `message` on the queue-dispatcher emit: the raw tqdm bar
      // (`60%|██████    | 6/10 [00:30<00:20, ...]`) is terminal noise that
      // would clobber the last meaningful STATUS/STAGE line on every
      // percent update. Client renders the percentage separately.
      videoGenEvents.emit('progress', { generationId: jobId, progress: pct });
      return true;
    }
    return false;
  };

  proc.stdout.on('data', (chunk) => {
    outputBuf += chunk.toString();
    const lines = outputBuf.split('\n');
    outputBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // mlx_video emits one JSON line on stdout when finished — capture it
      // for the result metadata; otherwise raw-log so we can debug failures.
      try {
        const parsed = JSON.parse(line);
        if (parsed.video_path) job.resultJson = parsed;
        continue;
      } catch { /* not JSON */ }
      console.log(`🐍-out [${jobId.slice(0, 8)}] ${line}`);
    }
  });

  proc.stderr.on('data', (chunk) => {
    for (const raw of chunk.toString().split(/[\n\r]+/)) {
      // Record the root-cause module only — downstream imports in the same
      // traceback raise the same error against later names.
      if (!missingPyModule) {
        const m = raw.match(MODULE_NOT_FOUND_RE);
        if (m) missingPyModule = m[1];
      }
      if (!handleLine(raw)) console.log(`🐍 [${jobId.slice(0, 8)}] ${raw.trim()}`);
    }
  });

  proc.on('close', async (code, signal) => {
    activeProcess = null;
    // Cleanup the resized temp images if we made them. Track via flags rather
    // than a path-prefix check — tmpdir() can return a symlinked path
    // (macOS /var → /private/var) so startsWith() can silently miss.
    if (resizedSrcTempPath) await unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) await unlink(resizedLastTempPath).catch(() => {});
    for (const p of resizedKeyframeTempPaths) await unlink(p).catch(() => {});
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

    if (code !== 0) {
      job.status = 'error';
      let reason;
      if (missingPyModule) {
        const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
        if (runtimeInfo) {
          // The probe believed the venv was ready but a runtime import
          // disagreed — drop the cached "ready" so the next /runtime-status
          // re-probes and the install banner re-appears.
          invalidateByovReadyCache(runtimeInfo.id);
          reason = `Python module '${missingPyModule}' is missing from the ${runtimeInfo.label} venv. Re-run the installer via Settings → Video (or \`${runtimeInfo.installEnvVar}=1 bash scripts/setup-image-video.sh\`).`;
        } else {
          reason = `Python module '${missingPyModule}' is missing. Install it into the configured Python environment and retry.`;
        }
      } else if (signal === 'SIGKILL') {
        reason = 'Process killed (likely out of memory — try a smaller model or resolution)';
      } else if (signal) {
        reason = `Killed by signal ${signal}`;
      } else {
        reason = `Exit code ${code}`;
      }
      console.log(`❌ Video generation failed [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}` });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    } else {
      job.status = 'complete';
      await optimizeForStreaming(outputPath);
      const thumbnail = await generateThumbnail(outputPath, jobId);
      const history = await loadHistory();
      history.unshift({ ...meta, thumbnail });
      await saveHistory(history);
      console.log(`✅ Video generated [${jobId.slice(0, 8)}]: ${filename}`);
      broadcastSse(job, { type: 'complete', result: { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` } });
      videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail });
    }
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId, generationId: jobId, filename, mode: 'local', model: modelId };
}

// Generate a chain of N video chunks where each chunk's last frame seeds
// the next, then stitch them into a single longer clip. Reports progress +
// terminal events against the OUTER jobId (so the mediaJobQueue's dispatcher
// sees one logical job through the chain) while each inner chunk runs as a
// normal generateVideo() with its own inner jobId, file, and history entry.
//
// On completion the inner chunk entries are hidden so only the stitched clip
// is visible by default; the user can toggle hidden in the gallery to
// inspect individual chunks.
//
// On cancel the chain stops before the next chunk; the in-flight chunk's
// child is SIGTERM'd by cancel() and surfaces a 'failed' event we translate
// into a chain-level failure. Already-completed inner chunks are hidden but
// not deleted (the partial output is still on disk if the user wants it).
export async function generateChainedVideo({ chunks, jobId: outerJobId, ...rest }) {
  const totalChunks = Number(chunks) || 1;
  if (totalChunks === 1) {
    return generateVideo({ jobId: outerJobId, ...rest });
  }
  if (!outerJobId) throw new ServerError('generateChainedVideo requires jobId', { status: 500, code: 'INTERNAL' });

  const chainState = { stopped: false };
  activeChain = chainState;

  // Hold an outer job entry so attachSseClient(outerJobId) wires up against
  // the same SSE stream the queue sees. Without this, /api/video-gen/:id/events
  // attached at the outer id would 404 because no `jobs` map entry exists.
  const outerJob = { id: outerJobId, clients: [], status: 'running' };
  jobs.set(outerJobId, outerJob);

  const chunkIds = [];
  let currentSource = rest.sourceImagePath;
  // For extend mode, track the prior chunk's full video path so ExtendPipeline
  // can condition on the entire clip (motion + visual content) rather than just
  // a single last frame.
  let currentExtendFromVideo = rest.extendFromVideoPath ?? null;
  // First chunk preserves the user's mode (text, image, or extend). Subsequent
  // chunks are conditioned differently depending on the original mode:
  //   - extend: keep mode='extend', pass prior chunk's full video as extendFromVideoPath
  //   - all others: image-conditioned on the previous chunk's extracted last frame
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

    const isExtendChain = firstMode === 'extend' && i > 0;
    generateVideo({
      ...rest,
      seed: chunkSeed,
      jobId: innerJobId,
      // extend chain: subsequent chunks condition on the prior clip's full
      // video — ExtendPipeline.extend_from_video needs the entire video, not
      // just the last frame, to avoid reintroducing seams.
      // image/text chain: condition on the extracted last frame as before.
      sourceImagePath: isExtendChain ? null : currentSource,
      extendFromVideoPath: isExtendChain ? currentExtendFromVideo : (i === 0 ? rest.extendFromVideoPath : null),
      // Only the first chunk consumes the user's uploadedTempPath (durable
      // copy under data/uploads). Later chunks use a frame extracted from a
      // prior render (image chain) or the prior chunk's video (extend chain).
      uploadedTempPath: i === 0 ? rest.uploadedTempPath : null,
      uploadedTempPaths: i === 0 ? (rest.uploadedTempPaths || []) : [],
      hidden: true,
      mode: isExtendChain ? 'extend' : (i === 0 ? firstMode : 'image'),
      // After the first chunk, drop FFLF-style last image — chained continuation
      // is single-conditioned on the previous chunk's tail frame (or full video
      // for extend mode).
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

  const finishOk = (payload) => {
    if (activeChain === chainState) activeChain = null;
    videoGenEvents.emit('completed', { generationId: outerJobId, ...payload });
    broadcastSse(outerJob, { type: 'complete', result: payload });
    closeJobAfterDelay(jobs, outerJobId);
  };
  const finishFail = (error) => {
    if (activeChain === chainState) activeChain = null;
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
      if (i < totalChunks - 1) {
        if (firstMode === 'extend') {
          // For extend chains, subsequent chunks condition on the entire prior
          // clip via ExtendPipeline.extend_from_video — no frame extraction
          // needed. The chunk's output file is always <innerJobId>.mp4 under
          // PATHS.videos (see generateVideo: filename = `${jobId}.mp4`).
          currentExtendFromVideo = join(PATHS.videos, `${chunkIds[chunkIds.length - 1]}.mp4`);
        } else {
          // extractLastFrame caches by id, so re-clicks (e.g. from gallery
          // "Continue") don't re-spawn ffmpeg.
          // eslint-disable-next-line no-await-in-loop
          const frame = await extractLastFrame(chunkIds[chunkIds.length - 1]).catch((err) => ({ error: err.message }));
          if (frame?.error) {
            await setHistoryItemsHidden(chunkIds, true);
            finishFail(`Failed to extract frame between chunks: ${frame.error}`);
            return;
          }
          currentSource = join(PATHS.images, frame.filename);
        }
      }
    }
    const stitched = await stitchVideos(chunkIds, {
      id: outerJobId,
      filenamePrefix: 'chained',
      historyKey: 'chainedFrom',
      promptOverride: rest.prompt || null,
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
  const history = await loadHistory().catch(() => null);
  if (!Array.isArray(history)) return;
  for (const item of history) {
    if (wanted.has(item.id)) item.hidden = !!hidden;
  }
  await saveHistory(history).catch(() => {});
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
    const proc = spawn(ffmpeg, ['-sseof', '-1.0', '-i', videoPath, '-update', '1', '-vframes', '1', '-q:v', '2', '-y', framePath], { stdio: 'ignore' });
    proc.on('close', async (code) => {
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
// concat demuxer which is stream-copy, so it's fast and lossless — but the
// inputs must share codec/resolution. The Media History page already only
// lets users stitch from a single model so this holds in practice.
//
// `opts` lets the chained-render code reuse the same ffmpeg path with a
// different identity (id, filename prefix, history-link key, prompt) without
// duplicating the validation + concat-manifest plumbing.
export async function stitchVideos(videoIds, opts = {}) {
  const {
    id = randomUUID(),
    filenamePrefix = 'stitched',
    historyKey = 'stitchedFrom',
    promptOverride = null,
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

  const listFile = join(tmpdir(), `concat-${id}.txt`);
  // ffmpeg concat-demuxer escape: per its docs, single quotes in filenames
  // must be replaced with `'\''`. Inside quoted strings ffmpeg also treats
  // backslash as an escape character — on Windows where paths are
  // `C:\foo\bar.mp4`, that corrupts the path. Normalize to forward slashes
  // (which ffmpeg accepts on Windows just fine) before quoting.
  const escapeForConcat = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await writeFile(listFile, videoPaths.map((p) => `file '${escapeForConcat(p)}'`).join('\n'));

  const outFilename = `${filenamePrefix}-${id}.mp4`;
  const outPath = join(PATHS.videos, outFilename);

  // Use a try/finally so the concat list temp file is cleaned up even when
  // ffmpeg rejects — otherwise it leaks one file per failed stitch.
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath], { stdio: 'ignore' });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new ServerError('Stitch failed', { status: 500, code: 'FFMPEG_FAILED' })));
      proc.on('error', (err) => reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' })));
    });
    await optimizeForStreaming(outPath);
  } finally {
    await unlink(listFile).catch(() => {});
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
    numFrames: videos.reduce((sum, v) => sum + (v.numFrames || 0), 0),
    fps: videos[0].fps,
    filename: outFilename,
    thumbnail: thumb,
    createdAt: new Date().toISOString(),
    [historyKey]: videoIds,
  };
  const h = await loadHistory();
  h.unshift(stitchedMeta);
  await saveHistory(h);
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
  const refreshedHistory = await loadHistory();
  refreshedHistory.unshift(newEntry);
  await saveHistory(refreshedHistory);
  console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height})`);
  return newEntry;
}

export async function setHistoryItemHidden(id, hidden) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === id);
  if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  item.hidden = !!hidden;
  await saveHistory(history);
  return { ok: true, hidden: item.hidden };
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
  await saveHistory(history.filter((h) => h.id !== id));
  console.log(`🗑️ Deleted video: ${item.filename}`);
  return { ok: true };
}
