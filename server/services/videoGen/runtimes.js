/**
 * Video Gen — BYOV ("bring your own venv") runtime management.
 *
 * Single source of truth for every non-mlx_video video runtime's on-disk
 * location (venv python, helper script, repo dir) plus the install/ready/
 * fingerprint probes that GET /api/video-gen/status and the install routes
 * read. The render path in local.js imports the path constants it needs to
 * build a runtime's argv; everything here is self-contained (only lib helpers),
 * so it has no dependency back on local.js.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, cpus, type as osType, release as osRelease } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { createSingleFlight } from '../../lib/singleFlight.js';
import { MINIMAX_H3_RUNTIMES, LTX2_FAMILY_RUNTIMES } from '../../lib/runners.js';

// Path to the dgrauet/ltx-2-mlx venv populated by `INSTALL_LTX2=1
// scripts/setup-image-video.sh`. Used when a model entry has
// `runtime: 'ltx2'`. The companion helper at scripts/generate_ltx2.py
// imports `ltx_pipelines_mlx` from this venv and emits the same SSE
// progress protocol (STAGE:/STATUS:/DOWNLOAD:) as the mlx_video CLI.
export const LTX2_VENV_PYTHON = join(homedir(), '.portos', 'ltx-2-mlx', '.venv', 'bin', 'python3');
export const LTX2_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_ltx2.py');

// LTX-2.5 MLX runtime — MrMofer's ltx25 fork of dgrauet/ltx-2-mlx. Same
// helper script as `ltx2`, separate checkout so the 2.3 pin stays frozen.
export const LTX25_VENV_PYTHON = join(homedir(), '.portos', 'ltx-2.5-mlx', '.venv', 'bin', 'python3');
export const LTX25_REPO_DIR = join(homedir(), '.portos', 'ltx-2.5-mlx');
export const LTX25_EXPECTED_REVISION = '57952288076766abe27dda3a774b2c24f7346977';
// Shim roots for a substituted prompt conditioner (lib/videoTextEncoders.js).
// Unlike the H3 sibling below — which composes a whole checkpoint root and
// replaces only `text_encoder/` — an ltx25 shim is a standalone Gemma 4
// checkpoint directory the runner points the pack's PromptEncoder at, so
// nothing here links back into the model snapshot. Deliberately OUTSIDE
// LTX25_REPO_DIR for the same reason: anything written inside the checkout
// would read as untracked in that pin verification.
export const LTX25_ENCODER_SHIM_DIR = join(homedir(), '.portos', 'ltx25-encoder-shims');

// Wan 2.2 MLX runtime — pinned MLX-Gen checkout provisioned on demand.
export const WAN22_VENV_PYTHON = join(homedir(), '.portos', 'mlx-gen', '.venv', 'bin', 'python3');
export const WAN22_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_wan22.py');
export const WAN22_REPO_DIR = join(homedir(), '.portos', 'mlx-gen');
export const WAN22_EXPECTED_REVISION = '2452f0c12edcc8886eebf15772205ce9c417a618';

// MiniMax H3 MLX runtime — PipeNetwork's Apple-Silicon port, provisioned only
// after the user selects Install in Video Gen. The model weights remain a
// separate, explicitly accepted/downloaded Hugging Face operation.
export const MINIMAX_H3_VENV_PYTHON = join(homedir(), '.portos', 'minimax-h3-mlx', '.venv', 'bin', 'python3');
export const MINIMAX_H3_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_minimax_h3.py');
export const MINIMAX_H3_RUNTIME_PROBE_SCRIPT = join(PATHS.root, 'scripts', 'minimax_h3_runtime_probe.py');
export const MINIMAX_H3_LORA_PROBE_SCRIPT = join(PATHS.root, 'scripts', 'minimax_h3_lora_probe.py');
export const MINIMAX_H3_REPO_DIR = join(homedir(), '.portos', 'minimax-h3-mlx');
export const MINIMAX_H3_EXPECTED_REVISION = 'fcd9e9b79a1d6018d91ac477c0968de1fa067e49';
// Composed checkpoint roots for a substituted prompt conditioner
// (lib/videoTextEncoders.js). Each is a tree of symlinks into the upstream
// FL2VA snapshot with only `text_encoder/` replaced, so the pinned runtime's
// own `from_pretrained` loads it unmodified. Deliberately OUTSIDE
// MINIMAX_H3_REPO_DIR: anything written inside the checkout would show up as
// untracked in the pin verification that both /status and the render helper run.
export const MINIMAX_H3_ENCODER_SHIM_DIR = join(homedir(), '.portos', 'minimax-h3-encoder-shims');

// MiniMax H3 on CUDA — the diffusers `MiniMaxH3ModularPipeline` rather than a
// pinned source checkout, so this runtime is a plain pip venv with no revision
// to verify and no source package to keep clean.
//
// SHIPPED FOR WINDOWS AND LINUX. The venv is not win32-specific (which is why
// the interpreter is resolved by venv layout below rather than assumed), and
// since #4142 neither is the catalog: `getVideoModels()` selects `video.cuda`
// on every non-Darwin platform, so a Linux install sees this runtime's model
// row exactly as a Windows one does.
export const MINIMAX_H3_CUDA_REPO_DIR = join(homedir(), '.portos', 'minimax-h3-cuda');
export const MINIMAX_H3_CUDA_VENV_PYTHON = process.platform === 'win32'
  ? join(MINIMAX_H3_CUDA_REPO_DIR, '.venv', 'Scripts', 'python.exe')
  : join(MINIMAX_H3_CUDA_REPO_DIR, '.venv', 'bin', 'python3');
export const MINIMAX_H3_CUDA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_minimax_h3_cuda.py');
// Mirrors OFFLOAD_PROFILES in scripts/generate_minimax_h3_cuda.py. Kept in sync
// by hand — the helper's argparse `choices=` is the enforcement, this list is
// what lets the server reject a bad `offloadProfile` before queueing a render.
export const MINIMAX_H3_CUDA_OFFLOAD_PROFILES = Object.freeze([
  'auto', 'bf16', 'int8-stream', 'int8-lean',
]);

// HunyuanVideo MLX runtime — gaurav-nelson/HunyuanVideo_MLX cloned at
// ~/.portos/hunyuan-video-mlx/. ~60 GB resident at bf16 so practical only
// with the 4-bit Gemma text encoder + everything else evicted. Provisioned
// via `INSTALL_HUNYUAN=1 bash scripts/setup-image-video.sh`.
export const HUNYUAN_VENV_PYTHON = join(homedir(), '.portos', 'hunyuan-video-mlx', '.venv', 'bin', 'python3');
export const HUNYUAN_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_hunyuan.py');
export const HUNYUAN_REPO_DIR = join(homedir(), '.portos', 'hunyuan-video-mlx');

// Standalone runtime-fingerprint probe (scripts/runtime_fingerprint.py). Run in
// each installed BYOV venv by resolveRuntimeFingerprint() to surface resolved
// package versions on GET /api/video-gen/status without running a render. Shares
// its fingerprint definition with the inline render-time emit (_runner_common).
const RUNTIME_FINGERPRINT_SCRIPT = join(PATHS.root, 'scripts', 'runtime_fingerprint.py');

// Per-runtime metadata for "bring-your-own-venv" video runtimes — those that
// resolve their own Python interpreter inside buildArgs (so the legacy
// mlx_video `settings.imageGen.local.pythonPath` is irrelevant). Single
// source of truth: the BYOV_VIDEO_RUNTIMES Set + the /setup/runtime-* routes
// + the client install banner all derive from this map's keys.
//
// `importProbe` (or `probeArgs` for a dedicated script) is run by
// isByovRuntimeReady() to
// confirm the venv's *packages* are actually installed (not just the venv
// binary). A partial install (e.g. setup script aborted after `uv venv`
// before `uv pip install`) leaves the binary present but no torch — without
// this probe the UI would hide the install banner and renders would fail
// with a deep ImportError inside the runner script.
export const BYOV_RUNTIME_INFO = Object.freeze({
  minimax_h3: {
    id: 'minimax_h3',
    label: 'MiniMax H3 MLX',
    venvPython: MINIMAX_H3_VENV_PYTHON,
    repoDir: MINIMAX_H3_REPO_DIR,
    installEnvVar: 'INSTALL_MINIMAX_H3',
    // Cache-only: the runner never reaches the network, so the spawn site hands
    // it a bare env and strips any ambient HF credential rather than passing one
    // it neither needs nor may transmit. Absent means "the runner may fetch".
    cacheOnly: true,
    // The runner spawns children of its own (an ffmpeg mux, a git pin probe), so
    // cancelling has to signal the whole group or they outlive the render.
    killProcessGroup: true,
    repoUrl: 'https://github.com/PipeNetwork/minimax-h3-mlx',
    expectedRevision: MINIMAX_H3_EXPECTED_REVISION,
    // Source-only runtime: both status and the render helper verify this
    // package is clean so a modified/untracked module cannot shadow the pin.
    sourcePath: 'minimax_h3_mlx',
    pinEnvVar: 'MINIMAX_H3_PIN',
    // The port is source-only rather than pip-installed. The dedicated probe
    // registers only the source package namespace; it never prepends the whole
    // checkout, where an untracked root module could shadow a locked venv dep.
    probeArgs: [MINIMAX_H3_RUNTIME_PROBE_SCRIPT, MINIMAX_H3_REPO_DIR],
    // Separate, OPTIONAL capability probe: can this checkout apply LoRAs to the
    // quantized DiT at runtime? H3's shipped weights are 8-bit, so a LoRA can
    // only ride along if the runner reads logical layer dims from the
    // quantization metadata and adds deltas in the forward pass (fusing into
    // packed-uint32 weights is not possible). The pinned revision has no LoRA
    // code at all, so this probe fails today and LoRAs stay rejected with a
    // precise reason — advancing the pin to a revision that satisfies the
    // contract (see scripts/minimax_h3_lora_probe.py) opens the gate with no
    // code change here. Absence of this key means "runtime can never take
    // LoRAs", which is the correct answer for wan22 / hunyuan.
    loraProbeArgs: [MINIMAX_H3_LORA_PROBE_SCRIPT, MINIMAX_H3_REPO_DIR],
    fingerprintPackages: ['mlx', 'mlx-metal', 'mlx-vlm', 'transformers', 'huggingface-hub'],
  },
  minimax_h3_cuda: {
    id: 'minimax_h3_cuda',
    label: 'MiniMax H3 CUDA',
    venvPython: MINIMAX_H3_CUDA_VENV_PYTHON,
    repoDir: MINIMAX_H3_CUDA_REPO_DIR,
    installEnvVar: 'INSTALL_MINIMAX_H3_CUDA',
    // Cache-only: see minimax_h3 above. The Video Gen UI owns every download.
    cacheOnly: true,
    killProcessGroup: true,
    // Everything this runtime executes is an installed distribution, so there
    // is no `expectedRevision` / `sourcePath` clean-checkout probe to run: the
    // `==` set in scripts/requirements-minimax-h3-cuda.txt is the pin. `repoUrl`
    // is therefore the integration's documentation rather than a clone source —
    // there is no checkout under repoDir, only the venv.
    repoUrl: 'https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3',
    // Because `repoUrl` is documentation here, the install banner must not say
    // PortOS fetches the runtime "from" it — this names what is actually
    // installed. Optional: a runtime that clones its repoUrl leaves it unset and
    // the banner falls back to the URL, which is accurate for those.
    installSourceLabel: 'pinned PyPI wheels',
    // Three things must hold before a render is even attempted, and each fails
    // as an unusable install rather than as a bad render: diffusers must carry
    // the H3 modular integration (merged to main after v0.39.0 and in no tagged
    // release yet, so a released wheel imports fine and then has no pipeline —
    // which is why the requirements file pins a commit), torchao must be present
    // (int8 weight-only is the only way the 133 GB bf16 pair fits a consumer
    // card), and CUDA must actually be visible. A CPU-only torch is the trap
    // here: it installs cleanly on Windows, hides the setup banner, and then
    // renders a 33B model on the CPU.
    importProbe: 'import torch; from diffusers import MiniMaxH3Transformer3DModel; from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference; import torchao; assert torch.cuda.is_available(), "no CUDA device"',
    // Mirror scripts/generate_minimax_h3_cuda.py's emit_runtime_fingerprint list.
    fingerprintPackages: ['torch', 'diffusers', 'transformers', 'torchao', 'accelerate', 'huggingface-hub'],
  },
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
    // Distributions the /status runtime-fingerprint probe resolves versions for
    // (must match scripts/generate_hunyuan.py's emit_runtime_fingerprint call).
    fingerprintPackages: ['torch', 'diffusers', 'transformers', 'mlx'],
  },
  wan22: {
    id: 'wan22',
    label: 'Wan 2.2 MLX',
    venvPython: WAN22_VENV_PYTHON,
    repoDir: WAN22_REPO_DIR,
    installEnvVar: 'INSTALL_WAN22',
    killProcessGroup: true,
    repoUrl: 'https://github.com/lpalbou/mlx-gen',
    expectedRevision: WAN22_EXPECTED_REVISION,
    pinEnvVar: 'WAN22_PIN',
    importProbe: 'import mflux.models.wan.cli.wan_generate',
    // Mirror scripts/generate_wan22.py's emit_runtime_fingerprint package list.
    fingerprintPackages: ['mlx-gen', 'mlx', 'mlx_metal', 'huggingface-hub'],
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
    // Mirror scripts/generate_ltx2.py's emit_runtime_fingerprint package list.
    fingerprintPackages: ['ltx_pipelines_mlx', 'ltx_core_mlx', 'mlx', 'mlx_metal'],
  },
  ltx25: {
    id: 'ltx25',
    label: 'LTX-2.5 MLX',
    venvPython: LTX25_VENV_PYTHON,
    repoDir: LTX25_REPO_DIR,
    installEnvVar: 'INSTALL_LTX25',
    repoUrl: 'https://github.com/MrMoferFRAN/ltx-2-mlx',
    expectedRevision: LTX25_EXPECTED_REVISION,
    pinEnvVar: 'LTX25_PIN',
    importProbe: 'import ltx_pipelines_mlx',
    fingerprintPackages: ['ltx_pipelines_mlx', 'ltx_core_mlx', 'mlx', 'mlx_metal'],
  },
});

export const BYOV_VIDEO_RUNTIMES = Object.freeze(new Set(Object.keys(BYOV_RUNTIME_INFO)));

// Per-runtime EXECUTION facts, read off the registry rather than re-derived from
// a runtime id at the spawn site. Both are "key absent means off", the same
// convention `loraProbeArgs` / `expectedRevision` already use here — so the next
// cache-only or group-killed runtime is a line in the table above rather than an
// edit to the child-spawn path in local.js.
export const runtimeIsCacheOnly = (runtime) => BYOV_RUNTIME_INFO[runtime]?.cacheOnly === true;
export const runtimeNeedsProcessGroupKill = (runtime) => BYOV_RUNTIME_INFO[runtime]?.killProcessGroup === true;

// Does this model render through the legacy Windows helper, `generate_win.py`?
// That script is the fallback `buildArgs` reaches only after every BYOV runtime
// has declined, so the answer is "on win32, and not a BYOV runtime" — NOT the
// bare `process.platform === 'win32'` this used to be spelled as at three
// separate sites in local.js.
//
// The distinction became load-bearing the moment Windows gained a BYOV runtime
// (MiniMax H3 CUDA): `generate_win.py` hardcodes its repo and reads only
// `--image`, so the platform check was standing in for facts that are true of
// that ONE script — it takes no repo id, and it never opens the last frame.
// Applied to an H3 CUDA render those become wrong answers: it does require a
// pinned repo, and it does anchor both keyframes.
export const routesToWindowsHelper = (model) => process.platform === 'win32'
  && !BYOV_VIDEO_RUNTIMES.has(model?.runtime);

// Runtimes whose FFLF *last* frame is a real conditioning anchor rather than an
// advisory hint: ltx2 runs a true keyframe-interpolation pipeline, and
// both MiniMax H3 runtimes pack both frames as fl2va conditioning rows (the
// anchoring is the checkpoint's, so the MLX and CUDA runners agree). Every other runtime
// conditions on a single frame and drops the other. Declared once here because
// three consumers must agree — buildArgs (which forwards it), the last-frame
// resize in local.js (wasted ffmpeg work otherwise), and the client's
// "last frame is advisory" note, which reads it off the model payload via
// `lastFrameAnchored`.
export const LAST_FRAME_ANCHORED_RUNTIMES = Object.freeze(new Set([...LTX2_FAMILY_RUNTIMES, ...MINIMAX_H3_RUNTIMES]));

export const modelAnchorsLastFrame = (model) => LAST_FRAME_ANCHORED_RUNTIMES.has(model?.runtime);

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
  // Never execute a source checkout until its immutable revision and scoped
  // executable package have passed the clean-status check. Keep this ahead of
  // the positive readiness cache too: a checkout can be edited after an
  // earlier successful probe.
  if (info.expectedRevision && !await isByovRuntimeCurrent(runtimeId)) return false;
  if (readyCache.get(runtimeId) === true) return true;
  const probeOk = await runVenvProbe(info.venvPython, info.probeArgs || ['-c', info.importProbe]);
  if (probeOk) readyCache.set(runtimeId, true);
  return probeOk;
}

// Spawn one exit-code-only probe in a BYOV venv. Bounded (30s SIGKILL) so a
// wedged import can't pin a request open; any spawn/exit failure is `false`.
function runVenvProbe(venvPython, args) {
  return new Promise((resolve) => {
    const child = spawn(venvPython, args, safeChildProcessOptions({
      stdio: ['ignore', 'ignore', 'ignore'],
    }));
    const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve(false); }, 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// Probed LoRA-capability verdicts per runtime. Booleans only — a missing entry
// is "never probed", which is deliberately NOT the same as a probed `false`:
// the sync accessor below must tell "we don't know yet" from "we asked and this
// runner can't". Both outcomes are cached once resolved (a checkout can't grow a
// LoRA applicator without a reinstall, and the install route invalidates); the
// concurrent-probe coalescing lives in the single-flight, not in this Map.
const loraCapabilityCache = new Map();
const loraProbeFlight = createSingleFlight();
export function invalidateByovLoraCapabilityCache(runtimeId) {
  if (runtimeId) loraCapabilityCache.delete(runtimeId); else loraCapabilityCache.clear();
}

// Authoritative (async) answer: may this runtime take user LoRAs? Runtimes with
// no `loraProbeArgs` can never take them. An installed-but-unprobed runtime runs
// the probe once; the result is cached for the life of the process. An
// uninstalled runtime is NOT cached, matching isByovRuntimeReady's policy that
// negatives stay re-checkable so a finished install reflects immediately.
export async function resolveByovRuntimeLoraCapable(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info?.loraProbeArgs) return false;
  const cached = loraCapabilityCache.get(runtimeId);
  if (cached !== undefined) return cached;
  if (!existsSync(info.venvPython)) return false;
  return loraProbeFlight.run(runtimeId, async () => {
    const capable = await runVenvProbe(info.venvPython, info.loraProbeArgs);
    loraCapabilityCache.set(runtimeId, capable);
    return capable;
  });
}

// Sync read of the same fact, for the sync paths that decorate model payloads
// (decorateVideoModel in local.js). Only a probed verdict counts — an unprobed
// runtime reads as "not capable", so the gate fails CLOSED and the UI never
// offers a LoRA control the render would then refuse. Warms the cache in the
// background so the next read reflects the truth; every path that REJECTS on
// this awaits resolveByovRuntimeLoraCapable() first, so it never decides on a
// cold read.
export function byovRuntimeLoraCapable(runtimeId) {
  const cached = loraCapabilityCache.get(runtimeId);
  if (cached !== undefined) return cached;
  // Skip the warm when the venv isn't there: resolve would return an uncached
  // `false` anyway, so this would allocate a promise per call, forever.
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (info?.loraProbeArgs && existsSync(info.venvPython)) {
    resolveByovRuntimeLoraCapable(runtimeId).catch(() => {});
  }
  return false;
}

// Single user-facing reason a video model can't take LoRAs. Lives here, beside
// the capability data it reads, so the enqueue gate (prepareParams) and the
// render gate (local.js buildArgs) can't drift into telling the user two
// different stories — and so a future probe-gated runtime adds one branch, not
// two more copies of a paragraph.
export function videoLoraUnsupportedError(model, modelId) {
  if (model?.runtime === 'minimax_h3') {
    return new ServerError(
      `The installed MiniMax H3 runtime cannot apply LoRAs. Model "${modelId}" has a quantized DiT, so LoRAs need a runner that applies them at render time from quantization metadata — the pinned checkout has no such applicator. Upgrade the H3 runtime from Video Gen once a build that supports it is pinned.`,
      { status: 400, code: 'MINIMAX_H3_LORA_UNSUPPORTED' },
    );
  }
  if (model?.runtime === 'minimax_h3_cuda') {
    // Do NOT fall through to the LTX-2 suggestion below: those are macOS/MLX
    // entries, and this runtime only appears in the Windows catalog, so the
    // advice would name models the user cannot select.
    return new ServerError(
      `MiniMax H3 on CUDA cannot apply LoRAs. Model "${modelId}" renders through diffusers' MiniMaxH3ModularPipeline, which has no LoRA path for H3. No video model in the Windows catalog takes LoRAs today.`,
      { status: 400, code: 'MINIMAX_H3_LORA_UNSUPPORTED' },
    );
  }
  return new ServerError(
    `LoRAs aren't supported on this model. Model "${modelId}" runs on "${model?.runtime || 'mlx_video'}" — use an LTX-2.x model (dgrauet ltx2, or the bf16 Unified Beta).`,
    { status: 400, code: 'LORAS_REQUIRE_LTX2' },
  );
}

// Resolve a checkout's exact revision without trusting a mutable tag/branch.
// Runtimes without an expectedRevision remain current by definition. A stale
// pinned checkout makes the UI offer Repair / Upgrade; nothing runs at boot.
export function isPinnedSourceStatusClean(stdout, expectedRevision) {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  const oid = lines.find((line) => line.startsWith('# branch.oid '))?.slice('# branch.oid '.length);
  return oid === expectedRevision && lines.every((line) => line.startsWith('# '));
}

export async function isByovRuntimeCurrent(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info?.expectedRevision) return true;
  if (!existsSync(join(info.repoDir, '.git'))) return false;
  return new Promise((resolve) => {
    let stdout = '';
    const args = info.sourcePath
      ? ['-C', info.repoDir, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', info.sourcePath]
      : ['-C', info.repoDir, 'rev-parse', 'HEAD'];
    const child = spawn('git', args, safeChildProcessOptions({
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve(false); }, 10000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 128) stdout += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const current = info.sourcePath
        ? isPinnedSourceStatusClean(stdout, info.expectedRevision)
        : stdout.trim() === info.expectedRevision;
      resolve(code === 0 && current);
    });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
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
    `${info.label} runtime is not installed. Install or repair it from Video Gen's model setup panel.`,
    { status: 500, code: `${runtimeId.toUpperCase()}_VENV_MISSING` },
  );
}

// Cache runtime fingerprints per BYOV runtime for the life of the process.
// An entry holds EITHER a resolved fingerprint object (success — stable until a
// reinstall) OR the in-flight Promise while a probe runs, so overlapping
// /status calls await one shared probe instead of spawning a stampede of python
// children. Errors (timeout / spawn-fail / unparseable) are NOT cached — the
// entry is dropped on failure so a freshly finished install reflects on the
// next /status. invalidate on (re)install.
const fingerprintCache = new Map();
export function invalidateRuntimeFingerprintCache(runtimeId) {
  if (runtimeId) fingerprintCache.delete(runtimeId); else fingerprintCache.clear();
}

// Max bytes of probe stdout to buffer — the fingerprint JSON is a few hundred
// bytes; cap it so a misbehaving venv that spews warnings to stdout can't bloat
// the Node heap. A truncated payload simply fails to parse → { error }.
const FINGERPRINT_STDOUT_CAP = 64 * 1024;

// Run the standalone probe in one installed BYOV venv → its fingerprint object
// ({ runtime, versions, chip, os, python }) or { error } on any failure.
// Best-effort and bounded (15s SIGKILL) so a wedged venv can't hang /status.
async function probeRuntimeFingerprint(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (!info || !existsSync(info.venvPython)) return null;
  // A resolved object OR an in-flight Promise both short-circuit here; only a
  // missing/dropped entry (undefined) triggers a fresh probe.
  const cached = fingerprintCache.get(runtimeId);
  if (cached !== undefined) return cached;
  const inFlight = (async () => {
    const result = await new Promise((resolve) => {
      let out = '';
      const child = spawn(
        info.venvPython,
        [RUNTIME_FINGERPRINT_SCRIPT, runtimeId, ...(info.fingerprintPackages || [])],
        safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'ignore'] }),
      );
      const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve({ error: 'timeout' }); }, 15000);
      child.stdout.on('data', (c) => { if (out.length < FINGERPRINT_STDOUT_CAP) out += c.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ error: `exit ${code}` });
        // The probe prints exactly one JSON line; take the last non-empty line
        // defensively in case a venv import prints a stray warning to stdout.
        const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
        try { resolve(JSON.parse(lastLine)); } catch { resolve({ error: 'unparseable' }); }
      });
      child.on('error', () => { clearTimeout(timer); resolve({ error: 'spawn-failed' }); });
    });
    // Keep successful results cached; drop the in-flight entry on failure so the
    // next request re-probes (don't cache errors).
    if (result && !result.error) fingerprintCache.set(runtimeId, result);
    else fingerprintCache.delete(runtimeId);
    return result;
  })();
  fingerprintCache.set(runtimeId, inFlight);
  return inFlight;
}

// Host runtime fingerprint computed in Node — cheap, always present (no python).
// chip/os/arch are useful even before any BYOV runtime is installed.
export function hostRuntimeFingerprint() {
  return {
    chip: cpus()?.[0]?.model || 'unknown',
    os: `${osType()} ${osRelease()}`,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

// Full runtime block for GET /api/video-gen/status: the Node-side host info plus
// per-installed-BYOV-runtime resolved package versions. Surfaces "what am I
// running" so a garbled-output bug report carries the exact numerical stack
// without running a render (#1325).
//
// NON-BLOCKING: /status is the page-load probe that populates the models list +
// install/runtime gates, so it must never wait on a python fingerprint probe (a
// cold or wedged venv could otherwise stall the whole Video Gen page for up to
// the 15s probe timeout). We therefore return host info immediately plus only
// the fingerprints already resolved in cache, and kick off a background warm for
// any uncached installed runtime so its versions appear on the next /status.
export async function resolveRuntimeFingerprint() {
  const runtimes = {};
  for (const id of Object.keys(BYOV_RUNTIME_INFO)) {
    if (!isByovRuntimeInstalled(id)) continue;
    const cached = fingerprintCache.get(id);
    if (cached && typeof cached.then !== 'function') {
      // A resolved fingerprint object (never an error — errors aren't cached).
      runtimes[id] = cached;
    } else if (cached === undefined) {
      // Not cached and not already in flight — warm it in the background; the
      // result lands in the cache for a subsequent /status. Fire-and-forget.
      probeRuntimeFingerprint(id).catch(() => {});
    }
    // An in-flight Promise means a warm is already running — skip (don't await).
  }
  return { host: hostRuntimeFingerprint(), runtimes };
}

/**
 * Single runtime fingerprint to quote in a crash/failure report. Prefers the
 * fingerprint the dead child itself emitted (`RUNTIME:` line → `job.runtime`) —
 * that's the exact venv that just crashed. Falls back to the /status probe's
 * already-resolved entry for this render's runtime, then to host-only info, so
 * even the bare `mlx_video.generate_av` path (which emits no `RUNTIME:` line)
 * still names the chip + OS build.
 *
 * Non-blocking and non-throwing by construction: resolveRuntimeFingerprint()
 * returns only cached runtime entries (warming the rest in the background), so a
 * cold or wedged venv can never stall a failure message.
 *
 * @param {object} [ctx]
 * @param {object|null} [ctx.emitted] - fingerprint the child emitted (job.runtime)
 * @param {string|null} [ctx.runtimeId] - BYOV runtime id of the model being rendered
 * @returns {Promise<object|null>}
 */
export async function pickDeathFingerprint({ emitted = null, runtimeId = null } = {}) {
  if (emitted && typeof emitted === 'object') return emitted;
  const block = await resolveRuntimeFingerprint().catch(() => null);
  if (!block) return null;
  return (runtimeId && block.runtimes?.[runtimeId]) || block.host || null;
}
