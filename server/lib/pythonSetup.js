import { execFile, spawn } from './childProcess.js';
import { existsSync, readdirSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from './fileUtils.js';
import { isAppleSilicon } from './platform.js';
import { LOCK_PROFILES, lockProfileUnsupportedReason, planLockedRepair } from './pythonLockProfiles.js';
import { ensurePrivateUv } from './privateUv.js';
import { safeChildProcessOptions, whichFirst, whichFirstSync } from './processEnv.js';
import { createLineReader } from './streamLines.js';

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === 'win32';
const IS_DARWIN = platform() === 'darwin';
// Node's os.arch() is 'arm64' or 'x64'. Python's platform.machine() is
// 'arm64' / 'x86_64'. HOST_ARCH is the Node process in Python's spelling,
// for interpreter-vs-process compares (isArchMismatch). It is x86_64 when
// Node itself is under Rosetta. "Can this Mac run MLX?" is hostIsAppleSilicon().
export const HOST_ARCH = ({ arm64: 'arm64', x64: 'x86_64' })[arch()] || arch();

export function hostIsAppleSilicon() {
  return isAppleSilicon({ platform: platform(), arch: arch() });
}

export const REQUIRED_PACKAGES = IS_DARWIN
  ? ['mflux', 'mlx', 'mlx_vlm', 'mlx_video', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm']
  : IS_WIN
    ? ['transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm', 'torch', 'diffusers']
    : ['mflux', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm', 'torch', 'diffusers'];

// Some package identifiers in REQUIRED_PACKAGES need to be probed via a
// deeper submodule import to distinguish two PyPI packages that publish the
// same top-level namespace. `mlx_video` is the prime case: the plain PyPI
// package `mlx_video` is unrelated (video classification) and lacks the
// `generate_av` CLI the LTX renderer shells into. We want the wrong package
// to FAIL the check so the UI's "Install missing" button reappears and the
// `installPackages` pre-uninstall path (MFLUX_VIDEO_PRE_UNINSTALL) can swap it out.
const IMPORT_PROBE_PATHS = IS_DARWIN ? { mlx_video: 'mlx_video.generate_av' } : {};
const importProbePathFor = (importName) => IMPORT_PROBE_PATHS[importName] || importName;

// The PyPI package literally named `mlx_video` is unrelated (a video
// classification lib); the one shipping `mlx_video.generate_av` is
// `mlx-video-with-audio`. Both expose `import mlx_video`, so the conflict
// hides at namespace-probe time — `IMPORT_PROBE_PATHS` + `MFLUX_VIDEO_PRE_UNINSTALL`
// below force a deeper probe and uninstall the wrong package first.
const MLX_VIDEO_PIP = 'mlx-video-with-audio>=0.1.35';

const PIP_NAMES = {
  cv2: 'opencv-python',
  // Apple Silicon never installs transformers by name: the mflux lock pins the
  // >=5,<6 build mflux 0.17.5 needs (see MFLUX_LOCK_PACKAGES). Other Macs keep <5.
  ...(IS_DARWIN && !hostIsAppleSilicon() ? { transformers: 'transformers<5' } : {}),
  ...(IS_DARWIN ? { mlx_video: MLX_VIDEO_PIP } : {}),
};

// Packages whose wrong namesake must be removed before the mflux-video lock
// installs the real one (see MLX_VIDEO_PIP). Mirrors `scripts/setup-image-video.sh`.
const MFLUX_VIDEO_PRE_UNINSTALL = ['mlx_video'];

export const pipNameFor = (importName) => PIP_NAMES[importName] || importName;

const HOME = homedir();

// uv-managed CPython installs (`uv python install 3.10`). These are standalone
// python-build-standalone builds — no conda MKL/OpenMP in the DLL search path —
// which makes them the right base for a torch venv, so they rank with the
// python.org installs and ahead of conda. uv's install root is versioned and
// platform-tagged (`cpython-3.10.19-windows-x86_64-none`), so it has to be
// enumerated rather than listed. Newest version first; a bad read (uv absent,
// which is the common case) yields nothing rather than throwing.
const UV_PYTHON_ROOT = IS_WIN
  ? join(HOME, 'AppData', 'Roaming', 'uv', 'python')
  : join(HOME, '.local', 'share', 'uv', 'python');

function uvPythonCandidates() {
  let entries;
  try {
    entries = readdirSync(UV_PYTHON_ROOT);
  } catch {
    return [];
  }
  // Sort by the version triple descending, so 3.13 beats 3.10 and 3.10.19 beats
  // the bare 3.10 alias. localeCompare's numeric mode keeps 3.9 < 3.10.
  return entries
    .filter((name) => name.startsWith('cpython-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => join(UV_PYTHON_ROOT, name, IS_WIN ? 'python.exe' : join('bin', 'python3')));
}

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

// PortOS's own managed venvs — the first three PYTHON_CANDIDATES entries on
// both platforms. Fine as a pip-install target (detectPython/detectPythonSync),
// but never a valid BASE to create a *different* venv from: a venv created
// from another venv can fail with the base's own pyvenv.cfg pointing at an
// interpreter path that no longer resolves (e.g. after a Homebrew point-release
// upgrade prunes the old versioned keg the app venv was built against). See
// detectVenvBasePythonSync below.
const APP_MANAGED_VENV_PYTHONS = new Set(PYTHON_CANDIDATES.slice(0, 3));

// PYTHON_CANDIDATES minus the app-managed venvs — the fallback pool for
// picking a base interpreter to CREATE a venv from, as opposed to
// PYTHON_CANDIDATES' own ordering, which is tuned for "which interpreter can
// we pip packages into" (detectPython/detectPythonSync).
const NON_APP_MANAGED_CANDIDATES = PYTHON_CANDIDATES.filter((p) => !APP_MANAGED_VENV_PYTHONS.has(p));

export async function probePythonArch(pythonPath) {
  const { stdout } = await execFileAsync(pythonPath, [
    '-c', 'import platform; print(platform.machine())'
  ], safeChildProcessOptions({ timeout: 10_000 })).catch(() => ({ stdout: '' }));
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

// First installed candidate — the synchronous half of detectPython(), for
// callers that cannot await (spawnSetupScript in lib/setupScriptRunner.js,
// where an extra await would open an abort window between the in-flight claim
// and the spawn). Prefer detectPython() when you can: the arch probe this
// skips is what keeps an x86_64 conda from beating an arm64 Homebrew python
// for mlx wheels on Apple Silicon.
export function detectPythonSync() {
  const present = PYTHON_CANDIDATES.find((p) => existsSync(p));
  if (present) return present;
  // Same PATH fallback detectPython() ends on — without it a Python installed
  // somewhere the candidate list does not name (scoop, chocolatey, a custom
  // dir) reads as "no Python at all", which is exactly the box where the
  // Windows installer then falls back to its broken `python3` default.
  const found = whichFirstSync(IS_WIN ? 'python' : 'python3');
  // The WindowsApps alias is a Store launcher, not an interpreter: it opens the
  // Microsoft Store and exits, so a venv built from it never appears.
  if (found && /\\Microsoft\\WindowsApps\\/i.test(found)) return null;
  return found || null;
}

// The interpreter to build a torch venv FROM — a different question than
// detectPythonSync's "which interpreter can we pip into".
//
// Those two answers conflict. `detectPythonSync` ranks conda highly precisely
// because conda is not PEP 668 externally-managed, so `installPackages` can pip
// straight into it. But a venv created from a conda base installs torch fine and
// then dies at `import torch` with "WinError 1114: c10.dll initialization routine
// failed" — conda's MKL/OpenMP DLLs poison the child venv's DLL search path.
// uv/python.org standalone builds are the reverse: externally-managed (so a bad
// pip target) but a perfect venv base.
//
// So this prefers standalone builds and only falls back to a non-app-managed
// PYTHON_CANDIDATES entry (a conda-based venv still beats no venv at all, and
// the setup script's own import check reports it when it can't work) — and,
// as a true last resort with nothing non-app-managed anywhere, PortOS's own
// managed venv rather than nothing.
//
// Deliberately excludes `data/python/venv` / `~/.portos/venv` /
// `~/.pixie-forge/venv` from every tier above the last: building a venv FROM
// one of those has its own failure mode independent of the conda/DLL issue
// above — see APP_MANAGED_VENV_PYTHONS.
export function venvBaseCandidatesSync() {
  const standalone = [
    ...uvPythonCandidates(),
    ...(IS_WIN
      ? [
          join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
          join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
          join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
          'C:\\Python313\\python.exe',
          'C:\\Python312\\python.exe',
          'C:\\Python311\\python.exe',
        ]
      : []),
  ];
  const seen = new Set();
  return [...standalone, ...NON_APP_MANAGED_CANDIDATES].filter((p) => {
    if (seen.has(p) || !existsSync(p)) return false;
    seen.add(p);
    return true;
  });
}

export function detectVenvBasePythonSync() {
  // detectPythonSync's own PYTHON_CANDIDATES sweep will find an app-managed
  // venv when nothing else exists — exactly the "beats no venv" last resort
  // this needs — and its PATH fallback carries the WindowsApps-alias filter,
  // which a hand-rolled whichFirstSync() call here would have to duplicate.
  return venvBaseCandidatesSync()[0] || detectPythonSync();
}

// Minimum CPython for a venv PortOS builds the torch/diffusers stack into.
//
// Below 3.10, pip resolves an old setuptools (<77) inside its own build
// isolation, and that setuptools rejects the PEP 639 *string* form of
// `project.license`. A git-sourced dependency that uses it — `sdnq` declares
// `license = "GPL-3.0-only"` — then dies in "Getting requirements to build
// wheel" with `project.license must be valid exactly by one definition`, which
// reads like a pip bug and lands only AFTER the multi-GB torch download. The
// same floor is what mflux/mlx need (scripts/setup-image-video.sh checks it
// before the `pip install --user` path) and what the model-abuse guard's own
// `isBasePythonSupported` enforces, so gate the BASE interpreter up front
// rather than diagnosing the build failure downstream.
//
// Nothing here caps the upper end: a base newer than the torch wheels support
// fails with pip's own "No matching distribution" message, which is already
// actionable, and hard-coding a ceiling would reject each new CPython release
// until someone remembered to raise it.
export const MIN_VENV_PYTHON = Object.freeze([3, 10]);
export const MIN_VENV_PYTHON_LABEL = MIN_VENV_PYTHON.join('.');

// `{ version, major, minor }` for an interpreter, or null when it can't be run
// (missing, not an interpreter, a Store alias, a venv whose base was pruned).
// Deliberately null rather than throwing: every caller treats "can't tell" the
// same as "too old", because building a torch venv from it is a coin flip.
export async function probePythonVersion(pythonPath, { env, timeout = 10_000 } = {}) {
  if (!pythonPath) return null;
  const { stdout } = await execFileAsync(
    pythonPath,
    ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
    // Room for a chatty interpreter's banner/deprecation noise before the
    // version line: a maxBuffer overflow rejects the interpreter outright, and
    // "rejected" here means refusing to install at all.
    safeChildProcessOptions({ ...(env ? { env } : {}), timeout, maxBuffer: 64 * 1024 }),
  ).catch(() => ({ stdout: '' }));
  const line = String(stdout).trim().split(/\r?\n/).pop() || '';
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(line);
  if (!parts) return null;
  return { version: line, major: Number(parts[1]), minor: Number(parts[2]) };
}

export const meetsMinVenvPython = (probed) =>
  !!probed && (probed.major > MIN_VENV_PYTHON[0]
    || (probed.major === MIN_VENV_PYTHON[0] && probed.minor >= MIN_VENV_PYTHON[1]));

export async function isSupportedVenvBase(pythonPath, options) {
  return meetsMinVenvPython(await probePythonVersion(pythonPath, options));
}

// venvBaseCandidatesSync() split by MIN_VENV_PYTHON, preserving its ordering
// (the tier ranking in that function is about torch loading correctly, and
// still decides which SUPPORTED base wins). `rejected` carries the version we
// found so the installer can say *why* a Python it can see is unusable instead
// of claiming none exists. Probes run in parallel: the list is short and
// already existsSync-filtered.
export async function classifyVenvBases() {
  const candidates = venvBaseCandidatesSync();
  const probed = await Promise.all(candidates.map((p) => probePythonVersion(p)));
  const supported = [];
  const rejected = [];
  candidates.forEach((path, i) => {
    if (meetsMinVenvPython(probed[i])) supported.push(path);
    else rejected.push({ path, version: probed[i]?.version || 'unknown' });
  });
  return { supported, rejected };
}

export async function detectPython() {
  // mlx ships arm64-only wheels. On Apple Silicon — including Node under
  // Rosetta, where HOST_ARCH is x86_64 — prefer an arm64 interpreter so
  // /opt/anaconda3 (often x86_64, listed first) doesn't beat Homebrew.
  const present = PYTHON_CANDIDATES.filter((p) => existsSync(p));
  if (IS_DARWIN && hostIsAppleSilicon() && present.length > 1) {
    const match = await firstArchMatch(present, (a) => a === 'arm64');
    if (match) return match;
  }
  if (present.length) return present[0];
  return whichFirst(IS_WIN ? 'python' : 'python3');
}

export async function detectArm64Python() {
  if (!IS_DARWIN || !hostIsAppleSilicon()) return null;
  const present = PYTHON_CANDIDATES.filter((p) => existsSync(p));
  return firstArchMatch(present, (a) => a === 'arm64');
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
//
// A positive result is cached indefinitely — once the venv imports cleanly it
// stays that way short of the user deleting it, which only happens through
// this module's own install/invalidate path. A NEGATIVE result gets a short
// TTL instead of the same indefinite cache: the shared diffusers venv also
// gates Z-Image/ERNIE/HiDream/Qwen (usesDiffusersRunner in runners.js), and a
// transient failure (venv mid-install, a package upgrade the user ran by hand
// outside PortOS) would otherwise report "unavailable" for the rest of the
// server's lifetime with no way for the user to recover short of a restart.
const FLUX2_HEALTH_NEGATIVE_TTL_MS = 60_000;
// Each selected pipeline has its own verdict: FLUX.2 importing successfully
// says nothing about a newer Qwen class being present in the same installation.
const flux2Health = new Map();
export async function isFlux2VenvHealthy(pipelineClass = '') {
  const key = pipelineClass || '';
  const cached = flux2Health.get(key);
  if (cached?.healthy === true) return true;
  if (cached?.healthy === false && Date.now() - cached.at < FLUX2_HEALTH_NEGATIVE_TTL_MS) return false;
  if (cached?.pending) return cached.pending;
  const entry = {};
  flux2Health.set(key, entry);
  entry.pending = probeFlux2Venv(key).then((healthy) => {
    entry.healthy = healthy;
    entry.at = Date.now();
    return healthy;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}
async function probeFlux2Venv(pipelineClass) {
  const py = resolveFlux2Python();
  // Pass registry content as argv, never interpolate it into Python code.
  const probe = 'from diffusers import Flux2KleinPipeline; import diffusers, sys; getattr(diffusers, sys.argv[1]) if sys.argv[1] else None';
  return py
    ? await execFileAsync(py, ['-c', probe, pipelineClass], safeChildProcessOptions({ timeout: 30_000 }))
      .then(() => true)
      .catch(() => false)
    : false;
}
// Pipeline classes the installer's verify stage guarantees. Membership rule:
// the base FLUX.2 pipeline, plus the NEWEST diffusers pipeline PortOS ships a
// model for — together they date the venv's diffusers snapshot, which is the
// only thing the verify stage can assert without a model download. Per-model
// classes are not listed here; the gate takes the selected model's own
// `pipelineClass` as an argument instead, so the registry stays the one place
// a new family is declared.
//
// The readiness GATE in front of the installer must require all of them:
// gating on the base `Flux2KleinPipeline` alone let a venv built before a
// newer pipeline landed report "already installed" while the per-model verdict
// (which probes that model's own `pipelineClass`) said unavailable — the user
// saw an Install button that answered "nothing to do".
export const FLUX2_VERIFY_PIPELINE_CLASSES = Object.freeze(['Flux2KleinPipeline', 'QwenImage21Pipeline']);

// Whether re-running the installer would be a no-op: every class the verify
// stage checks imports, plus the one the caller's selected model needs.
export async function isFlux2InstallSatisfied(pipelineClass = '') {
  const required = [...new Set([...FLUX2_VERIFY_PIPELINE_CLASSES, pipelineClass].filter(Boolean))];
  const results = await Promise.all(required.map((cls) => isFlux2VenvHealthy(cls)));
  return results.every(Boolean);
}

export function invalidateFlux2Health() {
  cachedFlux2Python = null;
  flux2Health.clear();
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

// Historical console-script probe retained for shared image-runtime discovery.
// Retirement never uninstalls or changes which existing venv is selected.
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

// Resolve the existing shared mflux Python. Preserve the historical preference
// order: (1) an explicitly-configured image-gen Python
// that actually ships mflux-train — the historical `pip --user` layout, so
// existing installs behave exactly as before; (2) the first dedicated
// ~/.portos/venv-mflux that ships it. When neither ships mflux-train, return
// the configured path unchanged (or null) rather than inventing a venv path.
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

// ACE-Step 1.5 has a different runtime from v1: its installed package supplies
// the multi-component Transformers pipeline that loads the fixed HF snapshot
// with trust_remote_code. Keep it in a sibling venv so v1 renders remain
// reproducible even when the two packages need different torch stacks.
const ACESTEP15_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-acestep15', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-acestep15', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-acestep15', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-acestep15', 'bin', 'python3'),
    ];

export const ACESTEP15_VENV_DEFAULT = ACESTEP15_VENV_CANDIDATES[0];
export const ACESTEP15_RUNTIME_DIR = '';

let cachedAcestep15Python = null;
export function resolveAcestep15Python() {
  if (cachedAcestep15Python && existsSync(cachedAcestep15Python)) return cachedAcestep15Python;
  for (const p of ACESTEP15_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedAcestep15Python = p; return p; }
  }
  return null;
}

const MINIMAX_MUSIC3_VENV_CANDIDATES = IS_WIN
  ? [
      join(HOME, '.portos', 'venv-minimax-music3', 'Scripts', 'python.exe'),
      join(PATHS.data, 'python', 'venv-minimax-music3', 'Scripts', 'python.exe'),
    ]
  : [
      join(HOME, '.portos', 'venv-minimax-music3', 'bin', 'python3'),
      join(PATHS.data, 'python', 'venv-minimax-music3', 'bin', 'python3'),
    ];

export const MINIMAX_MUSIC3_VENV_DEFAULT = MINIMAX_MUSIC3_VENV_CANDIDATES[0];
export const MINIMAX_MUSIC3_RUNTIME_DIR = '';

let cachedMinimaxMusic3Python = null;
export function resolveMinimaxMusic3Python() {
  if (cachedMinimaxMusic3Python && existsSync(cachedMinimaxMusic3Python)) return cachedMinimaxMusic3Python;
  for (const p of MINIMAX_MUSIC3_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedMinimaxMusic3Python = p; return p; }
  }
  return null;
}

// MiniMax Music 3's native MLX port runs in a separate venv from the CUDA
// Diffusers runtime above. Keeping the stacks isolated prevents a torch/
// diffusers upgrade from changing the MLX install (and vice versa).
const MINIMAX_MUSIC3_MLX_VENV_CANDIDATES = [
  join(HOME, '.portos', 'venv-minimax-music3-mlx', 'bin', 'python3'),
  join(PATHS.data, 'python', 'venv-minimax-music3-mlx', 'bin', 'python3'),
];

export const MINIMAX_MUSIC3_MLX_VENV_DEFAULT = MINIMAX_MUSIC3_MLX_VENV_CANDIDATES[0];
export const MINIMAX_MUSIC3_MLX_RUNTIME_DIR = '';

let cachedMinimaxMusic3MlxPython = null;
export function resolveMinimaxMusic3MlxPython() {
  if (cachedMinimaxMusic3MlxPython && existsSync(cachedMinimaxMusic3MlxPython)) return cachedMinimaxMusic3MlxPython;
  for (const p of MINIMAX_MUSIC3_MLX_VENV_CANDIDATES) {
    if (existsSync(p)) { cachedMinimaxMusic3MlxPython = p; return p; }
  }
  return null;
}

// Every venv PortOS provisions with `huggingface_hub` installed, in preference
// order. hfDownload.js falls back through these to find an interpreter that can
// run scripts/hf_download_repo.py when no image-gen runtime is configured — a
// music-only install still has to be able to download its own weights.
//
// ADDING A RUNTIME: if its setup-image-video.sh block pip-installs
// huggingface_hub, add its resolver here. This list used to live in
// hfDownload.js, where each new engine forgot it; keeping it next to the
// resolvers is what makes the omission visible.
export const HF_HUB_PYTHON_RESOLVERS = Object.freeze([
  resolveAcestepPython,
  resolveAudioldm2Python,
  resolveMusicgenPython,
  resolveMinimaxMusic3Python,
  resolveMinimaxMusic3MlxPython,
]);

// Every venv PortOS provisions that carries numpy, in preference order — the
// interpreter pool for numpy-only sidecars like scripts/lora_effect_probe.py,
// which needs to run wherever the user happens to have set up a runtime (a bare
// system python3 usually has no numpy at all).
//
// Kept HERE rather than in the consuming service for exactly the reason spelled
// out above HF_HUB_PYTHON_RESOLVERS: a list assembled inside a consumer is a
// list every new engine forgets. ADDING A RUNTIME: if its setup-image-video.sh
// block installs numpy (torch, mlx and diffusers all pull it in, so this is
// nearly every runtime), add its resolver here.
//
// The LTX-2.x video venvs are deliberately NOT here — their paths are owned by
// services/videoGen/runtimes.js, and lib/ must not import from services/. The
// probe prepends them itself; this list is everything pythonSetup can see.
// NOTE the mflux entries resolve venv PATHS directly rather than going through
// `resolveMfluxPython`: that resolver answers "which interpreter can run
// mflux-train", so it returns null on an mflux install without the trainer
// package — an interpreter that has numpy and would have measured fine. Both
// candidates are listed, not just the default, because an install provisioned
// under data/python/ is exactly as capable as one under ~/.portos/.
export const NUMPY_PYTHON_RESOLVERS = Object.freeze([
  resolveFlux2Python,
  ...MFLUX_VENV_CANDIDATES.map((path) => () => path),
  ...HF_HUB_PYTHON_RESOLVERS,
]);

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
  const ok = await execFileAsync(py, ['-c', 'from muscriptor import TranscriptionModel'], safeChildProcessOptions({ timeout: 30_000 }))
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

// A UNC share (`\\host\share\…` or its POSIX-typed twin `//host/share/…`)
// names a binary that lives on a REMOTE machine — launching it hands
// execution to whoever controls that share. Checked ahead of the basename
// test below so `\\attacker\share\python.exe` never gets to the point where
// its basename ("python.exe") would otherwise pass.
const isUncPath = (p) => /^\\\\/.test(p) || /^\/\//.test(p);

// A path with directory separators that isn't absolute (`./venv/bin/python3`,
// `subdir/python3`, a bare relative walk) resolves against whatever the
// server process's cwd happens to be when the route runs — attacker-
// influenced in ways an absolute path or a bare basename (resolved on PATH
// by execFile itself) is not. A bare basename has no separator and is exempt.
const isAbsolutePath = (p) => /^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\(?!\\)/.test(p);

export function isAllowedPython(pythonPath) {
  if (typeof pythonPath !== 'string' || !pythonPath) return false;
  if (isUncPath(pythonPath)) return false;
  if (/[\\/]/.test(pythonPath) && !isAbsolutePath(pythonPath)) return false;
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
// `clear: true` passes `--clear` to rebuild over a directory a prior failed
// attempt left in a partial/broken state, e.g. when retrying venv creation
// against a different base after the first base silently failed to
// materialize the interpreter.
export async function createVenv(basePython, targetDir, { clear = false } = {}) {
  const venvPython = IS_WIN
    ? join(targetDir, 'Scripts', 'python.exe')
    : join(targetDir, 'bin', 'python3');
  if (!clear && existsSync(venvPython)) return venvPython;
  const args = ['-m', 'venv', ...(clear ? ['--clear'] : []), targetDir];
  await execFileAsync(basePython, args, safeChildProcessOptions({ timeout: 120_000 }));
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
    '  "pythonVersion": platform.python_version(),',
    '  "imports": imports,',
    '}))',
  ].join('\n');
  const { stdout } = await execFileAsync(pythonPath, ['-c', probe], safeChildProcessOptions({ timeout: 30_000 }));
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
    pythonVersion: data.pythonVersion || null,
  };
}

export async function checkPackages(pythonPath) {
  const { installed, missing, missingPip, pythonVersion } = await probePythonHealth(pythonPath);
  return { installed, missing, missingPip, pythonVersion };
}

// Spawn a child, stream its stdout+stderr line-by-line via `onLog`, resolve
// with the exit code (or -1 on spawn error). `onProc` is invoked with the
// live child handle so the caller's outer closure can track it for SIGTERM.
function streamSpawn(bin, args, onLog, onProc) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
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

async function pythonIsVenv(pythonPath) {
  const { stdout } = await execFileAsync(pythonPath, ['-c', 'import sys; print(sys.prefix != sys.base_prefix)'],
    safeChildProcessOptions({ timeout: 10_000 })).catch(() => ({ stdout: '' }));
  return stdout.trim() === 'True';
}

// PortOS-private patched uv (never ambient PATH uv, whose version PortOS cannot
// vouch for): `{ ok: true, uv }` or `{ ok: false, reason }`. Prefers an arm64
// interpreter on Apple Silicon so the bootstrapped uv is a native binary even
// when Node runs under Rosetta.
export async function resolvePatchedUv(onLog) {
  const basePython = (await detectArm64Python()) || detectVenvBasePythonSync();
  return ensurePrivateUv({ basePython, onLog });
}

// `preferUv` installs fall back to pip when the private uv cannot be had; every
// install here is `--require-hashes --no-deps`, so the installer choice does not
// change what lands.
async function resolveUvOrPip(onLog) {
  const result = await resolvePatchedUv(onLog);
  if (result.ok) return result.uv;
  onLog({ type: 'log', message: `${result.reason} Using pip instead.` });
  return null;
}

// Shared lifecycle for the lock installers: `work({ runPip, tool, isKilled })`
// returns the final `{ ok, code }`. Returns `{ promise, kill }` so the route can
// SIGTERM the pip child if the SSE client disconnects mid-install — a 10-minute
// torch install would otherwise keep running invisibly.
function launchInstall(pythonPath, onLog, { preferUv }, work) {
  let currentProc = null;
  let killed = false;
  const trackProc = (p) => { currentProc = p; };
  const promise = (async () => {
    const uv = preferUv ? await resolveUvOrPip(onLog) : null;
    const runPip = (args) => {
      if (!uv) return streamSpawn(pythonPath, ['-m', 'pip', ...args], onLog, trackProc);
      // uv does not accept pip's progress-bar/yes options. Keep the same
      // exact target interpreter and package specifications in both paths.
      const uvArgs = args.filter((arg, index) => arg !== '--yes' && arg !== '--progress-bar' && args[index - 1] !== '--progress-bar');
      return streamSpawn(uv, ['pip', uvArgs[0], '--python', pythonPath, ...uvArgs.slice(1)], onLog, trackProc);
    };
    return work({ runPip, tool: uv ? 'uv pip' : 'pip', usingUv: !!uv, isKilled: () => killed });
  })();
  return {
    promise,
    kill: () => {
      killed = true;
      if (currentProc && !currentProc.killed) currentProc.kill('SIGTERM');
    },
  };
}

// Refuse before any subprocess runs: a profile or package request no lock
// covers is reported, never solved. Same `{ promise, kill }` shape as an install.
function refuseInstall(onLog, message, extra) {
  onLog({ type: 'error', message });
  return { promise: Promise.resolve({ ok: false, code: -1, ...extra }), kill: () => {} };
}

const lockInstallArgs = (lockFile, { user }) => ['install', ...(user ? ['--user'] : []), '--require-hashes', '--no-deps', '-r', lockFile];

async function runLockInstall({ runPip, tool, isKilled }, profile, onLog, { user }) {
  const args = lockInstallArgs(profile.lockFile, { user });
  onLog({ type: 'log', message: `${tool} ${args.join(' ')} (hash-pinned ${profile.label} lock)` });
  const code = await runPip(args);
  if (isKilled()) return { ok: false, code: -1 };
  if (code === 0) {
    onLog({ type: 'complete', message: 'All packages installed successfully.' });
    return { ok: true, code: 0 };
  }
  onLog({ type: 'error', message: `${tool} exited with code ${code}` });
  return { ok: false, code };
}

// Install a profile's complete hash-pinned closure into a dedicated venv (the
// Prompt Guard / jev runtimes). No resolution happens at install time.
export function installLockedRuntime(pythonPath, profileId, onLog, { preferUv = false, platform: hostPlatform = platform(), arch: hostArch = arch() } = {}) {
  const profile = LOCK_PROFILES[profileId];
  if (!profile) return refuseInstall(onLog, `Unknown Python lock profile "${profileId}".`, { unsupported: true });
  const reason = lockProfileUnsupportedReason(profile, { platform: hostPlatform, arch: hostArch });
  if (reason) return refuseInstall(onLog, `${reason} PortOS does not resolve unlocked packages at install time.`, { unsupported: true });
  return launchInstall(pythonPath, onLog, { preferUv }, (ctx) => runLockInstall(ctx, profile, onLog, { user: false }));
}

// Generic setup-page repair. On Apple Silicon it dispatches to the smallest
// hash-pinned lock owning every requested package; anything else is reported as
// an unresolved profile instead of resolving a fresh dependency graph.
export function installPackages(pythonPath, importNames, onLog, { preferUv = false, appleSilicon = hostIsAppleSilicon() } = {}) {
  const plan = planLockedRepair(importNames.map(pipNameFor), { appleSilicon });
  if (!plan.profile) {
    const detail = plan.unresolved.map(({ name, reason }) => `${name} (${reason})`).join(', ');
    return refuseInstall(onLog,
      `Unsupported repair profile: ${detail}. PortOS installs only hash-pinned runtime locks and does not resolve unpinned packages; use a supported runtime installer (scripts/setup-image-video.sh).`,
      { unresolved: plan.unresolved });
  }
  const conflicts = plan.profile.id === 'mflux-video' ? MFLUX_VIDEO_PRE_UNINSTALL : [];
  return launchInstall(pythonPath, onLog, { preferUv }, async (ctx) => {
    if (conflicts.length) {
      onLog({ type: 'log', message: `${ctx.tool} uninstall -y ${conflicts.join(' ')} (resolving package-name conflict)` });
      // Uninstall isn't allowed to fail the run — when the conflicting
      // package isn't installed pip exits non-zero with a "not installed"
      // message that's noise, not an error.
      await ctx.runPip(['uninstall', '--yes', ...conflicts]);
      if (ctx.isKilled()) return { ok: false, code: -1 };
    }
    // --user matches the setup script's shared layout; a venv or uv target rejects it.
    const user = !ctx.usingUv && !await pythonIsVenv(pythonPath);
    return runLockInstall(ctx, plan.profile, onLog, { user });
  });
}

// FLUX.2 installs run the hash-pinned lock (Apple Silicon MLX or CUDA) through
// scripts/setup-image-video.sh (INSTALL_FLUX2=1) instead of resolving torch,
// diffusers and sdnq at install time. The script owns the uv-provisioned
// Python 3.11 venv, the lock sync and the pipeline import probe, so this only
// streams its output and reports the exit. setupScriptRunner imports this
// module, hence the lazy import.
function installFlux2FromLock(onLog) {
  let child = null;
  let killed = false;
  let stopSetupScript = () => {};

  const promise = (async () => {
    const runner = await import('./setupScriptRunner.js');
    stopSetupScript = runner.stopSetupScript;
    if (killed) return { ok: false, stage: 'install', cancelled: true };
    onLog({ type: 'stage', stage: 'install', message: 'Syncing the hash-pinned FLUX.2 runtime (~6-10 min — large download)…' });
    const code = await new Promise((resolve) => {
      child = runner.spawnSetupScript({ INSTALL_FLUX2: '1' });
      const onLine = (line) => {
        const t = line.trim();
        if (t) onLog({ type: 'log', message: t });
      };
      const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
      const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
      child.stdout.on('data', stdoutReader.push);
      child.stderr.on('data', stderrReader.push);
      child.on('error', (err) => { onLog({ type: 'error', message: err.message }); resolve(-1); });
      child.on('close', (exitCode) => { stdoutReader.flush(); stderrReader.flush(); resolve(exitCode ?? -1); });
    });
    child = null;
    if (killed) return { ok: false, stage: 'install', cancelled: true };
    if (code !== 0) {
      onLog({ type: 'error', message: `The FLUX.2 installer exited with code ${code}. See the install log above for the failing step.` });
      return { ok: false, stage: 'install' };
    }
    invalidateFlux2Health();
    const pythonPath = resolveFlux2Python();
    onLog({ type: 'stage', stage: 'verify', message: 'FLUX.2 and Qwen 2.1 pipeline imports verified by the installer.' });
    onLog({ type: 'complete', message: `FLUX.2 venv ready: ${pythonPath}` });
    return { ok: true, pythonPath };
  })();

  return {
    promise,
    kill: () => {
      killed = true;
      stopSetupScript(child);
    },
  };
}

// Bootstrap the FLUX.2 venv from inside the app. One path on every platform:
// the hash-pinned lock (Apple Silicon MLX or CUDA) via the setup script.
// Returns `{ promise, kill }` so the route can stop the script if the
// EventSource closes mid-install.
export const installFlux2Venv = installFlux2FromLock;
