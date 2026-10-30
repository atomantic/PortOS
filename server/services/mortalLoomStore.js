/**
 * MortalLoom iCloud store adapter.
 *
 * When "Use MortalLoom iCloud" is enabled in PortOS Settings, this module is
 * the single source of truth for all shared reads and writes. Both this PortOS
 * server and the MortalLoom iOS/macOS app read/write the same MortalLoom.json
 * in the app's iCloud ubiquity container, so adding data on either side shows
 * up on the other after iCloud sync completes.
 */

import { dashboardEvents } from './dashboardEvents.js';
import { homedir } from 'os';
import { join } from 'path';
import { stat } from 'fs/promises';
import { existsSync } from 'fs';
import { invalidateMeatspace, invalidateMortalLoomChanges } from './meatspaceEvents.js';
import { randomUUID } from 'crypto';
import { atomicWrite, safeJSONParse, readJSONFile, dataPath, ensureDir, sleep } from '../lib/fileUtils.js';
import { ICLOUD_NOT_MATERIALIZED, isEvictedStats, materializeAndWait, readIfMaterialized, requestMaterialization } from '../lib/icloudFile.js';
import { canonicalStringify, isPlainObject } from '../lib/objects.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { rowIdentityKeys, ROW_TOMBSTONES_KEY } from '../lib/meatspaceRowIdentity.js';
import { isTombstoned } from '../lib/tombstones.js';
import { queueHealthWrite } from './meatspaceWriteQueues.js';
import { getSettings, settingsEvents } from './settings.js';

const DEFAULT_ICLOUD_PATH = join(
  homedir(),
  'Library/Mobile Documents/iCloud~net~shadowpuppet~MeatSpaceTracker/Documents/MortalLoom.json'
);

// settings.json is shallow-merged and not schema-validated, so the path field
// can land here as any JSON shape (number, array, object, …). Calling .trim()
// on a non-string throws — and one of our call sites is an EventEmitter
// listener where an unhandled throw crashes the process. Centralize the
// "treat-as-string-or-fall-back" guard at every read.
function normalizePath(rawPath) {
  return (typeof rawPath === 'string' ? rawPath.trim() : '') || DEFAULT_ICLOUD_PATH;
}

// === Transient-error retry ===

// iCloud's `bird` daemon takes brief exclusive coordination locks during sync
// windows and on-demand materialization of evicted files. These surface as
// EAGAIN (errno -11), EDEADLK, EBUSY, or EIO from Node's fs calls. EBUSY and
// EIO are included because bird contention on busy iCloud paths (e.g. a large
// file mid-upload or a coordination handoff) can surface either code, and
// treating them as fatal would surface unnecessary errors to callers when a
// single retry is sufficient. 50ms + 100ms covers the common sub-200ms
// coordination windows without making transients observable.
// Exposed (not const) so tests can set it to `[0, 0]` to keep the retry path
// covered without paying the backoff sleep. (An empty array would still work
// — and run faster still — but it would disable the retry loop entirely,
// which defeats the purpose of testing the retry behavior.)
export let TRANSIENT_RETRY_DELAYS_MS = [50, 100];
export function _setRetryDelaysForTest(delays) { TRANSIENT_RETRY_DELAYS_MS = delays; }

function isTransientFsError(err) {
  if (!err) return false;
  const { code, errno } = err;
  return code === 'EAGAIN' || code === 'EDEADLK' || code === 'EBUSY' || code === 'EIO' || errno === -11;
}

/**
 * Run `fn()` (a thunk returning a Promise) with retry on transient iCloud
 * errors. Returns the resolved value on success; throws the original error on
 * the final failure so callers' existing `.catch()` handlers see the same
 * error shape as before. ENOENT and other non-transient errors bypass retry.
 */
async function withTransientRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    let caught = null;
    const result = await fn().catch((err) => { caught = err; });
    if (!caught) return result;
    if (!isTransientFsError(caught) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
      throw caught;
    }
    await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]);
  }
}

const APP_STORE_ID = '6760883701';
export const MORTALLOOM_APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

const ARRAY_KEYS = [
  'alcoholDrinks', 'alcoholPresets', 'bloodTests', 'bodyEntries',
  'epigeneticTests', 'eyeExams', 'goals', 'habits', 'healthMetrics',
  'nicotineEntries', 'nicotinePresets', 'saunaPresets', 'saunaSessions'
];

// === Eviction pinning ===

// macOS Optimize-Mac-Storage can evict iCloud files. When that happens the
// path still appears to exist (placeholder), but `readFile` returns EAGAIN
// because the read triggers an async download that doesn't return inline.
// `brctl download <path>` is the verb that materializes the file now. It is
// undocumented — absent from `brctl --help`, like its `evict` counterpart (see
// server/lib/icloudFile.js) — but present on every stock macOS and functional.
// It does NOT set a persistent retention flag against future eviction
// (that requires Finder's "Keep Downloaded" or undocumented `brctl unevict`),
// so re-eviction under future disk pressure is still possible — the retry-
// on-EAGAIN path handles that case. Best-effort, fire-and-forget; on
// non-macOS we never spawn brctl, and on macOS when brctl is unexpectedly
// missing (sandboxed env, removed binary) we warn ONCE and then fall
// through to the retry path silently.

let lastPinnedPath = null;
// Monotonic pin-attempt counter. Each pin captures its own generation so a stale
// child's late failure can be told apart from the CURRENT pin even when both share
// the same path (an A → B → A settings churn re-pins A while A's first child is
// still in flight). A path-only guard can't distinguish those two A children, so
// the first one's late failure would wrongly clear the second's sticky state and
// let the next event spawn a duplicate pin.
let pinGeneration = 0;

// The boot/settings-change pin. The spawn + detach/unref + error/exit handler
// plumbing (and the shared once-per-process "brctl missing" warning) all live in
// the shared `requestMaterialization` helper now — this call site only owns the
// pin's distinct dedupe policy: a single sticky `lastPinnedPath` that persists
// after a *successful* pin (one configured path at a time; re-pin only when the
// path changes). `retryAfterExit: false` keeps the shared helper from tracking
// the pin in its in-flight read-heal map. `onFailure` clears the sticky path so a
// failed / signal-killed pin can be retried on the next settings:updated — gated
// on the captured generation so only the CURRENT pin's own failure clears it (a
// superseded pin's late failure is ignored).
function pinAgainstEviction(path) {
  if (process.platform !== 'darwin') return;
  if (!path || lastPinnedPath === path) return;
  lastPinnedPath = path;
  const myGeneration = ++pinGeneration;
  const stillCurrent = () => pinGeneration === myGeneration;
  const spawned = requestMaterialization(path, {
    label: 'MortalLoom store',
    retryAfterExit: false,
    onFailure: () => { if (stillCurrent()) lastPinnedPath = null; },
  });
  // The helper declined to spawn (a non-iCloud configured path, or a synchronous
  // spawn failure — the non-darwin case is already handled above). Clear the
  // sticky path so a corrected/healable path on the next settings:updated isn't
  // wrongly deduped as "already pinned".
  if (!spawned && stillCurrent()) lastPinnedPath = null;
}

