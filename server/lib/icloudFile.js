/**
/**
 * iCloud (ubiquity-container) file guards.
 *
 * ## Why this exists
 *
 * macOS "Optimize Mac Storage" evicts iCloud files. An evicted file is *dataless*:
 * the path exists and `stat()` reports the real `size`, but no blocks are allocated.
 * The first `read(2)` blocks in the kernel while the OS materializes the bytes, and
 * if that stalls (wedged `bird`, offline) **the syscall never returns and cannot be
 * cancelled**.
 *
 * Node's async `fs` runs on the libuv threadpool (default FOUR threads), so four
 * blocked reads freeze every `fs` operation, including `express.static`: "the whole
 * UI hangs" while memory-only routes answer. Only a restart clears it. Retry doesn't
 * help (the read hangs, it doesn't fail): never issue the read.
 *
 * ## Which syscalls materialize (measured on macOS 26 / APFS, fresh evicted subject per case)
 *
 * | syscall                          | materializes? | cost on a HEALTHY iCloud |
 * |----------------------------------|---------------|--------------------------|
 * | `stat`                           | no            | instant                  |
 * | `open` — `'r'`, `'a'`, `'r+'`    | no            | 0 ms                     |
 * | `rename`                         | no            | 0–1 ms                   |
 * | `unlink`                         | no            | 0 ms                     |
 * | `read`                           | **yes**       | ~900 ms                  |
 * | `write` after `O_TRUNC` (`'w'`)  | **yes**       | ~820 ms                  |
 * | `write` in append mode (`'a'`)   | **yes**       | ~690 ms                  |
 * | `link` (hard link)               | **yes**       | —                        |
 * | `clonefile` (`cp -c`)            | **yes**       | —                        |
 *
 * 1. **`O_TRUNC` does NOT short-circuit materialization**: the same `writeFile`
 *    cost 822 ms dataless vs 1 ms materialized. A write path needs the same screen
 *    as a read path.
 * 2. **Screening is free**: `stat` and `open` never materialize.
 * 3. **`unlink` is free** — measured, not inferred (`link` is metadata-only yet
 *    materializes): 0.1 ms on evicted files up to 5 MB vs 884 ms to read an equal
 *    dataless file. Delete paths need no screen.
 *
 * ## Reproducing
 *
 * `brctl evict <path>` works from a CLI (absent from `brctl --help`, like
 * `brctl download`; refuses only as root). `fileproviderctl` has no `evict`,
 * `chflags dataless` no-ops, and `FileManager.evictUbiquitousItem` fails with
 * NSCocoaErrorDomain 512 unentitled. Verify with `stat -f "blocks=%b flags=%Sf size=%z"`
 * (evicted: `blocks=0`, `compressed,dataless`). Time the syscall in a CHILD process
 * with a hard kill, one fresh subject per case.
 *
 * ## The screen
 *
 * `stat()` returns instantly on a dataless file and `Stats.blocks` exposes it:
 * `size > 0 && blocks === 0`. The screen is scoped to darwin AND paths resolving
 * into a cloud-file root, because an ordinary file also reports `blocks === 0` when
 * sparse or compressed. Inside a cloud root the two coincide in practice (evicted
 * files report `compressed,dataless` together).
 *
 * If it ever misfires on a genuinely sparse file in a cloud root, reads report
 * "temporarily unavailable" and `brctl download` can't fix it. No data is lost
 * (writes keep their own refuse-to-overwrite guards). Callers that must degrade (a
 * vault walk) skip and count; callers that must not silently succeed (a store
 * write) fail loudly.
 *
 * ## Only ONE representation to screen for
 *
 * The pre-APFS `.Foo.json.icloud` placeholder stub does not occur: across 223
 * containers holding 373 evicted files every one was dataless and zero placeholders
 * existed. So ENOENT is a trustworthy "no file". If a placeholder is ever observed,
 * the probe belongs HERE, wired into `mortalLoomStore.updateStore` and
 * `obsidian.createNote` together.
 */

import { open, readFile, stat } from 'fs/promises';
import { realpathSync } from 'fs';
import { dirname } from 'path';
import { spawn } from './childProcess.js';
import { bufferedSpawn } from './bufferedSpawn.js';
import { createSingleFlight } from './singleFlight.js';

/** `err.code` on the rejection `readIfMaterialized` throws for an evicted file. */
export const ICLOUD_NOT_MATERIALIZED = 'ICLOUD_NOT_MATERIALIZED';

// macOS cloud-file roots whose first `read(2)` can block: iCloud ubiquity containers
// and File Provider mounts (Dropbox / Drive / OneDrive online-only). `brctl` only
// heals iCloud, but refusing the read prevents the outage for both.
const CLOUD_MARKERS = ['/Library/Mobile Documents/', '/Library/CloudStorage/'];

