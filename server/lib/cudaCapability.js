/**
 * NVIDIA CUDA host-capability probe.
 *
 * The single place PortOS asks "does this machine have a usable NVIDIA GPU, and
 * how much VRAM does its biggest card have?" (gates the image-to-3D `local-cuda` lane and
 * the FLUX.2 installer's torch wheel choice).
 *
 * **Three outcomes, never two.** "The probe could not run" is NOT "there is no GPU", so the
 * result carries a `status` (deliberately not a boolean):
 *   - `'available'` — nvidia-smi listed at least one GPU.
 *   - `'absent'`    — no NVIDIA driver (`nvidia-smi` isn't on PATH), or it ran fine
 *                     and listed zero GPUs. A real, negative answer.
 *   - `'unknown'`   — nvidia-smi exists but failed or emitted something unparseable
 *                     (driver mismatch pending a reboot, a timeout, an ancient driver
 *                     without `--query-gpu`). Callers must say "couldn't detect"
 *                     rather than lying about the hardware.
 *
 * The probe is a subprocess boundary outside the request lifecycle, so every path
 * resolves — nothing throws into a route (AGENTS.md child-process exception).
 */

import { execFile } from './childProcess.js';

/**
 * Spawn `nvidia-smi` with `queryArgs` and triage the outcome (`ENOENT` ⇒ real negative,
 * anything else ⇒ `'unknown'`) without interpreting rows. Module-private shared shell for the
 * probes below.
 *
 * `status` is null when the command SUCCEEDED and the caller should parse `stdout`.
 * `error` is null on `ENOENT` (absent hardware is an answer, not a failure); `rawError`
 * always carries the underlying message for the probe that reports it.
 *
 * @param {string[]} queryArgs
 * @param {{execFileImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: 'absent'|'unknown'|null, stdout: string,
 *                    error: string|null, rawError: string|null}>}
 */
async function queryNvidiaSmi(queryArgs, { execFileImpl = execFile, timeoutMs } = {}) {
  const result = await new Promise((resolve) => {
    execFileImpl('nvidia-smi', [...queryArgs], { timeout: timeoutMs },
      (err, stdout) => resolve({ err, stdout: String(stdout ?? '') }));
  }).catch((err) => ({ err, stdout: '' }));
  if (!result.err) return { status: null, stdout: result.stdout, error: null, rawError: null };
  const rawError = result.err.message || null;
  // The binary ships with the driver, so ENOENT is a real negative, not a failed probe.
  if (result.err.code === 'ENOENT') return { status: 'absent', stdout: '', error: null, rawError };
  // Present but wouldn't answer (driver mismatch, timeout, driver too old for a column).
  return { status: 'unknown', stdout: '', error: rawError || 'nvidia-smi failed', rawError };
}

/**
 * MiB → whole GB, or null when the column didn't parse.
 *
 * Rounded rather than floored because a "24 GB" card reports a hair under 24 GiB and
 * must not trip a 24 GB floor. Shared by both row parsers so the lanes' different VRAM
 * floors (12 and 24 GB) move together.
 *
 * @param {string|number} mib
 * @returns {number|null}
 */
function vramGbFromMib(mib) {
  const vramMib = Number(mib);
  return Number.isFinite(vramMib) && vramMib > 0 ? Math.round(vramMib / 1024) : null;
}

/**
 * One CSV row per GPU: `<name>, <total VRAM in MiB>`. `nounits` strips the " MiB"
 * suffix so the column parses as a bare number (e.g. `NVIDIA GeForce RTX 3090, 24576`).
 */
export const NVIDIA_SMI_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,memory.total',
  '--format=csv,noheader,nounits',
]);

export const NVIDIA_SMI_UTILIZATION_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits',
]);

export function parseNvidiaSmiUtilization(stdout) {
  return String(stdout ?? '').split(/\r?\n/).flatMap((raw) => {
    const [name, utilization, memoryUsed, memoryTotal] = raw.trim().split(',').map((cell) => cell.trim());
    if (!name) return [];
    const numeric = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    return [{
      name,
      utilizationPercent: numeric(utilization),
      memoryUsedMib: numeric(memoryUsed),
      memoryTotalMib: numeric(memoryTotal),
    }];
  });
}