// === On-demand (blocking) materialization for the write path ===

// Eviction has exactly ONE representation this module has to handle: the modern
// APFS dataless vnode, where the path stays present and `readIfMaterialized`'s
// `stat()` screen catches it. This module used to also probe for macOS' pre-APFS
// `.MortalLoom.json.icloud` sibling stub; #3716 measured that representation as
// non-occurring and removed the probe — see the "only ONE representation"
// section in server/lib/icloudFile.js. An absent path is therefore genuinely
// absent here, safe to seed.

// Unlike the fire-and-forget pinAgainstEviction() at boot, the write path needs
// to KNOW an evicted file is materialized before deciding whether refusing to
// overwrite is warranted. `brctl download <path>` asks iCloud to materialize a
// dataless (Optimize-Mac-Storage-evicted) file.
//
// CRITICAL: exit 0 means the download was ACCEPTED/QUEUED, NOT that the bytes are
// local. brctl can return 0 before materialization completes, and returns 0 even
// when the sync layer ultimately can't fetch the file (device offline / iCloud
// wedged); under a wedged iCloud it can instead hang, which is why we await it
// with a timeout below. So a `true` here is NOT proof the file is readable. What
// keeps the caller's subsequent re-read safe is `readStoreAtPathResult`: it calls
// `readIfMaterialized`, which REJECTS rather than issuing a blocking read for a
// file it can't safely read — a still-dataless file rejects with
// ICLOUD_NOT_MATERIALIZED (its `Stats.blocks` screen) — and `readStoreAtPathResult`
// catches that and yields `store: null` (which `readStoreAtPath` unwraps). Either
// way the store stays null and the caller refuses to overwrite, so a false-
// positive `true` from here can't truncate data. (It does not eliminate the
// bounded eviction race documented in `readIfMaterialized`, which can still
// strand one threadpool slot per path — see server/lib/icloudFile.js — but this
// path never makes that worse.)
//
// We await brctl's exit (bounded by a timeout) and let the caller re-read.
// Resolves `true` only on a clean exit-0 — non-darwin, missing brctl, spawn
// error, timeout, and non-zero exit all resolve `false`, every one of which
// falls through to the caller's existing refuse-to-overwrite guard. So this can
// only ever recover the situation, never worsen it.
//
// Exposed (not const) so tests can drop the timeout without waiting on it.
export let MATERIALIZE_TIMEOUT_MS = 20000;
export function _setMaterializeTimeoutForTest(ms) { MATERIALIZE_TIMEOUT_MS = ms; }

// Unlike pinAgainstEviction, this awaits brctl to completion (timeout + kill-tree
// handled inside the shared helper). The timeout bounds a hung download (file
// evicted AND device offline) so a single write can't block forever. Resolves
// `true` only on a clean exit-0; every failure mode resolves `false` and falls
// through to the caller's existing refuse-to-overwrite guard.
//
// The mechanics live in `icloudFile.materializeAndWait` — Obsidian's `updateNote`
// needs the identical awaited-and-bounded materialize (#3706), so the second
// caller is what earned the extraction. The local `MATERIALIZE_TIMEOUT_MS` is
// passed explicitly rather than relying on the lib's default so this service
// keeps its own test hook.
async function materializeNow(path) {
  return materializeAndWait(path, {
    label: 'MortalLoom store',
    timeoutMs: MATERIALIZE_TIMEOUT_MS,
  });
}

// Two flags, not one: the listener is durable (sync, idempotent) but the
// initial-pin step does awaits that can reject transiently (settings.json
// read failure). Coupling them under a single `initialized = true` set
// BEFORE the await would mean a transient boot failure permanently disables
// the initial pin — even though the listener got attached and a retry would
// succeed. Splitting them lets a caller re-invoke initMortalLoomStore() to
// retry the initial pin without duplicating the listener.
let listenerAttached = false;
let didInitialPin = false;
// One server watcher for external iCloud changes, including atomic replacement
// and recovery after transient unreadability; never one poll per browser.
let watchedPath = null;
let storeWatchTimer = null;
let watchGeneration = 0;
function configureStoreWatcher(settings) {
  const path = settings?.mortalloom?.enabled ? normalizePath(settings.mortalloom.path) : null;
  if (path === watchedPath) return;
  if (storeWatchTimer) clearInterval(storeWatchTimer);
  storeWatchTimer = null;
  watchedPath = path;
  const generation = ++watchGeneration;
  if (!path) return;
  let previous = null;
  let pending = false;
  let dirty = false;
  const refresh = async () => {
    if (pending) { dirty = true; return; }
    pending = true;
    try {
      do {
        dirty = false;
        const result = await readStoreAtPathResult(path);
        if (generation !== watchGeneration) return;
        // Retain the last good snapshot through eviction/read failures.
        if (result.ok) {
          invalidateMortalLoomChanges(previous, result.store);
          if (JSON.stringify(previous?.goals) !== JSON.stringify(result.store?.goals)) {
            dashboardEvents.emit('goals:changed');
          }
          previous = structuredClone(result.store);
        }
      } while (dirty);
    } finally {
      pending = false;
    }
  };
  const changed = () => refresh().catch(err => console.error(`❌ MortalLoom change watcher failed: ${err.message}`));
  storeWatchTimer = setInterval(changed, 10_000);
  storeWatchTimer.unref?.();
  changed();
}

export function _resetMortalLoomInitForTest() {
  if (storeWatchTimer) clearInterval(storeWatchTimer);
  storeWatchTimer = null;
  watchedPath = null;
  watchGeneration += 1;
  listenerAttached = false;
  didInitialPin = false;
  lastPinnedPath = null;
  pinGeneration = 0;
  // The once-per-process "brctl missing" flag now lives in icloudFile; tests that
  // need it cleared reset it via icloudFile._resetICloudFileStateForTest().
}

/**
 * Boot hook: pin the configured MortalLoom store against iCloud eviction when
 * sync is enabled, and re-pin if the user later toggles sync on or changes the
 * path. Safe to call multiple times — the durable listener attaches at most
 * once, and the initial-pin step retries on subsequent calls if a prior call's
 * await rejected.
 */
