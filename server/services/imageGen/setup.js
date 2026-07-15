/**
 * Image Gen — local-mode setup orchestration.
 *
 * The non-HTTP logic behind the `/api/image-gen/setup/*` routes: the
 * python-interpreter health-check cache and the pip-install allowlist. The
 * route module (`routes/imageGenSetup.js`) validates input and wires SSE/HTTP;
 * this module owns the caching + allowlist so those concerns live in the
 * service layer rather than inline in the route.
 */

import { stat } from 'fs/promises';
import {
  REQUIRED_PACKAGES, detectArm64Python, HOST_ARCH, probePythonHealth, pipNameFor,
} from '../../lib/pythonSetup.js';

// /setup/check is called on every keystroke in the python-path input (debounced
// to 400ms), on mount, AND on the refresh button — each call spawns a python
// subprocess (~0.5-1s warm) plus the optional `detectArm64Python` walk. A
// modest in-memory cache, keyed by (pythonPath, stat.mtimeMs) and bounded by
// SETUP_CHECK_TTL_MS, collapses the typing-flow repeats to memo hits without
// risking stale data — the key changes the moment the interpreter is swapped
// (venv create, brew upgrade) and the install path explicitly busts on
// completion.
const SETUP_CHECK_TTL_MS = 30_000;
const setupCheckCache = new Map();

async function buildSetupCheck(pythonPath) {
  const health = await probePythonHealth(pythonPath);
  // The arch warning is specifically about mlx wheels (arm64-only) on Apple
  // Silicon. A generic interpreterArch !== HOST_ARCH compare would false-
  // positive on Windows (Python reports `AMD64`, Node reports `x86_64`) and
  // on hypothetical arm64 Linux — where mlx isn't even in REQUIRED_PACKAGES.
  const archMismatch = process.platform === 'darwin'
    && HOST_ARCH === 'arm64'
    && health.interpreterArch === 'x86_64';
  const suggestedArm64Python = archMismatch ? await detectArm64Python() : null;
  return {
    pythonPath,
    required: REQUIRED_PACKAGES,
    hostArch: HOST_ARCH,
    archMismatch,
    suggestedArm64Python,
    ...health,
  };
}

/** Drop cached setup-check results for a python path (or all when omitted). */
export function invalidateSetupCheck(pythonPath) {
  if (!pythonPath) {
    setupCheckCache.clear();
    return;
  }
  const prefix = `${pythonPath}|`;
  for (const key of setupCheckCache.keys()) {
    if (key.startsWith(prefix)) setupCheckCache.delete(key);
  }
}

/**
 * Resolve the setup-check payload for a python interpreter, memoized by
 * (path, mtime) for SETUP_CHECK_TTL_MS. Callers must have already validated
 * that `pythonPath` is an allowed interpreter.
 */
export async function getSetupCheck(pythonPath) {
  // mtime keys auto-bust when the interpreter binary itself changes (rare but
  // surfaces brew upgrades / re-symlinks). A stat() failure (path not found)
  // skips the cache rather than poisoning it with a `mtime=missing` entry.
  const mtimeMs = await stat(pythonPath).then((s) => s.mtimeMs).catch(() => null);
  const key = mtimeMs !== null ? `${pythonPath}|${mtimeMs}` : null;
  if (key) {
    const hit = setupCheckCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.result;
  }
  const result = await buildSetupCheck(pythonPath);
  if (key) {
    // Sweep expired entries on every write so a long-running process doesn't
    // accumulate stale (path, mtime) combos from intermediate keystrokes
    // (each typed character of a path string lands a unique key here).
    const now = Date.now();
    for (const [k, v] of setupCheckCache) {
      if (v.expiresAt <= now) setupCheckCache.delete(k);
    }
    setupCheckCache.set(key, { result, expiresAt: now + SETUP_CHECK_TTL_MS });
  }
  return result;
}

// Allowlist: only PortOS's own required pip names (or their pinned variants
// like `transformers<5`) are installable. Without this, the endpoint would
// happily pip-install arbitrary PyPI packages — the install runs as the
// PortOS user and pip itself executes setup.py from the package, so an
// arbitrary package install is effectively arbitrary code execution.
// Build the pip-spec allowlist from REQUIRED_PACKAGES via pipNameFor — that
// translates import names (`cv2`) to their actual pip specs
// (`opencv-python`). Without this mapping, the allowlist would contain
// import-only names that can't actually be installed but ALSO don't appear
// here as their pip specs, so the legitimate install request would 400.
// Worse: an import name like `cv2` isn't a real PyPI package but if a
// typosquat existed under that name it'd be installable.
export const REQUIRED_PIP_NAMES = new Set([
  ...REQUIRED_PACKAGES.map(pipNameFor),
  // Windows torch path also installs torch + diffusers, which are in
  // REQUIRED_PACKAGES on Windows but not on macOS — keep them allowlisted
  // unconditionally so a Windows install requested from a macOS server
  // (unlikely but possible) doesn't 400 unhelpfully.
  'torch',
  'diffusers',
  // Both the bare `transformers` and the macOS-pinned `transformers<5`
  // variant should be installable; pipNameFor only emits the pinned
  // variant on macOS, so list both unconditionally for safety.
  'transformers',
  'transformers<5',
]);
