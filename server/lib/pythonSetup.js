import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from './fileUtils.js';
import { safeChildProcessEnv, whichFirst } from './processEnv.js';
import { createLineReader } from './streamLines.js';

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === 'win32';
const IS_DARWIN = platform() === 'darwin';
// Node's os.arch() reports 'arm64' on Apple Silicon, 'x64' on Intel — the
// platform.machine() probe below reports 'arm64' / 'x86_64'. Normalize both
// onto the python convention so callers compare apples to apples.
export const HOST_ARCH = ({ arm64: 'arm64', x64: 'x86_64' })[arch()] || arch();

export const REQUIRED_PACKAGES = IS_DARWIN
  ? ['mflux', 'mlx', 'mlx_vlm', 'mlx_video', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm']
  : IS_WIN
    ? ['transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm', 'torch', 'diffusers']
    : ['mflux', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm'];

// Some package identifiers in REQUIRED_PACKAGES need to be probed via a
// deeper submodule import to distinguish two PyPI packages that publish the
// same top-level namespace. `mlx_video` is the prime case: the plain PyPI
// package `mlx_video` is unrelated (video classification) and lacks the
// `generate_av` CLI the LTX renderer shells into. We want the wrong package
// to FAIL the check so the UI's "Install missing" button reappears and the
// `installPackages` pre-uninstall path (PIP_PRE_UNINSTALL) can swap it out.
const IMPORT_PROBE_PATHS = IS_DARWIN ? { mlx_video: 'mlx_video.generate_av' } : {};
const importProbePathFor = (importName) => IMPORT_PROBE_PATHS[importName] || importName;

// The PyPI package literally named `mlx_video` is unrelated (a video
// classification lib); the one shipping `mlx_video.generate_av` is
// `mlx-video-with-audio`. Both expose `import mlx_video`, so the conflict
// hides at namespace-probe time — `IMPORT_PROBE_PATHS` + `PIP_PRE_UNINSTALL`
// below force a deeper probe and uninstall the wrong package first.
const MLX_VIDEO_PIP = 'mlx-video-with-audio>=0.1.35';

const PIP_NAMES = {
  cv2: 'opencv-python',
  // mlx-compatible transformers must stay <5; Windows torch path uses latest.
  ...(IS_DARWIN ? { transformers: 'transformers<5' } : {}),
  ...(IS_DARWIN ? { mlx_video: MLX_VIDEO_PIP } : {}),
};

// Keys are pipNameFor-output specs; values are the conflicting package names
// to remove before install. Mirrors `scripts/setup-image-video.sh`.
const PIP_PRE_UNINSTALL = {
  [MLX_VIDEO_PIP]: ['mlx_video'],
};

export const pipNameFor = (importName) => PIP_NAMES[importName] || importName;

const HOME = homedir();

// Earlier = preferred. Non-externally-managed Pythons (venvs, conda) win
// over Homebrew/system Pythons because PEP 668 blocks pip there.
const PYTHON_CANDIDATES = IS_WIN
  ? [
      join(PATHS.data, 'python', 'venv', 'Scripts', 'python.exe'),
      join(HOME, '.portos', 'venv', 'Scripts', 'python.exe'),
      join(HOME, '.pixie-forge', 'venv', 'Scripts', 'python.exe'),
      // Standalone python.org installs are preferred over conda on Windows.
      // A venv created from a conda/miniconda base inherits conda's MKL +
      // OpenMP DLLs, which make torch fail to load at runtime with
      // "WinError 1114: c10.dll initialization routine failed" — so a
      // conda-based FLUX.2 venv installs cleanly but can't import torch.
      // Conda stays last as a usable-for-non-torch fallback when it's the
      // only Python present.
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      join(HOME, 'miniconda3', 'python.exe'),
      join(HOME, 'anaconda3', 'python.exe'),
      'C:\\miniconda3\\python.exe',
      'C:\\anaconda3\\python.exe',
    ]
  : [
      join(PATHS.data, 'python', 'venv', 'bin', 'python3'),
      join(HOME, '.portos', 'venv', 'bin', 'python3'),
      join(HOME, '.pixie-forge', 'venv', 'bin', 'python3'),
      '/opt/miniconda3/bin/python3',
      '/opt/anaconda3/bin/python3',
      join(HOME, 'miniconda3', 'bin', 'python3'),
      join(HOME, 'anaconda3', 'bin', 'python3'),
      join(HOME, '.pyenv', 'shims', 'python3'),
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
    ];

export async function probePythonArch(pythonPath) {
  const { stdout } = await execFileAsync(pythonPath, [
    '-c', 'import platform; print(platform.machine())'
  ], { env: safeChildProcessEnv(), timeout: 10_000 }).catch(() => ({ stdout: '' }));
  return stdout.trim() || null;
}

export async function isArchMismatch(pythonPath) {
  if (!IS_DARWIN) return false;
  const interp = await probePythonArch(pythonPath);
  if (!interp) return false;
  return interp !== HOST_ARCH;
}

// Find first candidate matching `predicate(arch)` by probing arches in parallel.
const firstArchMatch = async (candidates, predicate) => {
  const arches = await Promise.all(candidates.map(probePythonArch));
  const idx = arches.findIndex((a) => a && predicate(a));
  return idx >= 0 ? candidates[idx] : null;
};

export async function detectPython() {
  // mlx ships arm64-only wheels; prefer an arm64 interpreter on Apple Silicon
  // so /opt/anaconda3 (often x86_64) doesn't beat /opt/homebrew/bin/python3.
  const present = PYTHON_CANDIDATES.filter((p) => existsSync(p));
  if (IS_DARWIN && HOST_ARCH === 'arm64' && present.length > 1) {
    const match = await firstArchMatch(present, (a) => a === HOST_ARCH);
    if (match) return match;
  }
  if (present.length) return present[0];
  return whichFirst(IS_WIN ? 'python' : 'python3');
}

export async function detectArm64Python() {
  if (!IS_DARWIN || HOST_ARCH !== 'arm64') return null;
  const present = PYTHON_CANDIDATES.filter((p) => existsSync(p));
  return firstArchMatch(present, (a) => a === 'arm64');
}

// True when an NVIDIA GPU is present (nvidia-smi lists at least one device).
// Used to decide whether the Windows FLUX.2 install pulls CUDA torch from the
// PyTorch index vs. the default CPU wheel. Best-effort: a missing nvidia-smi
// or any failure reads as "no GPU".
export async function hasNvidiaGpu() {
  const { stdout } = await execFileAsync('nvidia-smi', ['-L'], { timeout: 8000 })
    .catch(() => ({ stdout: '' }));
  return /GPU \d+:/.test(stdout);
}

// FLUX.2 runs in its own venv because mflux (MLX) and torch+diffusers-from-git
// have hostile dependency trees. Bootstrap with `INSTALL_FLUX2=1
// scripts/setup-image-video.sh`. We probe a small candidate list rather than
// asking the user to configure it separately — first match wins.
const FLUX2_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-flux2', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-flux2', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-flux2', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-flux2', 'bin', 'python3'),
    ];

