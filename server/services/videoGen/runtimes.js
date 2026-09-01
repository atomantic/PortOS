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

// Composed checkpoint roots for a preview-fidelity video decode
// (lib/videoDraftDecoders.js, #5423). Same shape and the same reason as the
// encoder shims above — a tree of symlinks into the upstream FL2VA snapshot
// with only `video_vae/source/model.safetensors` replaced — kept in its own
// directory so removing one substitution never disturbs the other.
export const MINIMAX_H3_DRAFT_DECODER_SHIM_DIR = join(homedir(), '.portos', 'minimax-h3-decoder-shims');

// Reusable Qwen3-VL prompt embeddings (#5443). The MLX runner keys each entry
// on the prompt text plus the CONTENT digest of every conditioning image and
// holds the directory under its own byte ceiling, so this is a plain cache the
// user can delete at any time. Outside MINIMAX_H3_REPO_DIR for the same reason
// the shim roots are: a file written inside the checkout reads as untracked in
// the pin verification /status and the render helper both run.
export const MINIMAX_H3_PROMPT_EMBEDDING_CACHE_DIR = join(homedir(), '.portos', 'minimax-h3-prompt-embeddings');

// MiniMax H3 Ref2VA runtime — the signed mere.run release provides the native
// MLX implementation and stays separate from model weights. PortOS installs it
// into a user-owned directory so the in-app flow never needs sudo.
export const MERE_RUN_VERSION = '0.47.0';
export const MERE_RUN_DIR = join(homedir(), '.portos', 'mere-run');
export const MERE_RUN_BIN = join(MERE_RUN_DIR, 'mere.run');
export const MINIMAX_H3_REF2VA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_minimax_h3_ref2va.js');

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

// FastVideo MLX runtime — Hao AI Lab's FastVideo / FastMetal Apple Silicon framework.
export const FASTVIDEO_VENV_PYTHON = join(homedir(), '.portos', 'fastvideo', '.venv', 'bin', 'python3');
export const FASTVIDEO_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_fastvideo.py');
export const FASTVIDEO_REPO_DIR = join(homedir(), '.portos', 'fastvideo');

// LTX-2.5 on CUDA — the official Lightricks ltx-core / ltx-pipelines runtime.
export const LTX25_CUDA_REPO_DIR = join(homedir(), '.portos', 'ltx-2.5-cuda');
export const LTX25_CUDA_VENV_PYTHON = process.platform === 'win32'
  ? join(LTX25_CUDA_REPO_DIR, '.venv', 'Scripts', 'python.exe')
  : join(LTX25_CUDA_REPO_DIR, '.venv', 'bin', 'python3');
export const LTX25_CUDA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_ltx25_cuda.py');

// Wan 2.2 TI2V 5B on CUDA — official Diffusers checkpoint.
export const WAN22_CUDA_REPO_DIR = join(homedir(), '.portos', 'wan2.2-cuda');
export const WAN22_CUDA_VENV_PYTHON = process.platform === 'win32'
  ? join(WAN22_CUDA_REPO_DIR, '.venv', 'Scripts', 'python.exe')
  : join(WAN22_CUDA_REPO_DIR, '.venv', 'bin', 'python3');