export async function initMortalLoomStore() {
  // Attach the settings listener FIRST so even a transient failure in the
  // immediate-pin step below doesn't leave the system without
  // re-pin-on-settings-change. The listener has no async dependencies and is
  // the durable half of this hook.
  if (!listenerAttached) {
    settingsEvents.on('settings:updated', (settings) => {
      const nextPath = settings?.mortalloom?.enabled ? normalizePath(settings.mortalloom.path) : null;
      if (nextPath !== watchedPath) {
        configureStoreWatcher(settings);
        invalidateMeatspace(['overview', 'alcohol', 'body', 'blood', 'epigenetic', 'eyes', 'calendar']);
        dashboardEvents.emit('goals:changed');
      }
      if (!settings?.mortalloom?.enabled) {
        // Disable clears the dedup cache so a future re-enable (even with the
        // same path) triggers another materialize attempt — otherwise toggling
        // off → on with an unchanged path would silently no-op.
        lastPinnedPath = null;
        return;
      }
      pinAgainstEviction(normalizePath(settings.mortalloom.path));
    });
    listenerAttached = true;
  }

  if (didInitialPin) return;

  // The await below can throw under transient disk pressure on settings.json.
  // Only flip didInitialPin after it succeeds so a caller can retry the
  // boot pin on a subsequent invocation without re-attaching the listener.
  // Read settings ONCE and derive both enabled+path from the same snapshot —
  // a prior split into isMortalLoomEnabled() + resolvePath() did two reads
  // and could half-fail (first succeeds, second hits a transient and skips
  // the boot pin even though sync was confirmed enabled).
  const s = await getSettings();
  configureStoreWatcher(s);
  if (s?.mortalloom?.enabled) {
    pinAgainstEviction(normalizePath(s.mortalloom.path));
  }
  didInitialPin = true;
}

// === Core I/O ===

async function resolvePath() {
  const s = await getSettings();
  return normalizePath(s?.mortalloom?.path);
}

export async function isMortalLoomEnabled() {
  const s = await getSettings();
  return Boolean(s?.mortalloom?.enabled);
}

/**
 * Single-read snapshot of {enabled, path} from settings — collapses the prior
 * isMortalLoomEnabled() + readStore() → resolvePath() → getSettings() double-
 * read in every runtime helper into one settings I/O. Without this, the half-
 * fail window the boot-pin fix guards against (settings rejects transiently
 * between the two calls) is still live in the read path — first call says
 * "enabled", second call fails and the helper returns null even though sync
 * is on.
 *
 * Returns an explicit sentinel `{ enabled, ok, store }` (#2742) instead of a
 * bare store-or-null, because "sync disabled" and "sync enabled but the store
 * is unreadable" are NOT the same answer and callers that count records must be
 * able to tell them apart:
 *  - `{ enabled: false, ok: true,  store: null }` — sync off. Not a failure;
 *    fall through to the local file as always.
 *  - `{ enabled: true,  ok: true,  store: null }` — sync on, store genuinely
 *    absent (never written by either device). A trustworthy empty — fall
 *    through, same as an ENOENT on a local file.
 *  - `{ enabled: true,  ok: true,  store: {…} }` — sync on, store read.
 *  - `{ enabled: true,  ok: false, store: null }` — sync on but the store is
 *    present-and-unreadable (EACCES/EIO/corrupt JSON/unexpected shape). THIS is
 *    the case a strict caller must surface as `unavailable` rather than let it
 *    fall through to a possibly-ENOENT local file and score a fake 0 (the #2726
 *    fake-0 hole, one layer down — see #2742). `ok` is false ONLY here.
 */
async function readEnabledStore() {
  const s = await getSettings();
  if (!s?.mortalloom?.enabled) return { enabled: false, ok: true, store: null };
  const path = normalizePath(s.mortalloom.path);
  const { present, ok, store } = await readStoreAtPathResult(path);
  // `ok` collapses "readable" and "genuinely absent" into the single trustworthy
  // answer callers act on; only present-but-unreadable is a failure worth a throw.
  return { enabled: true, ok: ok || !present, store };
}

/**
 * Read + parse the store at `path`, distinguishing absent from unreadable so the
 * strict read path (#2742) can tell a trustworthy empty from a failure. Returns
 * `{ present, ok, store }`:
 *  - `{ present: false, ok: true,  store: null }` — file absent (ENOENT or
 *    `existsSync` false, incl. the existsSync→readFile race). Silent; a genuinely
 *    absent store is a trustworthy empty, not a failure.
 *  - `{ present: true,  ok: false, store: null }` — file present but unreadable:
 *    any non-ENOENT `readFile` failure (EAGAIN/EDEADLK/EACCES/unknown errno/etc.,
 *    warned once), corrupt JSON, or a top-level shape that isn't a plain object
 *    (array/string/number/boolean). Every consumer treats the store as
 *    `{ alcoholDrinks: [...], goals: [...], profile: {...}, … }`, so an unexpected
 *    shape is just as unavailable as a corrupt file.
 *  - `{ present: true,  ok: true,  store: {…} }` — read + parsed successfully.
 *
 * The broad "any error → unreadable" catch is intentional: non-strict read
 * consumers still treat a null store as "fall through to local data," and the
 * write side has its own overwrite guard, so suppressing a permission /
 * unexpected error here (for those callers) just loses the iCloud copy for one
 * cycle, never truncates the user's data. Strict callers are the ones that turn
 * `ok: false` into an explicit `unavailable`.
 */
// Reads of an evicted store arrive several times a second; one warning per window.
const EVICTED_WARN_INTERVAL_MS = 60_000;
let lastEvictedWarnAt = 0;
function warnEvictedOnce(detail) {
  const now = Date.now();
  if (now - lastEvictedWarnAt < EVICTED_WARN_INTERVAL_MS) return;
  lastEvictedWarnAt = now;
  console.log(`☁️ MortalLoom store evicted from local storage; ${detail}`);
}