export const FLUX2_VENV_DEFAULT = FLUX2_VENV_CANDIDATES[0];

let cachedFlux2Python = null;
export function resolveFlux2Python() {
  if (cachedFlux2Python && existsSync(cachedFlux2Python)) return cachedFlux2Python;
  for (const p of FLUX2_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedFlux2Python = p; return p; }
  }
  return null;
}

// Whether the venv can actually run the FLUX.2 pipeline. Distinct from
// resolveFlux2Python() which only confirms the python binary exists — a
// killed-mid-install run leaves the binary but no packages, and we'd
// otherwise report that broken state as "ready" forever. Cached because the
// import probe spawns a process; bust via invalidateFlux2Health().
let cachedFlux2Healthy = null;
export async function isFlux2VenvHealthy() {
  if (cachedFlux2Healthy !== null) return cachedFlux2Healthy;
  const py = resolveFlux2Python();
  if (!py) { cachedFlux2Healthy = false; return false; }
  const ok = await execFileAsync(py, ['-c', 'from diffusers import Flux2KleinPipeline'], { env: safeChildProcessEnv(), timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  cachedFlux2Healthy = ok;
  return ok;
}
export function invalidateFlux2Health() {
  cachedFlux2Python = null;
  cachedFlux2Healthy = null;
}

// mflux's `mflux-train` LoRA trainer CLI is a console script installed beside
// whichever Python pip-installed mflux. Historically that's the system /
// image-gen Python (`pip install --user`), but on a box whose system Python
// can't host mflux (too old, or PEP 668 externally-managed),
// `scripts/setup-image-video.sh` instead builds a dedicated venv at
// ~/.portos/venv-mflux — which we auto-discover here, mirroring
// resolveFlux2Python. macOS/Linux only in practice (mflux is MLX/Apple-Silicon;
// there's no Windows trainer), but the candidate list stays Windows-shaped for
// symmetry with the other resolvers.
const MFLUX_TRAIN_BIN = IS_WIN ? 'mflux-train.exe' : 'mflux-train';

// True when `mflux-train` sits next to `pythonPath` (the same probe
// loraTraining's isMfluxTrainAvailable uses; kept here so resolveMfluxPython is
// self-contained). Null/empty path → false.
export const hasMfluxTrain = (pythonPath) =>
  !!pythonPath && existsSync(join(dirname(pythonPath), MFLUX_TRAIN_BIN));

const MFLUX_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-mflux', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-mflux', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-mflux', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-mflux', 'bin', 'python3'),
    ];

