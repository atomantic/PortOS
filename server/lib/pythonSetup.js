import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from './fileUtils.js';
import { safeChildProcessEnv } from './processEnv.js';

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
      join(HOME, 'miniconda3', 'python.exe'),
      join(HOME, 'anaconda3', 'python.exe'),
      'C:\\miniconda3\\python.exe',
      'C:\\anaconda3\\python.exe',
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
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
  const which = IS_WIN ? 'where' : 'which';
  const name = IS_WIN ? 'python' : 'python3';
  const { stdout } = await execFileAsync(which, [name], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  return stdout.trim().split(/\r?\n/)[0] || null;
}

export async function detectArm64Python() {
  if (!IS_DARWIN || HOST_ARCH !== 'arm64') return null;
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
    const onChunk = (chunk) => {
      for (const line of chunk.toString().split(/[\r\n]+/)) {
        const t = line.trim();
        if (t) onLog({ type: 'log', message: t });
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    proc.on('close', (code) => { onProc(null); resolve(code ?? -1); });
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

// Pip specs for the FLUX.2 venv. Mirrors scripts/setup-image-video.sh so the
// shell path and the in-app installer stay in sync. diffusers + sdnq are
// git-only because Flux2KleinPipeline isn't in any tagged release yet.
export const FLUX2_PIP_SPECS = [
  'torch>=2.5',
  'torchvision',
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
    if (!await runPython([venvPython, '-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on', ...FLUX2_PIP_SPECS])) {
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