async function readStoreAtPathResult(path) {
  // Attempt the read directly and classify from the error code rather than gating
  // on `existsSync` first (codex #2742 review): `existsSync` swallows its errno —
  // an un-traversable parent dir (EACCES) or an EIO returns `false`, which the old
  // guard could not tell from a genuine ENOENT and reported as trustworthy-absent,
  // letting a strict read fall through and score a fake 0. Reading first also
  // closes the existsSync→readFile TOCTOU where iCloud offloads the file between
  // the check and the read. `readFile`'s ENOENT is the ONLY genuine "absent".
  let unreadable = false;
  // `readIfMaterialized` — NOT a bare `readFile`. On modern macOS an evicted
  // (dataless) iCloud file does not fail with EAGAIN the way the retry logic
  // below assumes; the read BLOCKS forever in the kernel and strands a libuv
  // threadpool thread, and four of those take the entire server's filesystem
  // access down with them (see server/lib/icloudFile.js). The guard screens with
  // a `stat()` — which never materializes — and rejects with
  // ICLOUD_NOT_MATERIALIZED instead of issuing the read, kicking a background
  // `brctl download` so the next cycle succeeds.
  const raw = await withTransientRetry(() => readIfMaterialized(path, { label: 'MortalLoom store' })).catch((err) => {
    if (err.code === ICLOUD_NOT_MATERIALIZED) {
      // Present but evicted — never a trustworthy empty, so a strict read reports
      // `unavailable` and updateStore's guard refuses to seed over real data.
      warnEvictedOnce(`skipping read until iCloud materializes it: ${path}`);
      unreadable = true;
      return null;
    }
    if (err.code === 'ENOENT') {
      // Genuinely absent, and trustworthy as such: eviction cannot surface here.
      // A dataless file keeps its path and rejects with ICLOUD_NOT_MATERIALIZED
      // above, and the pre-APFS placeholder representation that WOULD read as
      // ENOENT does not occur (#3716 — see server/lib/icloudFile.js). Silent —
      // a missing store is normal, not warn-worthy.
      return null;
    }
    // Any other error (EACCES/EIO/EAGAIN/EDEADLK/unknown errno) is a store we could
    // not read — never a trustworthy empty.
    console.warn(`⚠️ MortalLoom store unavailable (${err.code || err.errno || 'unknown'}): ${path}`);
    unreadable = true;
    return null;
  });
  if (raw === null || raw === undefined) {
    return unreadable
      ? { present: true, ok: false, store: null }
      : { present: false, ok: true, store: null };
  }
  const parsed = safeJSONParse(raw, null, { context: path });
  if (!isPlainObject(parsed)) return { present: true, ok: false, store: null };
  return { present: true, ok: true, store: parsed };
}

/**
 * Store object or `null` — the pre-#2742 shape, kept for callers (readStore,
 * updateStore) that only need the parsed store and derive their own
 * absent-vs-unreadable handling (updateStore does its own existsSync check for
 * the overwrite guard).
 */
async function readStoreAtPath(path) {
  return (await readStoreAtPathResult(path)).store;
}

export async function readStore() {
  return readStoreAtPath(await resolvePath());
}

async function writeStoreAtPath(path, data) {
  await withTransientRetry(() => atomicWrite(path, data));
  dashboardEvents.emit('goals:changed');
}

// One tail for the whole store file: overlapping read → mutate → write cycles
// would otherwise read the same pre-image and drop each other's mutations.
const queueStoreWrite = createFileWriteQueue();

/** Atomic read → mutate → write, serialized per store. Ensures all array keys are initialized. */
export function updateStore(mutator) {
  return queueStoreWrite(() => updateStoreUnqueued(mutator));
}

async function updateStoreUnqueued(mutator) {
  // Resolve the path once and pass it through to both read and write — settings
  // could change mid-call, so we'd otherwise risk reading from one path and
  // writing to another (or the overwrite-guard's existsSync looking at a
  // different file than the read).
  const path = await resolvePath();
  let store = await readStoreAtPath(path);
  // The overwrite guard is based solely on post-read state, not a pre-read
  // snapshot. readStoreAtPath returns null for several reasons; we only care
  // about the *currently observable* state when deciding whether it's safe
  // to write:
  //   (1) file does not exist now → safe to seed a fresh store (whether it was
  //       absent the whole time, disappeared mid-call, or never appeared in the
  //       first place). An absent path is unambiguously absent: the only eviction
  //       representation that would hide real data behind a false `existsSync` is
  //       the pre-APFS `.icloud` placeholder, which does not occur (#3716).
  //   (2) file exists now but parsed to a non-plain-object value → unreadable
  //       (transient iCloud read failure, corrupt JSON, or unexpected shape
  //       like a top-level array which JSON.stringify would silently drop).
  // For (2) the most common cause on macOS is iCloud eviction
  // (Optimize-Mac-Storage made the file dataless and the sub-200ms transient
  // retry isn't long enough to materialize it). Before refusing — which blocks
  // the user's write — force a BLOCKING `brctl download` and re-read once. This
  // is the on-demand pre-warm the fire-and-forget boot pin can't guarantee
  // hours after boot, when the file has been re-evicted under disk pressure.
  // Only genuinely corrupt JSON / unexpected shapes / offline-evicted files
  // survive to the throw. Without this guard, the iCloud transient-failure
  // tolerance in readStoreAtPath would let updateStore silently truncate a
  // momentarily unreadable iCloud file.
  const unsafeToSeed = existsSync(path) && !isPlainObject(store);
  if (unsafeToSeed) {
    // `materializeNow` resolving `true` only means brctl ACCEPTED the download
    // request (exit 0), NOT that the bytes are local — see its docblock. Do NOT
    // remove the re-read's screening on the strength of that `true`: `readStoreAtPath`
    // → `readStoreAtPathResult` calls `readIfMaterialized`, which REJECTS instead of
    // issuing a blocking read for a file it can't safely read — a still-dataless file
    // rejects on the `stat()` re-screen — and `readStoreAtPathResult` catches that
    // and returns `store: null`. Either way store stays null and we refuse rather
    // than reading blindly (which is what would risk stranding a threadpool slot).
    const materialized = await materializeNow(path);
    if (materialized) {
      store = await readStoreAtPath(path);
      console.log(`📥 MortalLoom store iCloud download requested before write: ${path}`);
    }
    if (!isPlainObject(store)) {
      // Log the resolved path server-side for diagnostics; keep the thrown
      // message path-free so it doesn't get echoed back to the UI (route
      // errors serialize as `error: error.message`).
      console.error(`❌ MortalLoom store at ${path} is unreadable${materialized ? ' even after iCloud materialize' : ''}; refusing to overwrite`);
      throw new Error('MortalLoom store is unreadable; refusing to overwrite');
    }
  }
  const base = store || {};
  for (const k of ARRAY_KEYS) if (!Array.isArray(base[k])) base[k] = [];
  const before = structuredClone(base);
  const result = await mutator(base);
  await writeStoreAtPath(path, base);
  invalidateMortalLoomChanges(before, base);
  return result;
}

/** Uppercase UUID v4 — matches MortalLoom's iOS/macOS id format. */
export const newMortalLoomId = () => randomUUID().toUpperCase();

// === High-level entity helpers ===