export const MFLUX_VENV_DEFAULT = MFLUX_VENV_CANDIDATES[0];

// Resolve the Python whose `mflux-train` PortOS should spawn for MLX LoRA
// training. Preference order: (1) an explicitly-configured image-gen Python
// that actually ships mflux-train — the historical `pip --user` layout, so
// existing installs behave exactly as before; (2) the first dedicated
// ~/.portos/venv-mflux that ships it. When neither ships mflux-train, return
// the configured path unchanged (or null) so the caller's isMfluxTrainAvailable
// still reports the honest "not installed" state instead of a phantom venv path.
export function resolveMfluxPython(configuredPath = null) {
  if (hasMfluxTrain(configuredPath)) return configuredPath;
  for (const p of MFLUX_VENV_CANDIDATES) {
    if (hasMfluxTrain(p)) return p;
  }
  return configuredPath || null;
}

// MusicGen (Pipeline Audio Phase 4c.2) runs in its own venv at
// ~/.portos/venv-musicgen — mlx + numpy + transformers, kept apart from the
// FLUX.2 torch pile. The MLX MusicGen implementation isn't a pip package, so
// `INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh` also clones
// ml-explore/mlx-examples to ~/.portos/mlx-examples; the sidecar imports
// `MusicGen` from its `musicgen/` directory (see MUSICGEN_RUNTIME_DIR).
const MUSICGEN_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-musicgen', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-musicgen', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-musicgen', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-musicgen', 'bin', 'python3'),
    ];

export const MUSICGEN_VENV_DEFAULT = MUSICGEN_VENV_CANDIDATES[0];

// The mlx-examples clone's musicgen package directory — passed to the sidecar
// as --runtime-dir so it can `from musicgen import MusicGen`. The default
// mirrors the setup script's clone target.
export const MUSICGEN_RUNTIME_DIR = join(HOME, '.portos', 'mlx-examples', 'musicgen');

let cachedMusicgenPython = null;
export function resolveMusicgenPython() {
  if (cachedMusicgenPython && existsSync(cachedMusicgenPython)) return cachedMusicgenPython;
  for (const p of MUSICGEN_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedMusicgenPython = p; return p; }
  }
  return null;
}

export function invalidateMusicgenPython() {
  cachedMusicgenPython = null;
}

// AudioLDM2 (Pipeline Audio Phase 4c.2 — second music backend) runs in its own
// venv at ~/.portos/venv-audioldm2 — torch + diffusers + transformers, kept
// apart from MusicGen's MLX pile. AudioLDM2 ships in HuggingFace `diffusers` (a
// pip package), so unlike MusicGen there's no clone to import from; the sidecar
// has an optional --runtime-dir for parity but normally just imports diffusers.
// `INSTALL_AUDIOLDM2=1 bash scripts/setup-image-video.sh` provisions the venv.
const AUDIOLDM2_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-audioldm2', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-audioldm2', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-audioldm2', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-audioldm2', 'bin', 'python3'),
    ];

export const AUDIOLDM2_VENV_DEFAULT = AUDIOLDM2_VENV_CANDIDATES[0];