export async function detectCudaUtilization({ execFileImpl = execFile, timeoutMs = 2000 } = {}) {
  const probe = await queryNvidiaSmi(NVIDIA_SMI_UTILIZATION_QUERY_ARGS, { execFileImpl, timeoutMs });
  // Unlike the other probes, this one reports the raw error message even on ENOENT.
  if (probe.status) return { status: probe.status, gpus: [], error: probe.rawError };
  const gpus = parseNvidiaSmiUtilization(probe.stdout);
  return { status: gpus.length ? 'available' : 'absent', gpus, error: null };
}

/**
 * One CSV row per GPU: `<name>, <compute capability>, <total VRAM in MiB>` — e.g.
 * `NVIDIA GeForce RTX 3090, 8.6, 24576`.
 *
 * **Deliberately a SECOND query rather than extra columns on `NVIDIA_SMI_QUERY_ARGS`.**
 * An older driver rejects `compute_cap` and fails the WHOLE query, which would turn every
 * such host into a global `'unknown'` and take the `local-cuda` lane down. It is only needed
 * at Pixal3D install time (NATTEN arch), so its failure stays contained to that installer.
 */
export const NVIDIA_SMI_COMPUTE_CAP_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,compute_cap,memory.total',
  '--format=csv,noheader,nounits',
]);

/**
 * Parse the compute-capability query into GPU descriptors. Pure.
 *
 * A row whose `compute_cap` doesn't parse carries `computeCap: null` rather than being
 * dropped — an unclassifiable card is still a card, and callers gate on the null.
 *
 * @param {string} stdout
 * @returns {Array<{name: string, computeCap: string|null, vramGb: number|null}>}
 */
export function parseNvidiaSmiComputeCaps(stdout) {
  const gpus = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name, cap, mib] = line.split(',').map((cell) => cell.trim());
    if (!name) continue;
    // Bare major.minor only; anything else must never reach a compiler flag.
    const computeCap = /^\d+\.\d+$/.test(cap || '') ? cap : null;
    gpus.push({ name, computeCap, vramGb: vramGbFromMib(mib) });
  }
  return gpus;
}

/**
 * Probe the CUDA compute capability of this host's GPUs. Always resolves, with the
 * same three-state `status` contract as `detectCudaGpus`.
 *
 * `primaryComputeCap` is the arch of the LARGEST card (the one the lane renders on), not
 * the highest arch; ties resolve to the first row. `null` means "could not determine" —
 * fall back to a compiler default, never guess an arch.
 *
 * @param {{execFileImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: 'available'|'absent'|'unknown', gpus: Array<object>,
 *                    primaryComputeCap: string|null, error: string|null}>}
 */
