import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from './fileUtils.js';

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === 'win32';
const IS_DARWIN = platform() === 'darwin';

export const REQUIRED_PACKAGES = IS_DARWIN
  ? ['mflux', 'mlx', 'mlx_vlm', 'mlx_video', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm']
  : IS_WIN
    ? ['transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm', 'torch', 'diffusers']
    : ['mflux', 'transformers', 'safetensors', 'huggingface_hub', 'numpy', 'cv2', 'tqdm'];

const PIP_NAMES = {
  cv2: 'opencv-python',
  // mlx-compatible transformers must stay <5 — pin only on macOS where the
  // mlx path matters; Windows torch path uses latest.
  ...(IS_DARWIN ? { transformers: 'transformers<5' } : {}),
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

export async function detectPython() {
  for (const p of PYTHON_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  const which = IS_WIN ? 'where' : 'which';
  const name = IS_WIN ? 'python' : 'python3';
  const { stdout } = await execFileAsync(which, [name], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  return stdout.trim().split(/\r?\n/)[0] || null;
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

// Returns true if `pythonPath` has a PEP 668 EXTERNALLY-MANAGED marker next
// to its stdlib — pip will refuse to install into it.
export async function isExternallyManaged(pythonPath) {
  const { stdout } = await execFileAsync(pythonPath, [
    '-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'
  ], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
  const stdlib = stdout.trim();
  if (!stdlib) return false;
  return existsSync(join(stdlib, 'EXTERNALLY-MANAGED'));
}

// Idempotent: if the venv exists, returns its python path without recreating.
// Windows venvs put the interpreter at Scripts\python.exe, POSIX at bin/python3.
export async function createVenv(basePython, targetDir) {
  const venvPython = IS_WIN
    ? join(targetDir, 'Scripts', 'python.exe')
    : join(targetDir, 'bin', 'python3');
  if (existsSync(venvPython)) return venvPython;
  await execFileAsync(basePython, ['-m', 'venv', targetDir], { timeout: 120_000 });
  if (!existsSync(venvPython)) {
    throw new Error(`Venv created but interpreter missing at ${venvPython}`);
  }
  return venvPython;
}

export async function checkPackages(pythonPath) {
  const probe = REQUIRED_PACKAGES.map(pkg =>
    `try:\n import ${pkg}\n print("OK:${pkg}")\nexcept Exception:\n print("MISSING:${pkg}")`
  ).join('\n');

  const { stdout } = await execFileAsync(pythonPath, ['-c', probe], { timeout: 30_000 });

  const installed = [];
  const missing = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (line.startsWith('OK:')) installed.push(line.slice(3).trim());
    else if (line.startsWith('MISSING:')) missing.push(line.slice(8).trim());
  }
  return { installed, missing, missingPip: missing.map(pipNameFor) };
}

// Spawn pip install; emit each line via onLog. Resolves on exit.
// onLog gets `{ type: 'log' | 'error' | 'complete', message }`.
// Returns `{ promise, kill }` so the route can SIGTERM the pip child if
// the SSE client disconnects mid-install (otherwise a 10-minute torch
// upgrade would keep running invisibly).
export function installPackages(pythonPath, importNames, onLog) {
  const pipSpecs = importNames.map(pipNameFor);
  onLog({ type: 'log', message: `pip install ${pipSpecs.join(' ')}` });

  const proc = spawn(pythonPath, [
    '-m', 'pip', 'install', '--upgrade', '--progress-bar', 'on',
    ...pipSpecs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const promise = new Promise((resolve) => {
    const handleOutput = (chunk) => {
      for (const line of chunk.toString().split(/[\r\n]+/)) {
        const trimmed = line.trim();
        if (trimmed) onLog({ type: 'log', message: trimmed });
      }
    };
    proc.stdout.on('data', handleOutput);
    proc.stderr.on('data', handleOutput);

    proc.on('close', (code) => {
      if (code === 0) {
        onLog({ type: 'complete', message: 'All packages installed successfully.' });
        resolve({ ok: true, code: 0 });
      } else {
        onLog({ type: 'error', message: `pip exited with code ${code}` });
        resolve({ ok: false, code });
      }
    });
    proc.on('error', (err) => {
      onLog({ type: 'error', message: err.message });
      resolve({ ok: false, code: -1 });
    });
  });

  return { promise, kill: () => { if (!proc.killed) proc.kill('SIGTERM'); } };
}