/** Push a new record (minted id if absent) onto an array key. Returns the stored record. */
export async function mlPush(key, record) {
  const stored = { id: newMortalLoomId(), ...record };
  await updateStore(store => { store[key].push(stored); });
  return stored;
}

export async function mlPatchById(key, id, updates, { expectedDate } = {}) {
  return updateStore(store => {
    const item = store[key].find(r => r.id === id);
    if (!item || (expectedDate !== undefined && item.date !== expectedDate)) return null;
    Object.assign(item, updates);
    return item;
  });
}

export async function mlRemoveById(key, id, { expectedDate } = {}) {
  return updateStore(store => {
    const i = store[key].findIndex(r => r.id === id && (expectedDate === undefined || r.date === expectedDate));
    if (i < 0) return null;
    return store[key].splice(i, 1)[0];
  });
}

/** Remove every record in `key` for which `predicate` is true. Returns the removed rows. */
export async function mlRemoveWhere(key, predicate) {
  return updateStore(store => {
    if (!Array.isArray(store[key])) return [];
    const removed = [];
    store[key] = store[key].filter(row => {
      if (!predicate(row)) return true;
      removed.push(row);
      return false;
    });
    return removed;
  });
}

export async function mlReplace(key, array) {
  await updateStore(store => { store[key] = array; });
}

// === Profile (HealthProfile mirror: biologicalSex, birthDate, lifestyle, …) ===

/** Returns `store.profile` when MortalLoom sync is enabled, else null. */
export async function mlGetProfileIfEnabled() {
  const { store } = await readEnabledStore();
  return (store && typeof store.profile === 'object') ? store.profile : null;
}

/**
 * Deep-merge `patch` onto `store.profile` when sync is enabled; no-op otherwise.
 * Nested objects (`lifestyle`, `locationProfile`, `socioeconomic`) are merged field-wise
 * so callers can patch a single field without clobbering the rest.
 */
export async function mlPatchProfileIfEnabled(patch) {
  if (!(await isMortalLoomEnabled())) return null;
  return updateStore(store => {
    const current = (store.profile && typeof store.profile === 'object') ? store.profile : {};
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (isPlainObject(v) && current[k] && typeof current[k] === 'object') {
        next[k] = { ...current[k], ...v };
      } else {
        next[k] = v;
      }
    }
    store.profile = next;
    return next;
  });
}

/**
 * Upsert a HealthMetricEntry by date — merges non-null fields into the
 * existing entry for that date, or appends a new one. Mirrors Swift's
 * DataStore.upsertHealthMetric + HealthMetricEntry.mergeFields.
 */
export async function mlUpsertHealthMetricByDate(date, patch) {
  return updateStore(store => {
    const existing = store.healthMetrics.find(m => m.date === date);
    if (existing) {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && v !== null) existing[k] = v;
      }
      return existing;
    }
    const created = { id: newMortalLoomId(), date, ...patch };
    store.healthMetrics.push(created);
    return created;
  });
}

/**
 * Delete health-metric fields outright. `mlUpsertHealthMetricByDate` skips
 * null, so a clear has to remove the keys. An entry left with nothing but
 * `id` and `date` is dropped.
 */
export async function mlClearHealthMetricFields(date, keys) {
  return updateStore(store => {
    const existing = store.healthMetrics.find(row => row.date === date);
    if (!existing) return null;
    const removed = {};
    for (const key of keys) {
      if (existing[key] !== undefined && existing[key] !== null) {
        removed[key] = existing[key];
        delete existing[key];
      }
    }
    if (Object.keys(removed).length === 0) return null;
    const leftover = Object.keys(existing).filter(key => key !== 'id' && key !== 'date');
    if (leftover.length === 0) {
      store.healthMetrics.splice(store.healthMetrics.indexOf(existing), 1);
    }
    return { date, ...removed };
  });
}

/**
 * Fold FHIR lab rows into `bloodTests` by date. Existing marker keys are kept.
 * A new date is minted with an id and `createdAt`.
 */
export async function mlMergeClinicalBloodTests(fhirTests) {
  return updateStore(store => {
    let newDates = 0;
    for (const fhirTest of Array.isArray(fhirTests) ? fhirTests : []) {
      if (!isPlainObject(fhirTest) || typeof fhirTest.date !== 'string') continue;
      const { date, id: _id, createdAt: _createdAt, updatedAt: _updatedAt, aliasIds: _aliasIds, markers: _markers, ...values } = fhirTest;
      const existing = store.bloodTests.find(row => row.date === date);
      if (existing) {
        const markers = isPlainObject(existing.markers) ? existing.markers : {};
        for (const [key, value] of Object.entries(values)) {
          if (markers[key] === undefined && existing[key] === undefined) markers[key] = value;
        }
        existing.markers = markers;
      } else {
        store.bloodTests.push({
          id: newMortalLoomId(),
          date,
          createdAt: new Date().toISOString(),
          markers: values,
        });
        newDates += 1;
      }
    }
    const tests = store.bloodTests.map(({ id, markers, ...rest }) => ({
      ...rest,
      ...(isPlainObject(markers) ? markers : {}),
      ...(id ? { id } : {}),
    }));
    return { newDates, tests };
  });
}

/**
 * Alcohol/nicotine use (date, positional-index) addressing in the PortOS daily-log.
 * Return the id of the N-th record in store[key] with the given date (in stored order).
 */
export async function mlIdAtDateIndex(key, date, index) {
  const { store } = await readEnabledStore();
  if (!store || !Array.isArray(store[key])) return null;
  const sameDate = store[key].filter(r => r.date === date);
  return sameDate[index]?.id ?? null;
}

// === Read-side convenience ===

/**
 * Returns an array for `key` from the store when enabled, else null (fall
 * through to local).
 *
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when sync is
 *   enabled but the store is present-and-unreadable, instead of returning null
 *   and letting the caller fall through to a local file that may be a genuine
 *   ENOENT and score a fake 0 (#2742). Off by default so every existing UI read
 *   keeps the swallow-and-fall-through behavior.
 *
 *   Semantic note (the question #2742 flagged): when the store is enabled and
 *   READABLE but simply has no array for `key` (the user never created records
 *   of this kind on either device), we return null and fall through to local
 *   even under strict. The store IS the source of truth and we consulted it
 *   successfully — a missing key is a legitimate "no such records," and the
 *   local file is its mirror, so the local read's own strictness (a genuine
 *   ENOENT there is a trustworthy 0) decides the outcome. Only a store we could
 *   not READ is a failure.
 */
