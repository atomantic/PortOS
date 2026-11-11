// A PortOS-owned uv for Python installers. Ambient `uv` on PATH is whatever the
// user happened to install: it may predate the compromised-CA removal and the
// wheel entry-point/RECORD/ZIP/TAR extraction fixes (uv 0.13.4), and upgrading
// a user-wide executable is not ours to do. So PortOS tools run a private copy,
// bootstrapped once into ~/.portos/tools/uv-<version> exactly like the
// bundled bootstraps in scripts/setup-image-video.sh (same directory, so the
// two share one install), from the hash-pinned scripts/requirements-uv-bootstrap.lock.txt.
import { execFile } from './childProcess.js';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCK_PROFILES } from './pythonLockProfiles.js';
import { safeChildProcessOptions } from './processEnv.js';

const execFileAsync = promisify(execFile);

export const PRIVATE_UV_VERSION = '0.13.7';
// First release with the CA and wheel-extraction fixes. Lock headers document
// the same floor for regeneration.
export const MIN_PATCHED_UV = Object.freeze([0, 13, 4]);

export const privateUvDir = () => join(homedir(), '.portos', 'tools', `uv-${PRIVATE_UV_VERSION}`);
export const privateUvPath = () =>
  join(privateUvDir(), platform() === 'win32' ? join('Scripts', 'uv.exe') : join('bin', 'uv'));
const venvPythonPath = () =>
  join(privateUvDir(), platform() === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python3'));

// `uv 0.13.7 (316c827e0 2026-11-03 aarch64-apple-darwin)` -> [0, 13, 7]; null for anything else.
function parseUvVersion(banner) {
  const match = /^uv (\d+)\.(\d+)\.(\d+)/.exec(String(banner || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function isPatchedUvVersion(banner) {
  const parsed = parseUvVersion(banner);
  if (!parsed) return false;
  for (let i = 0; i < MIN_PATCHED_UV.length; i++) {
    if (parsed[i] !== MIN_PATCHED_UV[i]) return parsed[i] > MIN_PATCHED_UV[i];
  }
  return true;
}

const run = (bin, args, timeout) => execFileAsync(bin, args, safeChildProcessOptions({ timeout, maxBuffer: 1024 * 1024 }));

async function privateUvIsCurrent() {
  if (!existsSync(privateUvPath())) return false;
  const { stdout } = await run(privateUvPath(), ['--version'], 10_000).catch(() => ({ stdout: '' }));
  return stdout.trim().startsWith(`uv ${PRIVATE_UV_VERSION}`) && isPatchedUvVersion(stdout);
}

let inFlight = null;

// Resolve `{ ok: true, uv }` for a patched private uv, bootstrapping it from
// `basePython` (a Python with the venv module and pip, 3.8+) when absent or the
// wrong version. Never falls back to PATH: `{ ok: false, reason }` lets the
// caller choose its own refusal or pip fallback. Concurrent callers share one
// bootstrap so two installs cannot clear the venv under each other. The reason
// is a fixed string: pip stderr can carry index URLs or local paths and is
// discarded.
export function ensurePrivateUv({ basePython, onLog = () => {} } = {}) {
  inFlight ??= (async () => {
    if (await privateUvIsCurrent()) return { ok: true, uv: privateUvPath() };
    if (!basePython) return { ok: false, reason: `No Python found to bootstrap uv ${PRIVATE_UV_VERSION}. Install Python 3.11+ and retry.` };
    onLog({ type: 'log', message: `Bootstrapping PortOS-private uv ${PRIVATE_UV_VERSION}...` });
    let step = 'virtualenv creation';
    try {
      await run(basePython, ['-m', 'venv', '--clear', privateUvDir()], 120_000);
      step = 'hash-verified package install';
      // The bootstrap installer is itself hash-verified: every uv wheel/sdist digest
      // is pinned in the lock, so a substituted package fails before it can run.
      await run(venvPythonPath(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '--no-deps', '--only-binary', ':all:',
        '-r', LOCK_PROFILES['uv-bootstrap'].lockFile], 300_000);
    } catch {
      return { ok: false, reason: `Could not bootstrap uv ${PRIVATE_UV_VERSION}: the ${step} step failed.` };
    }
    if (!await privateUvIsCurrent()) return { ok: false, reason: `Bootstrapped uv did not report version ${PRIVATE_UV_VERSION}.` };
    return { ok: true, uv: privateUvPath() };
  })().finally(() => { inFlight = null; });
  return inFlight;
}
