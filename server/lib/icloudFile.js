/**
 * iCloud (ubiquity-container) file guards.
 *
 * ## Why this exists
 *
 * macOS "Optimize Mac Storage" evicts iCloud files to the cloud. An evicted
 * file is *dataless*: the path still exists and `stat()` still reports the real
 * `size`, but no blocks are allocated locally. The first `read(2)` against it
 * blocks in the kernel while the OS materializes the bytes — and if that
 * materialization stalls (wedged `bird` daemon, offline device), **the syscall
 * never returns and cannot be cancelled**.
 *
 * Node's async `fs` calls run on the libuv threadpool, which defaults to FOUR
 * threads. Four blocked reads therefore exhaust it, and from that moment every
 * `fs` operation in the process queues forever — including the `express.static`
 * stat/read that serves the client bundle. The observable symptom is "the whole
 * UI hangs" while memory-only routes still answer in milliseconds, which reads
 * like a network fault and is not one. Only a process restart clears it.
 *
 * Retry-on-error logic does NOT help here: a dataless read doesn't *fail*, it
 * *hangs*. The only safe move is to never issue the read in the first place.
 *
 * ## Which syscalls actually materialize (measured, #3706)
 *
 * The trigger is the first **data access**, not the `open(2)`. Measured on
 * macOS 26 (Darwin 25.5, APFS) against freshly-evicted iCloud files — a fresh
 * subject per case, since the first materializing call heals the file:
 *
 * | syscall                          | materializes? | cost on a HEALTHY iCloud |
 * |----------------------------------|---------------|--------------------------|
 * | `stat`                           | no            | instant                  |
 * | `open` — `'r'`, `'a'`, `'r+'`    | no            | 0 ms                     |
 * | `rename`                         | no            | 0–1 ms                   |
 * | `read`                           | **yes**       | ~900 ms                  |
 * | `write` after `O_TRUNC` (`'w'`)  | **yes**       | ~820 ms                  |
 * | `write` in append mode (`'a'`)   | **yes**       | ~690 ms                  |
 * | `link` (hard link)               | **yes**       | —                        |
 * | `clonefile` (`cp -c`)            | **yes**       | —                        |
 *
 * Two consequences that are easy to get wrong:
 *
 * 1. **`O_TRUNC` does NOT short-circuit materialization.** Truncating to zero
 *    discards every byte the download would fetch, so "there is nothing to
 *    materialize" is an appealing inference — and it is wrong. The same
 *    `writeFile(path, content, 'utf-8')` cost 822 ms dataless and **1 ms** once
 *    materialized, on the same path with only the dataless bit changed (a
 *    non-iCloud local file: 0 ms). That ~800 ms is the download, not iCloud
 *    write coordination. So a *write* path needs the same screen as a read path.
 * 2. **Screening is free.** `stat` and `open` never materialize, so a guard
 *    costs nothing on the healthy path — including `existsSync` precondition
 *    checks, which can stay exactly where they are.
 *
 * `unlink` is deliberately absent above: it is untested. Do not assume it is
 * free by analogy with `rename` — `link` is also pure metadata and it *does*
 * materialize.
 *
 * ## The screen
 *
 * `stat()` is safe — it does NOT trigger materialization and returns instantly
 * on a dataless file. Node exposes `Stats.blocks`, so a dataless file is
 * detectable with no native code and no subprocess: `size > 0 && blocks === 0`.
 *
 * The screen is deliberately scoped to darwin AND paths that resolve into a
 * cloud-file root. An ordinary APFS file also reports `blocks === 0` when it is
 * sparse or transparently compressed (data in a `com.apple.decmpfs` xattr), and
 * other filesystems do the same for inline extents — so an unscoped screen would
 * refuse to read perfectly good files. Inside a cloud root the two coincide in
 * practice: macOS represents "no local data" *via* the compression mechanism,
 * which is why an evicted file reports `compressed,dataless` together, and user
 * JSON/markdown in iCloud Drive is not otherwise compressed by the OS.
 *
 * **Cost if the screen ever does misfire** (a genuinely sparse or compressed file
 * that lives inside a cloud root): reads of that file report "temporarily
 * unavailable" and `brctl download` cannot fix it, because the bytes were never
 * evicted — so it does NOT self-heal on the next read. Data is never lost: write
 * paths keep their own refuse-to-overwrite guards, so the failure mode is a
 * persistent read/write outage for that one file, not corruption. Callers that
 * must degrade gracefully (a vault walk) skip the file and report a skipped
 * count; callers that must not silently succeed (a store write) fail loudly.
 */