// Only iCloud paths can be healed with `brctl download`.
const ICLOUD_MARKER = CLOUD_MARKERS[0];

// A substring test isn't enough: `~/Documents` is a SYMLINK into Mobile Documents
// when "Desktop & Documents Folders" sync is on. Resolve the containing DIRECTORY's
// realpath once and memoize it (a per-read realpath would tax every read); bounded,
// and a symlink repointed after boot isn't re-resolved until evicted.
const dirCloudCache = new Map();
const DIR_CACHE_MAX = 512;

function markerMatch(path) {
  return CLOUD_MARKERS.some(marker => path.includes(marker));
}

/**
 * True when `path` resolves into a macOS cloud-file root. Checks the literal
 * string first, then the memoized real path of the containing directory so a
 * symlinked route (`~/Documents/...`) is recognized.
 */
export function isUbiquityPath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (markerMatch(path)) return true;
  const dir = dirname(path);
  const cached = dirCloudCache.get(dir);
  if (cached !== undefined) return cached;
  // realpathSync throws for a missing/unreadable directory; unresolvable isn't claimed as cloud.
  let resolved = false;
  try {
    resolved = markerMatch(realpathSync(dir));
  } catch {
    resolved = false;
  }
  if (dirCloudCache.size >= DIR_CACHE_MAX) dirCloudCache.clear();
  dirCloudCache.set(dir, resolved);
  return resolved;
}

/** True when `path` is an iCloud ubiquity path, the only kind `brctl` can heal. */
function isHealablePath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes(ICLOUD_MARKER)) return true;
  try {
    return realpathSync(dirname(path)).includes(ICLOUD_MARKER);
  } catch {
    return false;
  }
}

/**
 * True when a `fs.Stats` looks dataless: a real byte length with zero local blocks.
 * **Not sufficient alone** — sparse/compressed files also report `blocks === 0`;
 * pair with platform + cloud-root scoping (`isEvictedStats`, `isSuspectedDataless`).
 * Exported so a caller already holding a `Stats` avoids a second `stat()`.
 */
export function isDatalessStats(stats) {
  return Boolean(stats) && stats.size > 0 && stats.blocks === 0;
}

/** Scoped verdict for a caller holding a `Stats`: dataless-looking AND darwin AND in a cloud root. Use instead of bare `isDatalessStats`. */
export function isEvictedStats(path, stats) {
  return process.platform === 'darwin' && isDatalessStats(stats) && isUbiquityPath(path);
}

/** True when reading `path` risks a permanently-blocked `read(2)`: one `stat()`, darwin cloud-root paths only. A `stat()` failure resolves `false` (the caller's own error paths). */
export async function isSuspectedDataless(path) {
  if (process.platform !== 'darwin' || !isUbiquityPath(path)) return false;
  const stats = await stat(path).catch(() => null);
  return isDatalessStats(stats);
}

// Warn at most once per process if `brctl` is missing (sandbox, stripped image).
let brctlMissingWarned = false;

/** Claim the one-shot "brctl is missing" warning (true on the first call only), shared by every brctl caller so it fires once per process. */
export function claimBrctlMissingWarning() {
  if (brctlMissingWarned) return false;
  brctlMissingWarned = true;
  return true;
}

// In-flight background materializations, `path -> child`. The child is an identity
// token: a deadline kill frees the slot before 'exit' fires, so a replacement child
// may exist, and the old child's late 'exit' must not delete its entry.
const pendingDownloads = new Map();

// Cap on concurrent background downloads so a vault-wide walk can't spawn thousands
// of `brctl` children; skipping the heal is safe (the read is refused anyway).
const MAX_PENDING_DOWNLOADS = 4;

// `brctl download` exits 0 within ~100ms of QUEUEING while the file stays evicted
// for seconds to minutes; without a cooldown, polling reads re-spawn brctl each time.
const REQUEST_COOLDOWN_MS = 30_000;
const lastRequestAt = new Map();

// Every background download gets a deadline: `brctl` is what hangs when iCloud is
// wedged, and four hung children would hold every slot forever. Exposed (not const)
// so tests don't wait on it.
export let DOWNLOAD_DEADLINE_MS = 120_000;
export function _setDownloadDeadlineForTest(ms) { DOWNLOAD_DEADLINE_MS = ms; }

// Deadline for the AWAITED write-path materialize; much tighter than
// DOWNLOAD_DEADLINE_MS because a caller is blocked on it. Exposed (not const) for tests.
export let MATERIALIZE_TIMEOUT_MS = 20_000;
export function _setMaterializeTimeoutForTest(ms) { MATERIALIZE_TIMEOUT_MS = ms; }