export const WAN22_CUDA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_wan22_cuda.py');

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
  minimax_h3_ref2va: {
    id: 'minimax_h3_ref2va',
    label: 'MiniMax H3 Ref2VA MLX',
    venvPython: MERE_RUN_BIN,
    repoDir: MERE_RUN_DIR,
    installEnvVar: 'INSTALL_MERERUN',
    cacheOnly: true,
    killProcessGroup: true,
    repoUrl: `https://github.com/sawfwair/mere-run/releases/tag/v${MERE_RUN_VERSION}`,
    installSourceLabel: `signed mere.run v${MERE_RUN_VERSION} release`,
    expectedVersion: MERE_RUN_VERSION,
    probeArgs: ['--version'],
    fingerprintProbeArgs: ['--version'],
    fingerprintVersionKey: 'mere.run',
    // The PortOS Hugging Face downloader must use its own Python helper and
    // saved token; mere.run is an executable, not a Python interpreter.
    hfDownloadPython: false,
  },
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
    // Deliberately WITHOUT the probe's --verify-seams flag: that flag asserts the
    // encoder seams generate_minimax_h3.py patches, and a moved seam breaks only
    // the keyframe / substituted-conditioner paths. Failing readiness over it
    // would set byovGateBlocked and disable Generate for text-only renders too —
    // the same trap minimax_h3_lora_probe.py is kept a separate probe to avoid.
    // Install / Repair passes the flag (scripts/setup-image-video.sh), which is
    // where a pin bump is actionable.
    probeArgs: [MINIMAX_H3_RUNTIME_PROBE_SCRIPT, MINIMAX_H3_REPO_DIR],
    // Separate, OPTIONAL capability probe: can PortOS apply LoRAs to this
    // checkout's quantized DiT at runtime? H3's shipped weights are 8-bit, so
    // the applicator must read logical layer dims from quantization metadata
    // and add deltas in the forward pass (fusing into packed-uint32 weights is
    // not possible). The probe exercises the local adapter against the pinned
    // runtime without loading the model. Absence of this key means "runtime can
    // never take LoRAs", which is the correct answer for wan22.
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
    // the H3 modular integration (merged to main after v0.39.0 and released in
    // diffusers 0.40.0, which is the version pinned by the requirements file),
    // torchao must be present
    // (int8 weight-only is the only way the 133 GB bf16 pair fits a consumer
    // card), and CUDA must actually be visible. A CPU-only torch is the trap
    // here: it installs cleanly on Windows, hides the setup banner, and then
    // renders a 33B model on the CPU.
    importProbe: 'import torch; from diffusers import MiniMaxH3Transformer3DModel; from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference; import torchao; assert torch.cuda.is_available(), "no CUDA device"',
    // Mirror scripts/generate_minimax_h3_cuda.py's emit_runtime_fingerprint list.
    fingerprintPackages: ['torch', 'diffusers', 'transformers', 'torchao', 'accelerate', 'huggingface-hub'],
  },
  ltx25_cuda: {
    id: 'ltx25_cuda',
    label: 'LTX-2.5 CUDA',
    venvPython: LTX25_CUDA_VENV_PYTHON,
    repoDir: LTX25_CUDA_REPO_DIR,
    installEnvVar: 'INSTALL_LTX25_CUDA',
    cacheOnly: true,
    killProcessGroup: true,
    repoUrl: 'https://github.com/Lightricks/LTX-2',
    installSourceLabel: 'official Lightricks ltx-core / ltx-pipelines packages',
    importProbe: 'import sys, torch; import ltx_core, ltx_pipelines; from ltx_pipelines.distilled import DistilledPipeline; assert torch.cuda.is_available(), "no CUDA device"; assert sys.platform != "win32" or torch.__version__ == "2.10.0+cu128", f"expected torch 2.10.0+cu128 on Windows, got {torch.__version__}"',
    fingerprintPackages: ['torch', 'ltx-core', 'ltx-pipelines', 'transformers', 'accelerate', 'huggingface-hub'],
  },
  wan22_cuda: {
    id: 'wan22_cuda',
    label: 'Wan 2.2 CUDA',
    venvPython: WAN22_CUDA_VENV_PYTHON,
    repoDir: WAN22_CUDA_REPO_DIR,
    installEnvVar: 'INSTALL_WAN22_CUDA',
    cacheOnly: true,
    killProcessGroup: true,
    repoUrl: 'https://huggingface.co/docs/diffusers/main/api/pipelines/wan',
    installSourceLabel: 'pinned Diffusers and CUDA PyTorch packages',
    importProbe: 'import torch, hf_xet; from diffusers import AutoencoderKLWan, WanPipeline; assert torch.cuda.is_available(), "no CUDA device"',
    fingerprintPackages: ['torch', 'diffusers', 'transformers', 'accelerate', 'huggingface-hub', 'hf-xet'],
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
    // The revision whose ancestral (SDE) Euler loop was READ and confirmed to
    // re-apply the conditioning mask after its renoise — the invariant an
    // image-to-video render depends on to keep frame one equal to the supplied
    // picture at every step, not only the last (#5422). This is deliberately a
    // literal rather than a reference to LTX25_EXPECTED_REVISION: bumping the
    // pin without re-reading that loop turns runtimes.test.js red, which is the
    // whole point. scripts/generate_ltx2.py enforces the invariant against the
    // LIVE pin regardless, and refuses the render when it cannot.
    i2vAnchorVerifiedRevision: '57952288076766abe27dda3a774b2c24f7346977',
  },
  fastvideo: {
    id: 'fastvideo',
    label: 'FastVideo MLX',
    venvPython: FASTVIDEO_VENV_PYTHON,
    repoDir: FASTVIDEO_REPO_DIR,
    installEnvVar: 'INSTALL_FASTVIDEO',
    killProcessGroup: true,
    repoUrl: 'https://github.com/hao-ai-lab/FastVideo',
    pinEnvVar: 'FASTVIDEO_PIN',
    importProbe: 'import fastvideo; import mlx.core',
    fingerprintPackages: ['fastvideo', 'mlx', 'mlx_metal', 'torch', 'transformers', 'huggingface-hub'],
  },
});