export async function mlArrayIfEnabled(key, { strict = false } = {}) {
  const { enabled, ok, store } = await readEnabledStore();
  if (strict && enabled && !ok) {
    throw new Error(`MortalLoom store unreadable for key: ${key}`);
  }
  if (!store) return null;
  const value = store[key];
  if (Array.isArray(value)) return value;
  // A key that is PRESENT but not an array (`goals: {}`, `bodyEntries: "bad"`) is
  // corruption, not the legitimate "no such records" of an omitted key — under
  // strict it must surface as a failure rather than read as an omitted-key
  // fall-through and score a fake 0 (codex #2742 review). Non-strict keeps falling
  // through to the local mirror for both, as before.
  if (strict && enabled && value !== undefined) {
    throw new Error(`MortalLoom key ${key} is present but not an array`);
  }
  return null;
}

// === Daily-log composition (alcohol + nicotine records → day-keyed log) ===

export function buildDailyLogFromMortalLoom(store) {
  const empty = { entries: [], lastEntryDate: null };
  if (!store || typeof store !== 'object') return empty;

  const byDate = new Map();
  const entryFor = d => (byDate.get(d) ?? byDate.set(d, { date: d }).get(d));

  for (const d of (store.alcoholDrinks || [])) {
    if (!d?.date) continue;
    const e = entryFor(d.date);
    if (!e.alcohol) e.alcohol = { drinks: [], standardDrinks: 0 };
    const oz = Number(d.oz) || 0, abv = Number(d.abv) || 0, count = Number(d.count) || 1;
    e.alcohol.drinks.push({ name: d.name || '', oz, abv, count });
    e.alcohol.standardDrinks = Math.round((e.alcohol.standardDrinks + (oz * count * (abv / 100)) / 0.6) * 100) / 100;
  }

  for (const n of (store.nicotineEntries || [])) {
    if (!n?.date) continue;
    const e = entryFor(n.date);
    if (!e.nicotine) e.nicotine = { items: [], totalMg: 0 };
    const mgPerUnit = Number(n.mgPerUnit) || 0, count = Number(n.count) || 1;
    e.nicotine.items.push({ product: n.product || '', mgPerUnit, count });
    e.nicotine.totalMg = Math.round((e.nicotine.totalMg + mgPerUnit * count) * 100) / 100;
  }

  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { entries, lastEntryDate: entries.at(-1)?.date || null };
}

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when sync is
 *   enabled but the store is present-and-unreadable, instead of returning null
 *   and letting the caller fall through to a local daily-log that may be a
 *   genuine ENOENT and score a fake 0 (#2742). Off by default. A readable store
 *   with no alcohol/nicotine records still returns a real (empty) daily log, not
 *   null, so it does not fall through.
 */
export async function readDailyLogIfEnabled({ strict = false } = {}) {
  const { enabled, ok, store } = await readEnabledStore();
  if (strict && enabled && !ok) {
    throw new Error('MortalLoom store unreadable for daily log');
  }
  if (!store) return null;
  // The daily log is composed from two arrays; buildDailyLogFromMortalLoom
  // silently degrades a wrong-typed field to empty (a truthy string iterates as
  // chars, etc.). Under strict a PRESENT-but-non-array source is corruption, not
  // an empty day — throw rather than compose a fake-empty log (codex #2742 review).
  if (strict && enabled) {
    for (const key of ['alcoholDrinks', 'nicotineEntries']) {
      if (store[key] !== undefined && !Array.isArray(store[key])) {
        throw new Error(`MortalLoom ${key} is present but not an array`);
      }
    }
  }
  return buildDailyLogFromMortalLoom(store);
}

// === Status / import (used by Settings UI) ===

export async function getStatus() {
  const s = await getSettings();
  const path = normalizePath(s?.mortalloom?.path);
  const enabled = Boolean(s?.mortalloom?.enabled);
  const missingResponse = {
    enabled, path, usingDefault: path === DEFAULT_ICLOUD_PATH, defaultPath: DEFAULT_ICLOUD_PATH,
    exists: false, size: 0, mtime: null, summary: null, appStoreUrl: MORTALLOOM_APP_STORE_URL,
  };
  if (!existsSync(path)) return missingResponse;
  // Same transient-iCloud-failure tolerance as readStoreAtPath() — surface a
  // null summary instead of 500ing the Settings status page. ENOENT (file
  // disappeared between existsSync and stat/readFile) collapses back to the
  // "missing" response; only genuinely transient errors keep `exists:true`.
  let statTransient = false;
  const st = await withTransientRetry(() => stat(path)).catch((err) => {
    if (err.code === 'ENOENT') return null;
    statTransient = true;
    console.warn(`⚠️ MortalLoom status stat unavailable (${err.code || err.errno || 'unknown'}): ${path}`);
    return null;
  });
  if (!st && !statTransient) return missingResponse;
  let readEnoent = false;
  // An evicted (dataless) store must NOT be read — the read would block forever
  // and strand a libuv threadpool thread, taking the whole server's filesystem
  // access down with it (see server/lib/icloudFile.js). Reuse the `stat` we
  // already have rather than paying a second one. `size`/`mtime` stay accurate
  // for a dataless file, so the UI still reports a real file with a null
  // summary — the same "store unavailable" shape it already renders.
  // `isEvictedStats`, not the bare `isDatalessStats`: the dataless signal alone
  // also matches a sparse/compressed ordinary file, so an unscoped check would
  // permanently report "unavailable" for a store that `readStore()` is reading
  // fine. Kick the same background heal the read path does, so a user staring at
  // the Settings page isn't waiting on some unrelated code path to trigger it.
  const evicted = isEvictedStats(path, st);
  if (evicted) {
    warnEvictedOnce(`status summary unavailable: ${path}`);
    requestMaterialization(path, { label: 'MortalLoom store' });
  }
  const raw = st && !evicted ? await withTransientRetry(() => readIfMaterialized(path, { label: 'MortalLoom store' })).catch((err) => {
    if (err.code === 'ENOENT') { readEnoent = true; return null; }
    console.warn(`⚠️ MortalLoom status read unavailable (${err.code || err.errno || 'unknown'}): ${path}`);
    return null;
  }) : null;
  // readFile ENOENT after a successful stat means the file was deleted/moved
  // between the two calls — collapse to the missing response so the endpoint
  // doesn't advertise a phantom file with stale stat metadata.
  if (readEnoent) return missingResponse;
  const parsed = raw === null ? null : safeJSONParse(raw, null);
  // Only compute a summary when the top-level JSON is a plain `{…}` shape.
  // An unexpected top-level array would otherwise pass `typeof === 'object'`
  // and we'd render a misleading 0-count summary instead of `null` (which
  // the UI distinguishes as "store unavailable").
  const data = isPlainObject(parsed) ? parsed : null;
  const count = k => Array.isArray(data?.[k]) ? data[k].length : 0;
  return {
    enabled, path, usingDefault: path === DEFAULT_ICLOUD_PATH, defaultPath: DEFAULT_ICLOUD_PATH,
    exists: true, size: st?.size ?? 0, mtime: st?.mtime?.toISOString() ?? null,
    summary: data ? {
      goals: count('goals'),
      alcoholDrinks: count('alcoholDrinks'),
      nicotineEntries: count('nicotineEntries'),
      bloodTests: count('bloodTests'),
      bodyEntries: count('bodyEntries'),
      epigeneticTests: count('epigeneticTests'),
      eyeExams: count('eyeExams'),
      saunaSessions: count('saunaSessions'),
      hasProfile: Boolean(data.profile),
      hasGenome: Boolean(data.genomeScanRecord)
    } : null,
    appStoreUrl: MORTALLOOM_APP_STORE_URL
  };
}

// Native MortalLoom substance arrays → the `daily-log.json` tenants the local
// alcohol/nicotine readers consume. Item normalization mirrors
// buildDailyLogFromMortalLoom so an imported day reads the same as the iCloud view.
const IMPORT_SUBSTANCES = [
  {
    mlKey: 'alcoholDrinks', key: 'alcohol', itemsField: 'drinks', totalField: 'standardDrinks',
    toItem: ({ name, oz, abv, count }) => ({ name: name || '', oz: Number(oz) || 0, abv: Number(abv) || 0, count: Number(count) || 1 }),
  },
  {
    mlKey: 'nicotineEntries', key: 'nicotine', itemsField: 'items', totalField: 'totalMg',
    toItem: ({ product, mgPerUnit, count }) => ({ product: product || '', mgPerUnit: Number(mgPerUnit) || 0, count: Number(count) || 1 }),
  },
];

/**
 * Merge native alcohol/nicotine/body rows into a local daily log in place.
 * Identity is the native event id (two ids with equal content stay distinct); a
 * locally tombstoned id is never re-added. Id-less rows match id-less local items
 * of the same day by content as a multiset, so a retry adds nothing while two
 * identical id-less drinks still import as two. Body fields are fill-only per
 * date: a field the local day already holds is a local edit and wins.
 */
function mergeNativeDailyRecords(log, store, { tombstones, computeTotals }) {
  const report = { added: {}, skipped: {} };
  const entryFor = (date) => {
    let entry = log.entries.find(e => e.date === date);
    if (!entry) { entry = { date }; log.entries.push(entry); }
    return entry;
  };
  const touched = new Set();
  for (const { mlKey, key, itemsField, toItem } of IMPORT_SUBSTANCES) {
    const rows = store[mlKey] || [];
    let added = 0, skipped = 0;
    const localItems = log.entries.flatMap(e => (Array.isArray(e[key]?.[itemsField]) ? e[key][itemsField] : []).map(item => [e.date, item]));
    const seenIds = new Set(localItems.map(([, item]) => item?.id).filter(id => typeof id === 'string' && id));
    const unmatchedContent = new Map();
    for (const [date, item] of localItems) {
      if (item?.id) continue;
      const contentKey = `${date}\u0000${canonicalStringify(toItem(item || {}))}`;
      unmatchedContent.set(contentKey, (unmatchedContent.get(contentKey) || 0) + 1);
    }
    for (const row of rows) {
      if (!row.date) { skipped++; continue; }
      const { id, date, ...fields } = row;
      const item = toItem(fields);
      if (id) {
        if (seenIds.has(id) || isTombstoned(tombstones, id, undefined, 'id')) { skipped++; continue; }
        seenIds.add(id);
      } else {
        const contentKey = `${date}\u0000${canonicalStringify(item)}`;
        const available = unmatchedContent.get(contentKey) || 0;
        if (available > 0) { unmatchedContent.set(contentKey, available - 1); skipped++; continue; }
      }
      const entry = entryFor(date);
      if (!isPlainObject(entry[key]) || !Array.isArray(entry[key][itemsField])) entry[key] = { ...(isPlainObject(entry[key]) ? entry[key] : {}), [itemsField]: [] };
      // Keep native fields the local shape does not name (stamps, app-only metadata).
      entry[key][itemsField].push({ ...fields, ...item, ...(id ? { id } : {}) });
      touched.add(entry);
      added++;
    }
    report.added[mlKey] = added; report.skipped[mlKey] = skipped;
  }
  for (const entry of touched) computeTotals(entry);

  let bodyAdded = 0, bodySkipped = 0;
  for (const row of store.bodyEntries || []) {
    const { id: _id, date, ...fields } = row;
    if (!date) { bodySkipped++; continue; }
    const existing = log.entries.find(e => e.date === date);
    const body = isPlainObject(existing?.body) ? existing.body : {};
    const fill = Object.entries(fields).filter(([field, value]) => value != null && body[field] === undefined);
    if (fill.length === 0) { bodySkipped++; continue; }
    const entry = existing || entryFor(date);
    entry.body = { ...body, ...Object.fromEntries(fill) };
    bodyAdded++;
  }
  report.added.bodyEntries = bodyAdded; report.skipped.bodyEntries = bodySkipped;
  return report;
}

/**
 * Non-destructive import: add MortalLoom records missing from the local stores
 * the normal MeatSpace readers consume. Alcohol, nicotine and body rows land in
 * `daily-log.json`; the profile fills `config.json`. Legacy per-domain copies an
 * older import wrote are left untouched.
 */
export async function importToPortOS() {
  // Use the {present, ok} result, not readStore()'s store-or-null: an evicted
  // store is present-but-unreadable, and reporting it as "file not found" is the
  // one message most likely to make the user repoint the path or re-seed — burying
  // the real data this module works to protect.
  const { present, ok, store } = await readStoreAtPathResult(await resolvePath());
  if (present && !ok) return { ok: false, reason: 'mortalloom-file-unreadable' };
  if (!store) return { ok: false, reason: 'mortalloom-file-not-found' };

  const report = { added: {}, skipped: {} };
  const dailyKeys = ['alcoholDrinks', 'nicotineEntries', 'bodyEntries'];
  const collectionFiles = [
    ['bloodTests', 'blood-tests.json', 'tests'],
    ['epigeneticTests', 'epigenetic-tests.json', 'tests'],
    ['eyeExams', 'eyes.json', 'exams'],
    ['saunaSessions', 'sauna-sessions.json'],
    ['habits', 'habits.json'],
    ['healthMetrics', 'health-metrics.json', 'entries']
  ];
  const assertRows = (rows, label) => {
    if (!Array.isArray(rows) || rows.some(row => !isPlainObject(row)
      || (row.date != null && typeof row.date !== 'string')
      || (row.id != null && typeof row.id !== 'string'))) {
      throw new Error(`MortalLoom import ${label} malformed`);
    }
  };
  // Validate the whole input before even goals can be committed.
  for (const key of ['goals', ...dailyKeys, ...collectionFiles.map(([key]) => key)]) {
    if (store[key] !== undefined) assertRows(store[key], key);
  }
  for (const row of store.bloodTests || []) {
    const reserved = ['id', 'date', 'createdAt', 'updatedAt', 'aliasIds', 'markers'];
    if (row.markers != null && (!isPlainObject(row.markers)
      || reserved.some(key => Object.hasOwn(row.markers, key)))) {
      throw new Error('MortalLoom import blood markers malformed');
    }
  }
  if ((store.healthMetrics || []).some(row => !row.date)) {
    throw new Error('MortalLoom import health metric date malformed');
  }
  const profile = isPlainObject(store.profile) ? store.profile : null;
  const hasDaily = dailyKeys.some(key => store[key]?.length);
  const [dailyLog, meatspaceConfig] = await Promise.all([
    import('./meatspaceDailyLog.js'),
    import('./meatspace.js'),
  ]);
  const readDestination = async ({ localPath, fileName, arrayKey }) => {
    const document = await readJSONFile(localPath, arrayKey ? { [arrayKey]: [] } : [], { strict: true });
    if (arrayKey && !isPlainObject(document)) {
      throw new Error(`MortalLoom import ${fileName} malformed`);
    }
    const rows = arrayKey ? document[arrayKey] : document;
    assertRows(rows, fileName);
    return { document, rows };
  };
  // Preflight all destinations before the first write; one unreadable local file
  // must not turn the import into an unreported partially applied batch. These
  // snapshots are validation only: the queued write re-reads the current rows.
  const collections = await Promise.all(collectionFiles.map(async ([mlKey, fileName, arrayKey]) => {
    const mlArr = store[mlKey] || [];
    const collection = { mlKey, mlArr, fileName, arrayKey, localPath: dataPath('meatspace', fileName) };
    if (mlArr.length) await readDestination(collection);
    return collection;
  }));
  if (hasDaily) await dailyLog.readLocalDailyLog({ strict: true, label: 'MortalLoom import' });
  if (profile) await meatspaceConfig.readStoredConfig();
  const mergeById = async (collection) => queueHealthWrite(async () => {
    const { mlKey, mlArr, localPath, arrayKey } = collection;
    const { document, rows } = await readDestination(collection);
    const keysFor = row => arrayKey
      ? (mlKey === 'healthMetrics' ? [row.date] : rowIdentityKeys(row))
      : [row.id || canonicalStringify(row)];
    const seen = new Set(rows.flatMap(keysFor));
    let added = 0, skipped = 0;
    for (const item of mlArr) {
      // MortalLoom nests blood markers; the local reader consumes flat fields.
      const { markers, ...rest } = item;
      const row = mlKey === 'bloodTests' ? { ...(markers || {}), ...rest } : item;
      const keys = keysFor(row);
      if (keys.some(key => seen.has(key) || isTombstoned(document[ROW_TOMBSTONES_KEY], key, undefined, 'id'))) {
        skipped++;
        continue;
      }
      rows.push(row);
      keys.forEach(key => seen.add(key));
      added++;
    }
    if (added > 0) {
      rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      await ensureDir(dataPath('meatspace'));
      await atomicWrite(localPath, arrayKey ? { ...document, [arrayKey]: rows } : rows);
    }
    return { added, skipped };
  });

  // Goals live in a wrapper object, not a bare array
  const { editGoals } = await import('./identity/store.js');
  await editGoals(localGoals => {
    const seenGoalIds = new Set((localGoals.goals || []).map(g => g.id));
    let added = 0, skipped = 0;
    for (const goal of (store.goals || [])) {
      if (seenGoalIds.has(goal.id)) { skipped++; continue; }
      localGoals.goals.push(goal);
      seenGoalIds.add(goal.id);
      added++;
    }
    if (added > 0) localGoals.updatedAt = new Date().toISOString();
    report.added.goals = added;
    report.skipped.goals = skipped;
  }, { localOnly: true });

  for (const collection of collections) {
    const { mlKey, mlArr } = collection;
    if (mlArr.length === 0) { report.added[mlKey] = 0; report.skipped[mlKey] = 0; continue; }
    const { added, skipped } = await mergeById(collection);
    report.added[mlKey] = added; report.skipped[mlKey] = skipped;
  }

  if (hasDaily) {
    const { computeStandardDrinks } = await import('./meatspaceAlcohol.js');
    // Day totals are recomputed from the full retained item list, with the same
    // per-item formulas the alcohol/nicotine services use on a local write.
    const itemTotals = {
      alcohol: item => computeStandardDrinks((item.oz || 0) * (item.count || 1), item.abv || 0),
      nicotine: item => (item.mgPerUnit ?? 0) * (item.count ?? 1),
    };
    const computeTotals = (entry) => {
      for (const { key, itemsField, totalField } of IMPORT_SUBSTANCES) {
        const items = entry[key]?.[itemsField];
        if (Array.isArray(items)) entry[key][totalField] = Math.round(items.reduce((sum, item) => sum + itemTotals[key](item), 0) * 100) / 100;
      }
    };
    let merged;
    // Merge under the daily-log queue against a fresh read, so local writes and
    // overlapping imports committed after preflight are kept; a no-op retry skips the write.
    await dailyLog.mutateDailyLog((log) => {
      merged = mergeNativeDailyRecords(log, store, {
        tombstones: log[dailyLog.DAILY_LOG_TOMBSTONES_KEY], computeTotals,
      });
      return Object.values(merged.added).some(n => n > 0) ? merged : null;
    }, { label: 'MortalLoom import' });
    Object.assign(report.added, merged.added);
    Object.assign(report.skipped, merged.skipped);
  } else {
    for (const key of dailyKeys) { report.added[key] = 0; report.skipped[key] = 0; }
  }

  invalidateMeatspace(['overview', 'blood', 'epigenetic', 'eyes', 'body', 'alcohol']);

  if (profile) {
    const { filled } = await meatspaceConfig.fillConfigFromMortalLoomProfile(profile);
    report.added.profile = filled.length > 0 ? 1 : 0;
    report.skipped.profile = filled.length > 0 ? 0 : 1;
  }

  report.ok = true;
  report.importedAt = new Date().toISOString();
  return report;
}
