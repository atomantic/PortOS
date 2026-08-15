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
 * One CSV row per GPU: `<name>, <total VRAM in MiB>`. `nounits` strips the " MiB"
 * suffix so the column parses as a bare number. Verified against a real driver:
 * `0, NVIDIA GeForce RTX 3090, 24576, 596.36` for the fuller query — this narrower
 * one emits `NVIDIA GeForce RTX 3090, 24576`.
 */
export const NVIDIA_SMI_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,memory.total',
  '--format=csv,noheader,nounits',
]);

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
    const vramMib = Number(mib);
    const sized = Number.isFinite(vramMib) && vramMib > 0;
    gpus.push({
      name,
      vramMib: sized ? vramMib : null,
      // Round to whole GB for the same reason unified memory is rounded: a "24 GB"
      // card reports a hair under 24 GiB and must not trip a 24 GB floor.
      vramGb: sized ? Math.round(vramMib / 1024) : null,
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
  const result = await new Promise((resolve) => {
    execFileImpl(
      'nvidia-smi',
      [...NVIDIA_SMI_QUERY_ARGS],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => resolve({ err, stdout: String(stdout ?? '') }),
    );
  }).catch((err) => ({ err, stdout: '' }));

  if (result.err) {
    // `nvidia-smi` isn't installed at all ⇒ no NVIDIA driver on this host. That is a
    // real negative answer, not a failed probe — the binary ships with the driver.
    if (result.err.code === 'ENOENT') {
      return { status: 'absent', gpus: [], maxVramGb: null, error: null };
    }
    // It exists but wouldn't answer (driver/library mismatch, timeout, old driver
    // without --query-gpu). We genuinely do not know what hardware is here.
    return {
      status: 'unknown',
      gpus: [],
      maxVramGb: null,
      error: result.err.message || 'nvidia-smi failed',
    };
  }

  const gpus = parseNvidiaSmiGpus(result.stdout);
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
