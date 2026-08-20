/**
 * NVIDIA CUDA host-capability probe.
 *
 * The single place PortOS asks "does this machine have a usable NVIDIA GPU, and
 * how much VRAM does its biggest card have?". Consumed by the image-to-3D target
 * registry (to gate the `local-cuda` execution lane) and by the FLUX.2 installer
 * (to decide between the CUDA and CPU torch wheels) — previously each had its own
 * `nvidia-smi` invocation and its own idea of what "no GPU" meant.
 *
 * **Three outcomes, never two.** Per the CLAUDE.md sentinel rule, "the probe could
 * not run" is NOT the same answer as "there is no GPU". The result carries a single
 * `status` (deliberately not a boolean, so there is no falsy value a caller can
 * accidentally read as "no GPU"):
 *   - `'available'` — nvidia-smi listed at least one GPU.
 *   - `'absent'`    — no NVIDIA driver (`nvidia-smi` isn't on PATH), or it ran fine
 *                     and listed zero GPUs. A real, negative answer.
 *   - `'unknown'`   — nvidia-smi exists but failed or emitted something unparseable
 *                     (driver mismatch pending a reboot, a timeout, an ancient driver
 *                     without `--query-gpu`). Callers must say "couldn't detect"
 *                     rather than lying about the hardware.
 *
 * The probe is a subprocess boundary outside the request lifecycle, so every path
 * resolves — nothing throws into a route (CLAUDE.md child-process exception).
 */

import { execFile } from './childProcess.js';

/**
 * Spawn `nvidia-smi` with `queryArgs` and triage the outcome, without interpreting the
 * rows. The three probes below differ only in their columns and their parser, so the
 * shell they share — the callback-to-promise wrapper and the `ENOENT` ⇒ real-negative
 * vs anything-else ⇒ `'unknown'` triage — lives here once.
 *
 * `status` is null when the command SUCCEEDED and the caller should parse `stdout`.
 * Module-private on purpose: it is a shape-sharing device, not a new public probe, so
 * it adds no `server/lib/` barrel or README obligation.
 *
 * @param {string[]} queryArgs
 * @param {{execFileImpl?: Function, timeoutMs?: number}} [opts]
 * `error` follows the majority contract (null on `ENOENT`, since absent hardware is an
 * answer rather than a failure); `rawError` always carries the underlying message, so
 * the one probe with a different historical contract can keep it.
 *
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
  // `nvidia-smi` isn't installed at all ⇒ no NVIDIA driver on this host. That is a real
  // negative answer, not a failed probe — the binary ships with the driver.
  if (result.err.code === 'ENOENT') return { status: 'absent', stdout: '', error: null, rawError };
  // It exists but wouldn't answer (driver/library mismatch, timeout, a driver too old
  // for one of these columns). We genuinely do not know what hardware is here.
  return { status: 'unknown', stdout: '', error: rawError || 'nvidia-smi failed', rawError };
}

/**
 * MiB → whole GB, or null when the column didn't parse.
 *
 * Rounded rather than floored because a "24 GB" card reports a hair under 24 GiB and
 * must not trip a 24 GB floor. Shared by both row parsers so this policy is stated
 * once — it matters more since the CUDA image-to-3D lanes have DIFFERENT VRAM floors
 * (12 GB and 24 GB), and a rounding change that reached only one parser would move one
 * lane's gate and not the other's.
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
 * suffix so the column parses as a bare number. Verified against a real driver:
 * `0, NVIDIA GeForce RTX 3090, 24576, 596.36` for the fuller query — this narrower
 * one emits `NVIDIA GeForce RTX 3090, 24576`.
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
  // NOTE: this probe reports the raw `error` message even on ENOENT, where the other
  // two report null. That asymmetry is pre-existing, so it reads `rawError` to preserve
  // its exact contract — sharing the spawn shell must not silently change what a
  // caller returns.
  if (probe.status) return { status: probe.status, gpus: [], error: probe.rawError };
  const gpus = parseNvidiaSmiUtilization(probe.stdout);
  return { status: gpus.length ? 'available' : 'absent', gpus, error: null };
}

/**
 * One CSV row per GPU: `<name>, <compute capability>, <total VRAM in MiB>` — e.g.
 * `NVIDIA GeForce RTX 3090, 8.6, 24576`.
 *
 * **Deliberately a SECOND query rather than extra columns on `NVIDIA_SMI_QUERY_ARGS`.**
 * `compute_cap` needs a reasonably modern `nvidia-smi`; asking an older driver for it
 * fails the WHOLE query, which would turn every host with an old driver into a global
 * `'unknown'` and take the working `local-cuda` lane down with it. Compute capability
 * is only needed at Pixal3D install time (to build NATTEN for the right arch), so it
 * gets its own probe whose failure is contained to that one installer.
 */
export const NVIDIA_SMI_COMPUTE_CAP_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,compute_cap,memory.total',
  '--format=csv,noheader,nounits',
]);