// Optional dir prepended to the sidecar's sys.path before importing diffusers.
// AudioLDM2 normally imports straight from the venv's diffusers, so this is an
// empty sentinel (the sidecar's --runtime-dir is a no-op when blank); kept for
// argv parity with the MusicGen sidecar and so a vendored diffusers build can
// be pointed at later without a contract change.
export const AUDIOLDM2_RUNTIME_DIR = '';

let cachedAudioldm2Python = null;
export function resolveAudioldm2Python() {
  if (cachedAudioldm2Python && existsSync(cachedAudioldm2Python)) return cachedAudioldm2Python;
  for (const p of AUDIOLDM2_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedAudioldm2Python = p; return p; }
  }
  return null;
}

export function invalidateAudioldm2Python() {
  cachedAudioldm2Python = null;
}

// ACE-Step (third music backend — full-song generation with vocals) runs in its
// own venv at ~/.portos/venv-acestep — the `acestep` pip package + torch, kept
// apart from the MusicGen MLX pile and the AudioLDM2 diffusers pile. ACE-Step
// installs as a pip package (no clone to import from), so the sidecar normally
// imports it straight from the venv; the optional --runtime-dir points at a
// vendored checkout if ever needed. `INSTALL_ACESTEP=1 bash
// scripts/setup-image-video.sh` provisions the venv. ACE-Step resolves its own
// model checkpoints (auto-download to ~/.cache/ace-step/checkpoints).
const ACESTEP_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-acestep', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-acestep', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-acestep', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-acestep', 'bin', 'python3'),
    ];

export const ACESTEP_VENV_DEFAULT = ACESTEP_VENV_CANDIDATES[0];

// Optional dir prepended to the sidecar's sys.path before importing acestep.
// Empty sentinel (the sidecar's --runtime-dir is a no-op when blank) — ACE-Step
// imports from the venv's installed package; kept for argv parity with the other
// music sidecars and so a vendored checkout can be pointed at later.
export const ACESTEP_RUNTIME_DIR = '';

let cachedAcestepPython = null;
export function resolveAcestepPython() {
  if (cachedAcestepPython && existsSync(cachedAcestepPython)) return cachedAcestepPython;
  for (const p of ACESTEP_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedAcestepPython = p; return p; }
  }
  return null;
}

export function invalidateAcestepPython() {
  cachedAcestepPython = null;
}

// MuScriptor (audio → MIDI transcription for the Rounds workbench + Music Video
// parsing, #reference-audio-to-midi) runs in its own venv at
// ~/.portos/venv-muscriptor — the `muscriptor` pip package pulls its own torch
// stack, kept apart from the music-generation venvs above. Model weights
// auto-download from HuggingFace on first transcription (small/medium/large).
// `INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh` provisions the venv;
// the sidecar is `scripts/transcribe_muscriptor.py`.
const MUSCRIPTOR_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-muscriptor', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-muscriptor', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-muscriptor', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-muscriptor', 'bin', 'python3'),
    ];

export const MUSCRIPTOR_VENV_DEFAULT = MUSCRIPTOR_VENV_CANDIDATES[0];

let cachedMuscriptorPython = null;
export function resolveMuscriptorPython() {
  if (cachedMuscriptorPython && existsSync(cachedMuscriptorPython)) return cachedMuscriptorPython;
  for (const p of MUSCRIPTOR_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedMuscriptorPython = p; return p; }
  }
  return null;
}