export const BYOV_VIDEO_RUNTIMES = Object.freeze(new Set(Object.keys(BYOV_RUNTIME_INFO)));

// Only these BYOV runtimes drive MLX/Metal on macOS. Keep this execution fact
// here with the runtime registry, rather than teaching each spawn site which
// model names need the M5 GPU-watchdog mitigation.
export const BYOV_MLX_VIDEO_RUNTIMES = Object.freeze(new Set([
  'wan22', 'ltx2', 'ltx25', 'fastvideo', 'minimax_h3',
]));
export const runtimeUsesMlx = (runtime) => BYOV_MLX_VIDEO_RUNTIMES.has(runtime);

// Per-runtime EXECUTION facts, read off the registry rather than re-derived from
// a runtime id at the spawn site. Both are "key absent means off", the same
// convention `loraProbeArgs` / `expectedRevision` already use here — so the next
// cache-only or group-killed runtime is a line in the table above rather than an
// edit to the child-spawn path in local.js.
export const runtimeIsCacheOnly = (runtime) => BYOV_RUNTIME_INFO[runtime]?.cacheOnly === true;
export const runtimeNeedsProcessGroupKill = (runtime) => BYOV_RUNTIME_INFO[runtime]?.killProcessGroup === true;

// Does this model render through the legacy CUDA helper, `generate_win.py`?
// Despite its historical name, the diffusers script is portable CUDA Python and
// runs on Linux as well as Windows. Windows keeps its legacy fallback for any
// non-BYOV model; Linux reaches it only for an entry that explicitly declares
// `cuda_video`, so a Linux custom `mlx_video` entry cannot silently ignore its
// own repo. This replaces the bare win32 predicate that used to be spelled at
// three separate sites in local.js.
//
// The distinction became load-bearing the moment Windows gained a BYOV runtime
// (MiniMax H3 CUDA): `generate_win.py` hardcodes its repo and reads only
// `--image`, so the platform check was standing in for facts that are true of
// that ONE script — it takes no repo id, and it never opens the last frame.
// Applied to an H3 CUDA render those become wrong answers: it does require a
// pinned repo, and it does anchor both keyframes.
export const routesToWindowsHelper = (model) => (
  process.platform === 'win32'
    ? !BYOV_VIDEO_RUNTIMES.has(model?.runtime)
    : process.platform !== 'darwin' && model?.runtime === 'cuda_video'
);

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
  if ((info.expectedRevision || info.expectedVersion) && !await isByovRuntimeCurrent(runtimeId)) return false;
  if (readyCache.get(runtimeId) === true) return true;
  const probeOk = await runVenvProbe(
    info.venvPython, info.probeArgs || ['-c', info.importProbe], `${runtimeId} readiness`,
  );
  if (probeOk) readyCache.set(runtimeId, true);
  return probeOk;
}

// How much probe stderr to retain. The probes emit single diagnostic lines, so
// a few KB is generous; an unbounded buffer on a child that wedges mid-spew is
// its own failure mode. The TAIL is what we keep — Python prints the exception
// last, under whatever traceback preceded it.
const VENV_PROBE_STDERR_LIMIT = 4096;

// Collapse captured probe stderr to one log line. An empty capture reports
// itself explicitly rather than shortening the message: "the probe failed and
// said nothing" must not read like "the probe was never run".
const summarizeProbeStderr = (stderr) => stderr.replace(/\s+/g, ' ').trim() || '(no stderr output)';