/**
 * Fire-and-forget `brctl download <path>` so an evicted file heals in the
 * background. Detached + unref'd; never throws or blocks — read paths then refuse
 * the read for *this* cycle. Returns `true` when a child was spawned, `false` when
 * declined (non-darwin, non-iCloud, deduped, or capped).
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.label='iCloud file'] - Label for log lines.
 * @param {boolean} [options.retryAfterExit=true] - `true` (read paths): tracked in
 *   the shared in-flight map and counted against the cap. `false` (boot/settings
 *   pin): deduped at its call site and NOT tracked here, so config-path churn can't
 *   starve the read-heal slots.
 * @param {() => void} [options.onFailure] - Called when the child errors, exits
 *   non-zero, or is killed (never on exit 0), so an untracked caller can clear its
 *   sticky dedupe.
 */
export function requestMaterialization(path, options = {}) {
  const { label = 'iCloud file', retryAfterExit = true, onFailure } = options;
  if (process.platform !== 'darwin' || !path) return false;
  // `brctl` speaks iCloud only; third-party File Provider files are screened but can't be healed.
  if (!isHealablePath(path)) return false;
  // Only the tracked (read) path uses the shared dedupe + cap; the pin dedupes at its own call site.
  if (retryAfterExit) {
    if (pendingDownloads.has(path)) return false;
    if (pendingDownloads.size >= MAX_PENDING_DOWNLOADS) return false;
    const last = lastRequestAt.get(path);
    if (last !== undefined && Date.now() - last < REQUEST_COOLDOWN_MS) return false;
  }

  // try/catch at a child-process boundary: `spawn` can throw synchronously (EMFILE);
  // a failed heal must not replace the caller's ICLOUD_NOT_MATERIALIZED verdict.
  let child;
  try {
    child = spawn('brctl', ['download', path], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    console.warn(`⚠️ could not spawn brctl download for ${label}: ${err.message}`);
    return false;
  }
  // `spawn` is synchronous, so nothing interleaves between the size check and this reservation.
  if (retryAfterExit) {
    pendingDownloads.set(path, child);
    const now = Date.now();
    // Sweep expired entries so a vault walk over many distinct paths can't grow the map unbounded.
    for (const [p, at] of lastRequestAt) if (now - at >= REQUEST_COOLDOWN_MS) lastRequestAt.delete(p);
    lastRequestAt.set(path, now);
  }
  // Release only the entry THIS child owns (see pendingDownloads).
  const release = () => {
    if (retryAfterExit && pendingDownloads.get(path) === child) pendingDownloads.delete(path);
  };
  // Notify the failure hook AT MOST once per child: 'error' may precede 'exit', and
  // the deadline handler fires it too (a SIGKILL'd unreaped child emits no 'exit',
  // which would leave the pin's sticky dedupe set forever). The guard also stops a
  // stale child's late 'exit' clearing a replacement's sticky path.
  let failureNotified = false;
  const notifyFailure = () => {
    if (failureNotified) return;
    failureNotified = true;
    // try/catch at a timer/child-process boundary: `onFailure` is a caller-supplied
    // hook and an uncaught throw here would crash the process.
    try { onFailure?.(); } catch (err) {
      console.error(`❌ brctl onFailure hook threw for ${label}: ${err.message}`);
    }
  };
  // Kill a wedged `brctl` at its deadline so it frees its slot; `unref` so the timer never keeps the process alive.
  const deadline = setTimeout(() => {
    console.warn(`⚠️ brctl download exceeded ${DOWNLOAD_DEADLINE_MS}ms for ${label}; killing: ${path}`);
    // Detached child: signal the process group so grandchildren die. `child.kill?.`
    // because this runs outside any request lifecycle and `child` may be a test double.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill?.('SIGKILL'); }
    // Free the slot and the pin's sticky dedupe now in case 'exit' never fires.
    release();
    notifyFailure();
  }, DOWNLOAD_DEADLINE_MS);
  deadline.unref?.();
  const settle = () => { clearTimeout(deadline); release(); };

  // Capture `path` per handler so a late exit can't clear another path's entry.
  child.on('error', (err) => {
    settle();
    notifyFailure();
    if (err.code === 'ENOENT') {
      if (claimBrctlMissingWarning()) {
        console.warn(`⚠️ brctl not found on PATH; ${label} materialization disabled`);
      }
      return;
    }
    console.warn(`⚠️ brctl download failed for ${label}: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    settle();
    if (code === 0) {
      // exit 0 means ACCEPTED/QUEUED, not local (brctl can return 0 before
      // materialization, or when sync ultimately can't fetch): log a request, not a completion.
      console.log(`📥 ${label} iCloud download requested: ${path}`);
      return;
    }
    notifyFailure();
    if (code !== null) {
      console.warn(`⚠️ brctl download exited ${code} for ${label}: ${path}`);
    } else {
      console.warn(`⚠️ brctl download killed by ${signal} for ${label}: ${path}`);
    }
  });
  return true;
}

/**
 * `brctl download <path>`, **awaited** and bounded by a timeout: the write-path
 * counterpart to `requestMaterialization`. A write must neither silently skip nor
 * block on the dataless write, so it materializes first and the caller fails loudly
 * if that didn't work. A wedged `brctl` is a cancellable child that misses its
 * deadline and is killed.
 *
 * Resolves `true` only when `brctl` exited 0, which means the download was
 * ACCEPTED, not that bytes are local: always re-screen before trusting the file.
 *
 * Never throws: every failure (missing `brctl`, timeout, non-zero exit) warns and
 * resolves `false`.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.label='iCloud file'] - Label for log lines.
 * @param {number} [options.timeoutMs=MATERIALIZE_TIMEOUT_MS] - Deadline for the child.
 */
export async function materializeAndWait(path, options = {}) {
  const { label = 'iCloud file', timeoutMs = MATERIALIZE_TIMEOUT_MS } = options;
  if (process.platform !== 'darwin' || !path) return false;
  // try/catch at a child-process boundary: `bufferedSpawn` lets a synchronous spawn
  // throw (EMFILE) propagate; a failed heal must not replace the clean "write refused" verdict.
  let result;
  try {
    result = await bufferedSpawn('brctl', ['download', path], { timeoutMs, shell: false });
  } catch (err) {
    result = { success: false, error: err };
  }
  if (result.success) return true;
  if (result.error?.code === 'ENOENT') {
    if (claimBrctlMissingWarning()) {
      console.warn(`⚠️ brctl not found on PATH; ${label} on-demand materialize disabled`);
    }
  } else if (result.timedOut) {
    console.warn(`⚠️ brctl download timed out after ${timeoutMs}ms for ${label}: ${path}`);
  } else if (result.error) {
    console.warn(`⚠️ brctl download failed for ${label}: ${result.error.message}`);
  } else {
    console.warn(`⚠️ brctl download exited ${result.code} for ${label}: ${path}`);
  }
  return false;
}

// Concurrent callers for a path share ONE read (one threadpool slot); this coalesces concurrency, it doesn't cache.
let readFlight = createSingleFlight();

/**
 * `readFile`, but never against an evicted iCloud file: those kick a background
 * `brctl download` and reject with `err.code === ICLOUD_NOT_MATERIALIZED` (the
 * read is never issued). Concurrent calls for a path share one read.
 *
 * Residual risk, accepted: eviction can land between the `stat()` screen and
 * `readFile`; single-flight caps it at one stranded threadpool slot per path, and
 * `UV_THREADPOOL_SIZE` is raised in `ecosystem.config.cjs`.
 */
export async function readIfMaterialized(path, options = {}) {
  const { encoding = 'utf-8', prefixBytes } = options;
  // Key on encoding too: a utf-8 string is not a base64 string. A prefix read
  // must never share a flight with a full read of the same path (or vice versa).
  const mode = prefixBytes ? `prefix:${prefixBytes}` : 'full';
  return readFlight.run(`${encoding}\u0000${mode}\u0000${path}`, () => guardedRead(path, options));
}

async function guardedRead(path, options) {
  const { encoding = 'utf-8', label = 'iCloud file', prefixBytes } = options;
  if (await isSuspectedDataless(path)) {
    requestMaterialization(path, { label });
    const err = new Error(`${label} is evicted from local storage (iCloud); refusing to block on read`);
    err.code = ICLOUD_NOT_MATERIALIZED;
    throw err;
  }
  if (!prefixBytes) return readFile(path, encoding);
  // Bounded read: at most `prefixBytes` bytes. A multibyte character may be cut
  // at the end; callers that slice by code units must request enough bytes.
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(prefixBytes);
    const { bytesRead } = await fh.read(buf, 0, prefixBytes, 0);
    return buf.subarray(0, bytesRead).toString(encoding);
  } finally {
    await fh.close();
  }
}

/** Test hook: clear the one-shot warning + dedupe/single-flight state. */
export function _resetICloudFileStateForTest() {
  brctlMissingWarned = false;
  pendingDownloads.clear();
  lastRequestAt.clear();
  readFlight = createSingleFlight();
  dirCloudCache.clear();
}