// A killed-mid-install run (e.g. the user cancels the in-app installer during
// pip) leaves the venv's python binary but no `muscriptor` package.
// resolveMuscriptorPython() only existsSync's the binary, so it would report
// that broken state as ready — the transcription then fails deep in the sidecar
// and, because the binary IS present, no 503 fires to re-open the installer.
// Probe the actual import the sidecar needs (mirrors isByovRuntimeReady / the
// Flux2 health check) so a partial venv is treated as not-ready: the 503 gate
// re-opens the installer and the install short-circuit runs the repair instead
// of claiming "already installed". Only the positive result is cached (the
// probe spawns a process); a not-ready venv re-probes each call so an
// out-of-band repair reflects without a restart. Bust via invalidateMuscriptorPython().
let cachedMuscriptorReady = false;
export async function isMuscriptorRuntimeReady() {
  if (cachedMuscriptorReady) return true;
  const py = resolveMuscriptorPython();
  if (!py) return false;
  const ok = await execFileAsync(py, ['-c', 'from muscriptor import TranscriptionModel'], { env: safeChildProcessEnv(), timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  cachedMuscriptorReady = ok;
  return ok;
}

export function invalidateMuscriptorPython() {
  cachedMuscriptorPython = null;
  cachedMuscriptorReady = false;
}

// Used by /api/image-gen/setup/* routes to validate user-supplied pythonPath
// before exec. Single-user / Tailnet model means we trust the operator, but
// "you can shell out to anything" is still too sharp — restrict to actual
// python interpreters by basename, and accept a candidate path if it is one
// we discovered ourselves.
const PYTHON_BASENAMES = IS_WIN
  ? ['python.exe', 'python3.exe']
  : ['python', 'python3'];

export function isAllowedPython(pythonPath) {
  if (typeof pythonPath !== 'string' || !pythonPath) return false;
  if (PYTHON_CANDIDATES.includes(pythonPath)) return true;
  // Allow any path whose basename looks like a python interpreter — covers
  // user-typed venvs (`/path/to/.venv/bin/python3.12`) without opening up
  // arbitrary-binary execution.
  const base = pythonPath.split(/[\\/]/).pop().toLowerCase();
  if (PYTHON_BASENAMES.includes(base)) return true;
  // Also accept python3.NN variants like python3.10, python3.11, python.exe etc.
  if (/^python(3(\.\d+)?)?(\.exe)?$/i.test(base)) return true;
  return false;
}

// Idempotent: if the venv exists, returns its python path without recreating.
// Windows venvs put the interpreter at Scripts\python.exe, POSIX at bin/python3.
export async function createVenv(basePython, targetDir) {
  const venvPython = IS_WIN
    ? join(targetDir, 'Scripts', 'python.exe')
    : join(targetDir, 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  await execFileAsync(basePython, ['-m', 'venv', targetDir], { env: safeChildProcessEnv(), timeout: 120_000 });
  if (!existsSync(venvPython)) {
    throw new Error(`Venv created but interpreter missing at ${venvPython}`);
  }
  return venvPython;
}

export async function probePythonHealth(pythonPath) {
  const importLines = REQUIRED_PACKAGES.map((pkg) =>
    `try:\n import ${importProbePathFor(pkg)}\n imports["${pkg}"] = True\nexcept Exception:\n imports["${pkg}"] = False`,
  ).join('\n');
  const probe = [
    'import sys, sysconfig, platform, json',
    'imports = {}',
    importLines,
    'print(json.dumps({',
    '  "prefix": sys.prefix,',
    '  "basePrefix": sys.base_prefix,',
    '  "stdlib": sysconfig.get_path("stdlib"),',
    '  "arch": platform.machine(),',
    '  "imports": imports,',
    '}))',
  ].join('\n');
  const { stdout } = await execFileAsync(pythonPath, ['-c', probe], { env: safeChildProcessEnv(), timeout: 30_000 });
  const data = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  const installed = [];
  const missing = [];
  for (const pkg of REQUIRED_PACKAGES) {
    (data.imports[pkg] ? installed : missing).push(pkg);
  }
  // Inside a venv, sysconfig.get_path("stdlib") resolves to the base
  // interpreter's stdlib — so a venv from PEP 668 Homebrew Python would
  // inherit the marker even though pip-in-venv ignores PEP 668. Skip the
  // marker check when sys.prefix != sys.base_prefix.
  const inVenv = data.prefix && data.basePrefix && data.prefix !== data.basePrefix;
  const externallyManaged = !inVenv && data.stdlib
    ? existsSync(join(data.stdlib, 'EXTERNALLY-MANAGED'))
    : false;
  return {
    installed,
    missing,
    missingPip: missing.map(pipNameFor),
    externallyManaged,
    interpreterArch: data.arch || null,
  };
}

export async function checkPackages(pythonPath) {
  const { installed, missing, missingPip } = await probePythonHealth(pythonPath);
  return { installed, missing, missingPip };
}

// Spawn a child, stream its stdout+stderr line-by-line via `onLog`, resolve
// with the exit code (or -1 on spawn error). `onProc` is invoked with the
// live child handle so the caller's outer closure can track it for SIGTERM.
function streamSpawn(bin, args, onLog, onProc) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    onProc(proc);
    // `splitRe: /[\r\n]+/` so a torch/tqdm progress bar that redraws with a
    // bare `\r` surfaces each redraw as its own log line; the carry buffer
    // stitches a line split across chunk boundaries.
    const onLine = (line) => {
      const t = line.trim();
      if (t) onLog({ type: 'log', message: t });
    };
    const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
    const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
    proc.stdout.on('data', stdoutReader.push);
    proc.stderr.on('data', stderrReader.push);
    proc.on('close', (code) => { stdoutReader.flush(); stderrReader.flush(); onProc(null); resolve(code ?? -1); });
    proc.on('error', (err) => { onLog({ type: 'error', message: err.message }); onProc(null); resolve(-1); });
  });
}