// Spawn one boolean probe in a BYOV venv. Bounded (30s SIGKILL) so a wedged
// import can't pin a request open; any spawn/exit/timeout failure is `false`.
//
// stderr is piped and echoed on every negative outcome because it is the only
// channel these probes have: they name the exact import or seam that broke.
// The resolve contract stays a boolean — the reason goes to the log, not the
// return value. stdout stays ignored deliberately: nothing reads it, and an
// unread pipe can fill and block the child.
//
// Two negative outcomes, deliberately different icons: a non-zero exit is the
// probe ANSWERING — for the LoRA probe, "the runtime plus adapter cannot apply"
// is the documented normal verdict (see scripts/minimax_h3_lora_probe.py),
// cached as a legitimate `false` — while a spawn error or timeout means it
// never answered at all. Calling the first one a failure cries wolf on every
// healthy install with an incompatible runtime.
//
// `label` names the runtime and which probe ran, so a status request that fans
// out over several runtimes produces attributable lines. It must never carry a
// filesystem path — venv paths embed the OS username.
function runVenvProbe(venvPython, args, label) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (ok, icon, outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) console.error(`${icon} ${label} probe ${outcome}: ${summarizeProbeStderr(stderr)}`);
      resolve(ok);
    };
    const child = spawn(venvPython, args, safeChildProcessOptions({
      stdio: ['ignore', 'ignore', 'pipe'],
    }));
    // Decode as text on the stream, so a multi-byte character split across two
    // chunks survives rather than becoming U+FFFD. Slice per chunk, not once at
    // the end: that is what bounds the buffer.
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-VENV_PROBE_STDERR_LIMIT); });
    // These handlers run outside the request lifecycle, where a throw would
    // take the process down. Nothing in them can throw today, and nothing that
    // can may be added without its own guard.
    //
    // The timeout settles on the kill rather than waiting for `close`: the 30s
    // ceiling on the caller is the whole point of the timer, and stderr is
    // drained as it arrives, so what we hold is already everything the child
    // flushed.
    timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      finish(false, '❌', 'timed out after 30s');
    }, 30000);
    child.on('close', (code, signal) => finish(
      code === 0, '⚠️', signal ? `was killed by ${signal}` : `exited ${code}`,
    ));
    // Node's spawn-error message interpolates the full interpreter path, which
    // embeds the OS username — the code alone says what went wrong.
    child.on('error', (err) => finish(false, '❌', `could not be spawned (${err?.code || 'unknown error'})`));
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
    const capable = await runVenvProbe(info.venvPython, info.loraProbeArgs, `${runtimeId} LoRA-capability`);
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
      `The installed MiniMax H3 runtime cannot apply LoRAs. Model "${modelId}" has a quantized DiT, so PortOS needs its quantization-aware render-time adapter to pass the runtime capability probe. Repair the H3 runtime from Video Gen, then retry.`,
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

// The revision a BYOV runtime's checkout is pinned to, or null for a runtime
// that has no source pin (a plain pip venv). Paired with
// `isByovRuntimeCurrent` by callers that need to know WHICH revision is
// installed rather than just whether it is current — a capability gate on a
// separately verified asset (lib/videoDraftDecoders.js) has to name the
// checkout the asset was validated against, not just assert cleanliness.
export function byovRuntimeExpectedRevision(runtimeId) {
  return BYOV_RUNTIME_INFO[runtimeId]?.expectedRevision || null;
}

export async function isByovRuntimeCurrent(runtimeId) {
  const info = BYOV_RUNTIME_INFO[runtimeId];
  if (info?.expectedVersion) {
    if (!existsSync(info.venvPython)) return false;
    return new Promise((resolve) => {
      let stdout = '';
      const child = spawn(info.venvPython, ['--version'], safeChildProcessOptions({
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
      const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve(false); }, 10000);
      child.stdout.on('data', (chunk) => { if (stdout.length < 128) stdout += chunk.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && stdout.trim() === info.expectedVersion);
      });
      child.on('error', () => { clearTimeout(timer); resolve(false); });
    });
  }
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
// match against. Keep `runtimeId.toUpperCase()` so every runtime retains its
// stable, specific error code.
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
        info.fingerprintProbeArgs
          || [RUNTIME_FINGERPRINT_SCRIPT, runtimeId, ...(info.fingerprintPackages || [])],
        safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'ignore'] }),
      );
      const timer = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); resolve({ error: 'timeout' }); }, 15000);
      child.stdout.on('data', (c) => { if (out.length < FINGERPRINT_STDOUT_CAP) out += c.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ error: `exit ${code}` });
        const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
        if (info.fingerprintProbeArgs) {
          return resolve({
            runtime: runtimeId,
            versions: { [info.fingerprintVersionKey || runtimeId]: lastLine },
            ...hostRuntimeFingerprint(),
          });
        }
        // The Python probe prints exactly one JSON line; take the last non-empty
        // line defensively in case a venv import prints a stray warning.
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