export async function detectCudaComputeCapability({ execFileImpl = execFile, timeoutMs = 8000 } = {}) {
  const probe = await queryNvidiaSmi(NVIDIA_SMI_COMPUTE_CAP_QUERY_ARGS, { execFileImpl, timeoutMs });
  if (probe.status) {
    return { status: probe.status, gpus: [], primaryComputeCap: null, error: probe.error };
  }

  const gpus = parseNvidiaSmiComputeCaps(probe.stdout);
  if (!gpus.length) return { status: 'absent', gpus: [], primaryComputeCap: null, error: null };
  // Largest card first (unsized cards sort last), then take its arch.
  const ranked = [...gpus].sort((a, b) => (b.vramGb ?? -1) - (a.vramGb ?? -1));
  return {
    status: 'available',
    gpus,
    primaryComputeCap: ranked.find((g) => g.computeCap)?.computeCap ?? null,
    error: null,
  };
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total` CSV output into GPU descriptors.
 * Pure.
 *
 * A row whose VRAM column doesn't parse (vGPU/MIG may report `[N/A]`) still counts as a
 * GPU with `vramGb: null`: dropping it would report no GPU, and `0` would look like a card
 * failing every floor. Callers gate on `Number.isFinite`.
 *
 * @param {string} stdout
 * @returns {Array<{name: string, vramMib: number|null, vramGb: number|null}>}
 */
export function parseNvidiaSmiGpus(stdout) {
  const gpus = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Card names never contain a comma; extra columns are ignored.
    const [name, mib] = line.split(',').map((cell) => cell.trim());
    if (!name) continue;
    const vramGb = vramGbFromMib(mib);
    gpus.push({
      name,
      vramMib: vramGb === null ? null : Number(mib),
      vramGb,
    });
  }
  return gpus;
}

/**
 * Probe this machine for NVIDIA GPUs. Always resolves — see the three outcomes in
 * the file header. `execFileImpl` is injectable so tests need no NVIDIA box.
 *
 * @param {{execFileImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: 'available'|'absent'|'unknown',
 *                    gpus: Array<object>, maxVramGb: number|null, error: string|null}>}
 */
export async function detectCudaGpus({ execFileImpl = execFile, timeoutMs = 8000 } = {}) {
  const probe = await queryNvidiaSmi(NVIDIA_SMI_QUERY_ARGS, { execFileImpl, timeoutMs });
  if (probe.status) {
    return { status: probe.status, gpus: [], maxVramGb: null, error: probe.error };
  }

  const gpus = parseNvidiaSmiGpus(probe.stdout);
  if (!gpus.length) {
    // Exit 0 with no rows: the driver is installed and reports zero GPUs.
    return { status: 'absent', gpus: [], maxVramGb: null, error: null };
  }
  const sizes = gpus.map((g) => g.vramGb).filter((gb) => Number.isFinite(gb));
  return {
    status: 'available',
    gpus,
    // Biggest single card: a render runs on one GPU, so summing would overstate capacity.
    maxVramGb: sizes.length ? Math.max(...sizes) : null,
    error: null,
  };
}

// `null` = never probed (distinct from "no GPU"). Holds the in-flight promise so
// concurrent callers share one subprocess.
let cachedProbe = null;
// Epoch ms at which the memo goes stale: `Infinity` for a definitive answer, a short
// horizon for `unknown`.
let cacheExpiresAt = Infinity;

/**
 * How long an `unknown` verdict is held before retrying: short enough to notice a recovered
 * driver, long enough that a wedged one (where `nvidia-smi` hangs to its timeout) costs one
 * stalled spawn a minute instead of one per `/targets` load or generate call.
 */
export const CUDA_UNKNOWN_RETRY_MS = 60_000;

/**
 * Cached `detectCudaGpus()`: hardware doesn't change while the server runs, so definitive
 * answers are memoized for the process lifetime. An `unknown` result (often a transient
 * driver update) is cached only for `CUDA_UNKNOWN_RETRY_MS`.
 *
 * @param {{refresh?: boolean, now?: () => number, execFileImpl?: Function,
 *          timeoutMs?: number}} [opts]
 * @returns {Promise<object>} the `detectCudaGpus` result
 */
export async function getCudaCapability({ refresh = false, now = Date.now, ...probeOpts } = {}) {
  if (!refresh && cachedProbe && now() < cacheExpiresAt) return cachedProbe;
  const pending = detectCudaGpus(probeOpts);
  cachedProbe = pending;
  // Set BEFORE the await so concurrent callers share this probe.
  cacheExpiresAt = Infinity;
  const result = await pending;
  if (result.status === 'unknown') cacheExpiresAt = now() + CUDA_UNKNOWN_RETRY_MS;
  return result;
}

/** Drop the memoized probe — for tests and for a forced re-detect. */
export function resetCudaCapabilityCache() {
  cachedProbe = null;
  cacheExpiresAt = Infinity;
}

// Separate cache: older drivers answer the VRAM query but reject `compute_cap`. Same
// three-state retry policy.
let cachedComputeProbe = null;
let computeCacheExpiresAt = Infinity;

export async function getCudaComputeCapability({ refresh = false, now = Date.now, ...probeOpts } = {}) {
  if (!refresh && cachedComputeProbe && now() < computeCacheExpiresAt) return cachedComputeProbe;
  const pending = detectCudaComputeCapability(probeOpts);
  cachedComputeProbe = pending;
  computeCacheExpiresAt = Infinity;
  const result = await pending;
  if (result.status === 'unknown') computeCacheExpiresAt = now() + CUDA_UNKNOWN_RETRY_MS;
  return result;
}

export function resetCudaComputeCapabilityCache() {
  cachedComputeProbe = null;
  computeCacheExpiresAt = Infinity;
}

let cachedUtilization = null;
let utilizationExpiresAt = 0;
export const CUDA_UTILIZATION_TTL_MS = 4000;

export async function getCudaUtilization({ refresh = false, now = Date.now, ...probeOpts } = {}) {
  if (!refresh && cachedUtilization && now() < utilizationExpiresAt) return cachedUtilization;
  const pending = detectCudaUtilization(probeOpts);
  cachedUtilization = pending;
  utilizationExpiresAt = now() + CUDA_UTILIZATION_TTL_MS;
  return pending;
}