// Returns `{ promise, kill }` so the route can SIGTERM the pip child if the
// SSE client disconnects mid-install — a 10-minute torch upgrade would
// otherwise keep running invisibly.
export function installPackages(pythonPath, importNames, onLog) {
  const pipSpecs = importNames.map(pipNameFor);
  const conflicts = [...new Set(pipSpecs.flatMap((s) => PIP_PRE_UNINSTALL[s] || []))];

  let currentProc = null;
  let killed = false;
  const trackProc = (p) => { currentProc = p; };
  const runPip = (args) => streamSpawn(pythonPath, ['-m', 'pip', ...args], onLog, trackProc);

  const promise = (async () => {
    if (conflicts.length) {
      onLog({ type: 'log', message: `pip uninstall -y ${conflicts.join(' ')} (resolving package-name conflict)` });
      // Uninstall isn't allowed to fail the run — when the conflicting
      // package isn't installed pip exits non-zero with a "not installed"
      // message that's noise, not an error.
      await runPip(['uninstall', '--yes', ...conflicts]);
      if (killed) return { ok: false, code: -1 };
    }
    onLog({ type: 'log', message: `pip install ${pipSpecs.join(' ')}` });
    const code = await runPip(['install', '--upgrade', '--progress-bar', 'on', ...pipSpecs]);
    if (code === 0) {
      onLog({ type: 'complete', message: 'All packages installed successfully.' });
      return { ok: true, code: 0 };
    }
    onLog({ type: 'error', message: `pip exited with code ${code}` });
    return { ok: false, code };
  })();

  return {
    promise,
    kill: () => {
      killed = true;
      if (currentProc && !currentProc.killed) currentProc.kill('SIGTERM');
    },
  };
}

// torch + torchvision are split out from the rest of the FLUX.2 venv specs
// because Windows needs the CUDA-enabled wheels from PyTorch's own index: the
// default PyPI `torch` wheel on Windows is CPU-only (`torch==X+cpu`), which
// makes local image-gen unusably slow on an NVIDIA box. Linux's default PyPI
// torch already bundles CUDA and macOS uses the default MPS-capable wheel, so
// only Windows + NVIDIA needs the index swap (see installFlux2Venv).
export const FLUX2_TORCH_SPECS = ['torch>=2.5', 'torchvision'];

// PyTorch CUDA wheel index used on Windows + NVIDIA. cu126 (CUDA 12.6) is the
// broadest-compatible recent index — drivers >= ~525 support it — and serves
// current torch builds. Override with PORTOS_TORCH_CUDA_INDEX (e.g.
// https://download.pytorch.org/whl/cu130) if a newer/older CUDA is needed.
export const WIN_TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu126';

// Pip specs for the FLUX.2 venv. Mirrors scripts/setup-image-video.sh so the
// shell path and the in-app installer stay in sync. diffusers + sdnq are
// git-only because Flux2KleinPipeline isn't in any tagged release yet.
export const FLUX2_PIP_SPECS = [
  ...FLUX2_TORCH_SPECS,
  'accelerate',
  'transformers>=4.51',
  'sentencepiece',
  'protobuf',
  'safetensors',
  'huggingface_hub[hf_xet]',
  'diffusers @ git+https://github.com/huggingface/diffusers',
  'sdnq @ git+https://github.com/Disty0/sdnq.git',
  'peft>=0.17',
  'optimum-quanto>=0.2.7',
  'pillow',
];