import { readFile, stat } from 'fs/promises';
import { realpathSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { bufferedSpawn } from './bufferedSpawn.js';
import { createSingleFlight } from './singleFlight.js';

/** `err.code` on the rejection `readIfMaterialized` throws for an evicted file. */
export const ICLOUD_NOT_MATERIALIZED = 'ICLOUD_NOT_MATERIALIZED';

// macOS cloud-file roots whose contents can be evicted to the cloud and whose
// first `read(2)` therefore blocks: iCloud's per-app ubiquity containers, and the
// File Provider mounts macOS 12+ gives third parties (Dropbox / Google Drive /
// OneDrive "online-only"). `brctl` only heals the iCloud one — but *refusing* the
// read is what prevents the outage, so both are screened.
const CLOUD_MARKERS = ['/Library/Mobile Documents/', '/Library/CloudStorage/'];

// Only iCloud paths can be healed with `brctl download`.
const ICLOUD_MARKER = CLOUD_MARKERS[0];

// A literal substring test is not enough: `~/Documents` is a SYMLINK into
// `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` when macOS
// "Desktop & Documents Folders" sync is on, so a vault stored as
// `/Users/x/Documents/Vault` is in iCloud while its path string says nothing of
// the sort. Resolving the real path is what closes that hole — but a `realpath`
// per read would tax every ordinary file read in the process, so resolve the
// containing DIRECTORY once and memoize it (a vault walk reads many files per
// directory). Bounded so a long-lived process can't grow it without limit; a
// symlink that is repointed after boot is not re-resolved until the entry is
// evicted, which is an acceptable trade for the cost saved.
const dirCloudCache = new Map();
const DIR_CACHE_MAX = 512;

function markerMatch(path) {
  return CLOUD_MARKERS.some(marker => path.includes(marker));
}

/**
 * True when `path` resolves into a macOS cloud-file root whose contents can be
 * evicted. Checks the literal string first (the common, allocation-free case),
 * then falls back to the memoized real path of the containing directory so a
 * symlinked route into iCloud (`~/Documents/...`) is still recognized.
 */
export function isUbiquityPath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (markerMatch(path)) return true;
  const dir = dirname(path);
  const cached = dirCloudCache.get(dir);
  if (cached !== undefined) return cached;
  // realpathSync throws for a missing/unreadable directory; a path we can't
  // resolve is not one we can claim is in the cloud.
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
 * True when a `fs.Stats` looks dataless (evicted): a real byte length with zero
 * blocks allocated locally.
 *
 * **Not sufficient on its own** — an ordinary APFS file reports `blocks === 0`
 * when it is sparse or transparently compressed, and other filesystems do the
 * same for inline/compressed extents. Always pair it with the platform + cloud-root
 * scoping (`isEvictedStats`, or `isSuspectedDataless` which does the `stat` too);
 * a bare call would refuse to read perfectly good files. Kept exported because a
 * caller that already holds a `Stats` should not pay a second `stat()`.
 */
export function isDatalessStats(stats) {
  return Boolean(stats) && stats.size > 0 && stats.blocks === 0;
}

/**
 * The correctly-scoped verdict for a caller that already holds a `Stats`:
 * dataless-looking AND on darwin AND inside a cloud-file root. Use this rather
 * than `isDatalessStats` alone.
 */
export function isEvictedStats(path, stats) {
  return process.platform === 'darwin' && isDatalessStats(stats) && isUbiquityPath(path);
}

/**
 * True when reading `path` would risk a permanently-blocked `read(2)`. Cheap:
 * one `stat()`, and only on darwin for cloud-root paths. A `stat()` failure
 * (ENOENT/EACCES) resolves `false` — absent and unreadable are the caller's
 * existing error paths, not this guard's business.
 */
export async function isSuspectedDataless(path) {
  if (process.platform !== 'darwin' || !isUbiquityPath(path)) return false;
  const stats = await stat(path).catch(() => null);
  return isDatalessStats(stats);
}

// `brctl` is present on every stock macOS. Warn at most once per process if it
// isn't (sandbox, stripped image) so operators aren't left wondering why
// materialization is a silent no-op, without spamming on every read.
let brctlMissingWarned = false;

/**
 * Claim the one-shot "brctl is missing" warning. Returns true on the first call
 * only, false thereafter. Exported so every brctl caller in the process — the
 * fire-and-forget `requestMaterialization` read/pin path AND awaited write-path
 * variants like `mortalLoomStore.materializeNow` — shares ONE flag and the
 * "brctl not found on PATH" warning fires at most once per process across all of
 * them (rather than once per caller).
 */
export function claimBrctlMissingWarning() {
  if (brctlMissingWarned) return false;
  brctlMissingWarned = true;
  return true;
}

// In-flight background materializations, `path -> child`. The child doubles as an
// identity token: cleanup must only clear the entry it owns. A deadline kill frees
// the slot before that child's 'exit' fires, so a read arriving in between can
// legitimately start a REPLACEMENT for the same path — and the old child's late
// 'exit' must not then delete the replacement's entry, which would let the next
// read spawn a duplicate and break the concurrency cap.
const pendingDownloads = new Map();

// Hard cap on concurrent background downloads. Without it, a vault-wide walk over
// an evicted Obsidian vault (one read per note) would spawn one `brctl` child per
// note — thousands of processes for a large vault. Skipping the heal past the cap
// is safe: the read is refused either way, and the set drains as children exit so
// later reads pick up where this one stopped.
const MAX_PENDING_DOWNLOADS = 4;

// Every background download gets a deadline. `brctl` is exactly what hangs when
// iCloud is wedged — the very condition this module exists for — and without a
// deadline four hung children would hold all MAX_PENDING_DOWNLOADS slots for the
// life of the process, silently ending all healing and leaking the children.
// Exposed (not const) so tests don't wait on it.
export let DOWNLOAD_DEADLINE_MS = 120_000;
export function _setDownloadDeadlineForTest(ms) { DOWNLOAD_DEADLINE_MS = ms; }

// Default deadline for the AWAITED write-path materialize (`materializeAndWait`).
// Much tighter than DOWNLOAD_DEADLINE_MS above because a caller is blocked on it:
// a background heal can afford two minutes, a user's save cannot. Exposed (not
// const) so tests don't wait on it.
export let MATERIALIZE_TIMEOUT_MS = 20_000;
export function _setMaterializeTimeoutForTest(ms) { MATERIALIZE_TIMEOUT_MS = ms; }

/**
 * Fire-and-forget `brctl download <path>` so an evicted file heals in the
 * background. Detached + unref'd so a slow download can't keep the process
 * alive at shutdown. Never throws and never blocks the caller — read paths use
 * this and then refuse the read for *this* cycle. Returns `true` when a child
 * was spawned, `false` when the request was declined (non-darwin, non-iCloud
 * path, deduped, or capped).
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.label='iCloud file'] - Label for log lines.
 * @param {boolean} [options.retryAfterExit=true] - Dedupe policy. The read paths
 *   pass `true`: the request is tracked in the shared in-flight map (deduped
 *   while a download runs, cleared on exit) so a later read can retry, and it
 *   counts against the concurrency cap. The boot/settings pin passes `false`: it
 *   owns a single-sticky-path dedupe at its call site (re-pin only when the
 *   configured path changes), so it is NOT tracked here — that keeps a churn of
 *   configured-path changes from parking stale pin entries in the shared set and
 *   starving the read-heal slots.
 * @param {() => void} [options.onFailure] - Called when the child errors, exits
 *   non-zero, or is killed (never on a clean exit-0). Lets an untracked caller
 *   (the pin) clear its own sticky dedupe so a failed pin can be retried.
 */
export function requestMaterialization(path, options = {}) {
  const { label = 'iCloud file', retryAfterExit = true, onFailure } = options;
  if (process.platform !== 'darwin' || !path) return false;
  // `brctl` speaks iCloud only. A third-party File Provider file (Dropbox /
  // Google Drive / OneDrive under ~/Library/CloudStorage) is still screened and
  // refused above — we just can't heal it, so don't spawn a doomed child.
  if (!isHealablePath(path)) return false;
  // Only the tracked (read) path uses the shared in-flight dedupe + cap; the pin
  // deduplicates at its own call site, so it neither reserves a slot nor is
  // blocked by the cap (its single configured path can't flood).
  if (retryAfterExit) {
    if (pendingDownloads.has(path)) return false;
    if (pendingDownloads.size >= MAX_PENDING_DOWNLOADS) return false;
  }

  // try/catch at a child-process boundary (permitted by the repo's no-try/catch
  // rule): `spawn` can throw synchronously on resource exhaustion (EMFILE), and
  // this runs inside a request's read path. A failed *heal* must never replace
  // the caller's ICLOUD_NOT_MATERIALIZED verdict with a spawn error — the read
  // is still correctly refused either way.
  let child;
  try {
    child = spawn('brctl', ['download', path], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    // Nothing was reserved yet — the slot is claimed below, after a successful
    // spawn — so there is nothing to release here.
    console.warn(`⚠️ could not spawn brctl download for ${label}: ${err.message}`);
    return false;
  }
  // `spawn` is synchronous, so no other read can interleave between the size
  // check above and this reservation.
  if (retryAfterExit) pendingDownloads.set(path, child);
  // Release only the entry THIS child owns (see the map's comment above). A no-op
  // for an untracked (pin) request, which was never added to the set.
  const release = () => {
    if (retryAfterExit && pendingDownloads.get(path) === child) pendingDownloads.delete(path);
  };
  // Notify the caller's failure hook AT MOST once per child. `'error'` may be
  // followed by `'exit'` (Node makes no guarantee either way), and the deadline
  // handler below fires it too — a child that is SIGKILL'd but never reaped emits
  // no `'exit'`, so without invoking it from the deadline an untracked (pin)
  // caller's sticky dedupe would stay set forever and never re-pin. The once-guard
  // means a stale child's late `'exit'` can't fire the hook a second time and
  // clear a live replacement child's sticky path (both share the same `path`, so
  // the hook's own path guard can't tell them apart).
  let failureNotified = false;
  const notifyFailure = () => {
    if (failureNotified) return;
    failureNotified = true;
    // try/catch at a child-process/timer boundary (permitted by the repo's
    // no-try/catch rule): this runs from the unref'd deadline timer and the
    // 'error'/'exit' handlers — all *outside* the request lifecycle — and
    // `onFailure` is a caller-supplied hook on a public API. An uncaught throw
    // here would crash the process with no `next(err)` to bubble to.
    try { onFailure?.(); } catch (err) {
      console.error(`❌ brctl onFailure hook threw for ${label}: ${err.message}`);
    }
  };
  // Kill the child if it outlives its deadline, so a wedged `brctl` frees its slot
  // instead of holding it forever. `unref` so the timer itself never keeps the
  // process alive; the 'exit' handler below clears the slot once the kill lands.
  const deadline = setTimeout(() => {
    console.warn(`⚠️ brctl download exceeded ${DOWNLOAD_DEADLINE_MS}ms for ${label}; killing: ${path}`);
    // The child is detached (its own process group), so a bare kill would leave
    // any grandchildren behind — signal the group. `child.kill?.` because this
    // runs in an unref'd timer *outside* any request lifecycle: an uncaught throw
    // here would crash the process with no `next(err)` to catch it, and `child`
    // may not be a real ChildProcess with a `kill` method (e.g. a test double).
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill?.('SIGKILL'); }
    // A killed-but-unreaped child would strand the slot AND (for an untracked pin)
    // leave the sticky dedupe set forever; drop both now so healing can resume even
    // if 'exit' never fires.
    release();
    notifyFailure();
  }, DOWNLOAD_DEADLINE_MS);
  deadline.unref?.();
  const settle = () => { clearTimeout(deadline); release(); };

  // Capture `path` in each handler so a late exit from one child can't clear the
  // dedupe entry for a different path.
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
      // brctl exit 0 means the download was ACCEPTED/QUEUED, not that the bytes
      // are local yet — brctl can return 0 before materialization completes, and
      // returns 0 even when the sync layer ultimately can't fetch the file. It is
      // not a completion signal (and under a wedged iCloud brctl can instead hang,
      // which is why the awaited-write path bounds it with a timeout). Log a
      // request, not a completion, so an operator reading these during an outage
      // doesn't conclude the file is now readable when it isn't.
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
 * `brctl download <path>`, **awaited** and bounded by a timeout.
 *
 * The write-path counterpart to `requestMaterialization`. A read path can fire
 * and forget because it refuses the read for this cycle and a later read retries;
 * a *write* path has no such luxury — it must not silently skip the write, and it
 * must not issue a blocking one either (measured: a write to a dataless file
 * materializes, see the syscall table above). So it materializes first, waits for
 * the result, and lets the caller fail loudly if that didn't work.
 *
 * Runs `brctl` in a child process, which is what makes the wait cancellable: the
 * kernel write this replaces cannot be interrupted, but a wedged `brctl` is just
 * a child that misses its deadline and gets killed. That is the whole point of
 * routing through `brctl` rather than letting the write block.
 *
 * Resolves `true` only when `brctl` exited 0. **That means the download was
 * ACCEPTED, not that the bytes are local** — `brctl` can return 0 before
 * materialization completes. Always re-screen (or use a reader that re-screens)
 * before trusting the file; never drop a subsequent guard on the strength of a
 * `true` here.
 *
 * Never throws: every failure mode (missing `brctl`, timeout, non-zero exit)
 * warns and resolves `false`.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.label='iCloud file'] - Label for log lines.
 * @param {number} [options.timeoutMs=MATERIALIZE_TIMEOUT_MS] - Deadline for the child.
 */
export async function materializeAndWait(path, options = {}) {
  const { label = 'iCloud file', timeoutMs = MATERIALIZE_TIMEOUT_MS } = options;
  if (process.platform !== 'darwin' || !path) return false;
  // try/catch at a child-process boundary (permitted by the repo's no-try/catch
  // rule, and mirroring `requestMaterialization` above): `spawn` can throw
  // SYNCHRONOUSLY on resource exhaustion (EMFILE), and `bufferedSpawn` lets that
  // propagate rather than folding it into a result. A failed *heal* must never
  // replace the caller's clean "still evicted, write refused" verdict with a
  // spawn error — the write is correctly refused either way.
  let result;
  try {
    result = await bufferedSpawn('brctl', ['download', path], { timeoutMs, shell: false });
  } catch (err) {
    result = { success: false, error: err };
  }
  if (result.success) return true;
  if (result.error?.code === 'ENOENT') {
    // Share the once-per-process flag with the fire-and-forget paths so the
    // "brctl missing" warning fires at most once across all of them.
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

// N concurrent callers for the same path share ONE underlying read, so they
// occupy at most one threadpool slot between them. The shared coalescer clears
// each slot as soon as the read settles, so a later call re-reads — this
// coalesces concurrency, it does not cache content.
let readFlight = createSingleFlight();

/**
 * `readFile`, but never against an evicted iCloud file.
 *
 * - Materialized (or not an iCloud path at all): a plain `readFile`.
 * - Evicted: kicks a background `brctl download` and rejects with
 *   `err.code === ICLOUD_NOT_MATERIALIZED` — the read is never issued, so no
 *   threadpool slot can be stranded.
 *
 * Concurrent calls for the same path share one read.
 *
 * Residual risk, accepted and bounded: eviction can still land in the window
 * between the `stat()` screen and the `readFile`. Single-flight caps the damage
 * at one threadpool slot per path rather than one per caller, and
 * `UV_THREADPOOL_SIZE` is raised in `ecosystem.config.cjs` so a stranded slot
 * doesn't starve the process.
 */
export async function readIfMaterialized(path, options = {}) {
  const { encoding = 'utf-8' } = options;
  // Key on encoding too: two concurrent callers asking for different encodings
  // must not share one result (a utf-8 string is not a base64 string).
  return readFlight.run(`${encoding}\u0000${path}`, () => guardedRead(path, options));
}

async function guardedRead(path, options) {
  const { encoding = 'utf-8', label = 'iCloud file' } = options;
  if (await isSuspectedDataless(path)) {
    requestMaterialization(path, { label });
    const err = new Error(`${label} is evicted from local storage (iCloud); refusing to block on read`);
    err.code = ICLOUD_NOT_MATERIALIZED;
    throw err;
  }
  return readFile(path, encoding);
}

/** Test hook: clear the one-shot warning + dedupe/single-flight state. */
export function _resetICloudFileStateForTest() {
  brctlMissingWarned = false;
  pendingDownloads.clear();
  readFlight = createSingleFlight();
  dirCloudCache.clear();
}
