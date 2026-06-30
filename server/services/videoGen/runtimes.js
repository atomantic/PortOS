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

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, cpus, type as osType, release as osRelease } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';

// Path to the dgrauet/ltx-2-mlx venv populated by `INSTALL_LTX2=1
// scripts/setup-image-video.sh`. Used when a model entry has
// `runtime: 'ltx2'`. The companion helper at scripts/generate_ltx2.py
// imports `ltx_pipelines_mlx` from this venv and emits the same SSE
// progress protocol (STAGE:/STATUS:/DOWNLOAD:) as the mlx_video CLI.
export const LTX2_VENV_PYTHON = join(homedir(), '.portos', 'ltx-2-mlx', '.venv', 'bin', 'python3');
export const LTX2_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_ltx2.py');

// Wan 2.2 MLX runtime — osama-ata/Wan2.2-mlx cloned at
// ~/.portos/wan2.2-mlx/. The wrapper at scripts/generate_wan22.py
// subprocesses upstream generate.py so PortOS releases don't drift from
// upstream's CLI. Provisioned via `INSTALL_WAN22=1 bash scripts/setup-image-video.sh`.
export const WAN22_VENV_PYTHON = join(homedir(), '.portos', 'wan2.2-mlx', '.venv', 'bin', 'python3');
export const WAN22_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'generate_wan22.py');
export const WAN22_REPO_DIR = join(homedir(), '.portos', 'wan2.2-mlx');

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
    repoUrl: 'https://github.com/osama-ata/Wan2.2-mlx',
    // Walks the package's __init__ chain so transitive deps absent from
    // upstream's pyproject.toml (e.g. einops, imported by wan/modules/vae2_1.py)
    // fail the probe instead of slipping past a flat torch/transformers check.
    importProbe: 'import wan',
    // Mirror scripts/generate_wan22.py's emit_runtime_fingerprint package list.
    fingerprintPackages: ['wan', 'mlx', 'mlx_metal', 'torch'],
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
      env: safeChildProcessEnv(),
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
        { env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'ignore'] },
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