// Bootstrap the FLUX.2 venv from inside the app so users don't have to drop to
// a shell. Drives staged SSE progress: detect → venv → upgrade-pip → install
// → verify. onLog gets `{ type: 'log' | 'stage' | 'error' | 'complete', stage?, message }`.
// Returns `{ promise, kill }` like installPackages so the route can SIGTERM
// pip if the EventSource is closed mid-install.
export function installFlux2Venv(onLog) {
  let currentProc = null;
  let killed = false;

  const stage = (name, message) => onLog({ type: 'stage', stage: name, message });
  const log = (message) => onLog({ type: 'log', message });

  const trackProc = (p) => { currentProc = p; };
  const runPython = async (args) =>
    (await streamSpawn(args[0], args.slice(1), onLog, trackProc)) === 0;

  const promise = (async () => {
    stage('detect', 'Looking for system Python…');
    const basePython = await detectPython();
    if (!basePython) {
      onLog({ type: 'error', message: 'No system Python 3 found. Install Python 3.10+ and try again.' });
      return { ok: false, stage: 'detect' };
    }
    log(`Using base Python: ${basePython}`);

    stage('venv', `Creating FLUX.2 venv at ${FLUX2_VENV_DEFAULT}…`);
    const targetDir = FLUX2_VENV_DEFAULT.replace(IS_WIN ? /\\Scripts\\python\.exe$/ : /\/bin\/python3$/, '');
    const venvPython = await createVenv(basePython, targetDir).catch((err) => {
      onLog({ type: 'error', message: `venv creation failed: ${err.message}` });
      return null;
    });
    if (!venvPython) return { ok: false, stage: 'venv' };
    if (killed) return { ok: false, stage: 'venv', cancelled: true };

    stage('upgrade-pip', 'Upgrading pip + wheel + setuptools…');
    if (!await runPython([venvPython, '-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'])) {
      return { ok: false, stage: 'upgrade-pip' };
    }
    if (killed) return { ok: false, stage: 'upgrade-pip', cancelled: true };

    stage('install', 'Installing torch + diffusers + sdnq + transformers (~6-10 min — large download)…');
    if (IS_WIN) {
      // Windows: install torch+torchvision first so the right wheel sticks,
      // then the rest WITHOUT torch in the list — otherwise the `--upgrade`
      // below would re-pull the CPU-only PyPI torch over the CUDA build.
      const useCuda = await hasNvidiaGpu();
      const cudaIndex = process.env.PORTOS_TORCH_CUDA_INDEX || WIN_TORCH_CUDA_INDEX;
      log(useCuda
        ? `NVIDIA GPU detected — installing CUDA torch from ${cudaIndex}`
        : 'No NVIDIA GPU detected — installing CPU torch (image-gen will be slow)');
      const torchArgs = ['install', '--upgrade', '--progress-bar', 'on', ...FLUX2_TORCH_SPECS];
      if (useCuda) torchArgs.push('--index-url', cudaIndex);
      if (!await runPython([venvPython, '-m', 'pip', ...torchArgs])) {
        return { ok: false, stage: 'install' };
      }
      if (killed) return { ok: false, stage: 'install', cancelled: true };
      const otherSpecs = FLUX2_PIP_SPECS.filter((s) => !FLUX2_TORCH_SPECS.includes(s));
      if (!await runPython([venvPython, '-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on', ...otherSpecs])) {
        return { ok: false, stage: 'install' };
      }
    } else if (!await runPython([venvPython, '-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on', ...FLUX2_PIP_SPECS])) {
      return { ok: false, stage: 'install' };
    }
    if (killed) return { ok: false, stage: 'install', cancelled: true };

    stage('verify', 'Verifying Flux2KleinPipeline import…');
    if (!await runPython([venvPython, '-c', 'from diffusers import Flux2KleinPipeline; print("ok")'])) {
      onLog({ type: 'error', message: 'Verification failed: Flux2KleinPipeline did not import. Try INSTALL_FLUX2=1 FLUX2_FORCE_REINSTALL=1 bash scripts/setup-image-video.sh' });
      return { ok: false, stage: 'verify' };
    }

    invalidateFlux2Health();

    onLog({ type: 'complete', message: `FLUX.2 venv ready: ${venvPython}` });
    return { ok: true, pythonPath: venvPython };
  })();

  return {
    promise,
    kill: () => {
      killed = true;
      if (currentProc && !currentProc.killed) currentProc.kill('SIGTERM');
    },
  };
}