/**
 * Parse the compute-capability query into GPU descriptors. Pure.
 *
 * A row whose `compute_cap` column doesn't parse carries `computeCap: null` (the same
 * "present but unmeasured" sentinel `parseNvidiaSmiGpus` uses for VRAM) rather than
 * being dropped — a card we cannot classify is still a card, and callers gate on the
 * null instead of being told there is no GPU.
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
    // `8.6` / `12.0` — a bare major.minor. Anything else is an unreadable column, not
    // an arch we should hand to a compiler flag.
    const computeCap = /^\d+\.\d+$/.test(cap || '') ? cap : null;
    gpus.push({ name, computeCap, vramGb: vramGbFromMib(mib) });
  }
  return gpus;
}

/**
 * Probe the CUDA compute capability of this host's GPUs. Always resolves, with the
 * same three-state `status` contract as `detectCudaGpus` (see the file header).
 *
 * `primaryComputeCap` is the arch of the LARGEST card, not the highest arch: a render
 * runs on one GPU and the lane picks the biggest one, so the build flag must describe
 * that same card. Ties resolve to the first row. `null` when no row carried a
 * readable arch — callers must treat that as "could not determine" and fall back to a
 * compiler default, never guess an arch.
 *
 * @param {{execFileImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: 'available'|'absent'|'unknown', gpus: Array<object>,
 *                    primaryComputeCap: string|null, error: string|null}>}
 */
export async function detectCudaComputeCapability({ execFileImpl = execFile, timeoutMs = 8000 } = {}) {
  // A driver too old for `compute_cap` lands in `'unknown'` via the shared triage.
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
 * Pure, so the format is covered deterministically instead of depending on whatever
 * card the test host happens to have.
 *
 * A row whose VRAM column doesn't parse (some vGPU/MIG configurations report `[N/A]`)
 * still counts as a GPU — it is present, we just can't size it — and carries
 * `vramGb: null`. Dropping it would under-report the host as having no GPU at all;
 * reporting `0` would look like a card that fails every memory floor. `null` is the
 * honest "present, size unknown", and callers gate on `Number.isFinite`.
 *
 * @param {string} stdout
 * @returns {Array<{name: string, vramMib: number|null, vramGb: number|null}>}
 */
export function parseNvidiaSmiGpus(stdout) {
  const gpus = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Card names never contain a comma, so a plain split is enough; take the first
    // two columns and ignore any extra the query might grow.
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
 * the file header. `execFileImpl` is injectable so every branch is unit-testable
 * without an NVIDIA box (and without one being *absent* on a CI Mac either).
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
    // The biggest single card — a render runs on one GPU, so summing would advertise
    // capacity no single job can use.
    maxVramGb: sizes.length ? Math.max(...sizes) : null,
    error: null,
  };
}

// `null` = never probed (distinct from a probed result that says "no GPU"). Holds the
// in-flight promise so concurrent callers share one subprocess rather than racing
// several `nvidia-smi` spawns.
let cachedProbe = null;
// Epoch ms at which the memo goes stale. `Infinity` for a definitive answer (GPU
// hardware doesn't change while the server runs); a short horizon for `unknown`.
let cacheExpiresAt = Infinity;

/**
 * How long an `unknown` verdict is held before the probe is retried. Short enough that
 * a driver that comes back (a reboot, a finished update) is picked up promptly, long
 * enough that a *persistently* broken driver — where `nvidia-smi` hangs until its
 * timeout — costs one stalled spawn a minute instead of one per request. Without this
 * bound, a wedged GPU adds the full probe timeout to every `/targets` load and every
 * generate call.
 */
export const CUDA_UNKNOWN_RETRY_MS = 60_000;

/**
 * Cached `detectCudaGpus()`. GPU hardware doesn't change while the server runs, so
 * the answer is memoized — this is called per `/targets` request and a spawn on each
 * would be pure waste.
 *
 * An `unknown` result is cached only briefly (`CUDA_UNKNOWN_RETRY_MS`) rather than for
 * the process lifetime: it means the probe itself failed, often transiently (a driver
 * mid-update), so pinning it would hide a GPU that becomes visible a minute later —
 * but re-probing on every call would make a persistently-wedged driver cost a stalled
 * subprocess per request.
 *
 * @param {{refresh?: boolean, now?: () => number, execFileImpl?: Function,
 *          timeoutMs?: number}} [opts]
 * @returns {Promise<object>} the `detectCudaGpus` result
 */
export async function getCudaCapability({ refresh = false, now = Date.now, ...probeOpts } = {}) {
  if (!refresh && cachedProbe && now() < cacheExpiresAt) return cachedProbe;
  const pending = detectCudaGpus(probeOpts);
  cachedProbe = pending;
  // Assume definitive until proven otherwise, and set it BEFORE the await so
  // concurrent callers share this probe instead of each spawning their own.
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

export function resetCudaUtilizationCache() {
  cachedUtilization = null;
  utilizationExpiresAt = 0;
}
