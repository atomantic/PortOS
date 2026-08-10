/**
 * MortalLoom iCloud store adapter.
 *
 * When "Use MortalLoom iCloud" is enabled in PortOS Settings, this module is
 * the single source of truth for all shared reads and writes. Both this PortOS
 * server and the MortalLoom iOS/macOS app read/write the same MortalLoom.json
 * in the app's iCloud ubiquity container, so adding data on either side shows
 * up on the other after iCloud sync completes.
 */

import { homedir } from 'os';
import { join } from 'path';
import { stat } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { atomicWrite, safeJSONParse, readJSONFile, dataPath, ensureDir } from '../lib/fileUtils.js';
import { ICLOUD_NOT_MATERIALIZED, isEvictedStats, materializeAndWait, readIfMaterialized, requestMaterialization } from '../lib/icloudFile.js';
import { isPlainObject } from '../lib/objects.js';
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
    await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAYS_MS[attempt]));
  }
}

const APP_STORE_ID = '6760883701';
export const MORTALLOOM_APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

const ARRAY_KEYS = [
  'alcoholDrinks', 'alcoholPresets', 'bloodTests', 'bodyEntries',
  'epigeneticTests', 'eyeExams', 'goals', 'habits', 'healthMetrics',
  'nicotineEntries', 'nicotinePresets', 'saunaPresets', 'saunaSessions'
];

export function defaultStorePath() { return DEFAULT_ICLOUD_PATH; }

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

export function _resetMortalLoomInitForTest() {
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
      console.warn(`⚠️ MortalLoom store evicted from local storage; skipping read until iCloud materializes it: ${path}`);
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
}

/** Atomic read → mutate → write. Ensures all array keys are initialized. */
export async function updateStore(mutator) {
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
  const result = await mutator(base);
  await writeStoreAtPath(path, base);
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

export async function mlPatchById(key, id, updates) {
  return updateStore(store => {
    const item = store[key].find(r => r.id === id);
    if (!item) return null;
    Object.assign(item, updates);
    return item;
  });
}

export async function mlRemoveById(key, id) {
  return updateStore(store => {
    const i = store[key].findIndex(r => r.id === id);
    if (i < 0) return null;
    return store[key].splice(i, 1)[0];
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
    console.warn(`⚠️ MortalLoom store evicted from local storage; status summary unavailable: ${path}`);
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

/** Non-destructive import: append MortalLoom records missing from PortOS local files. */
export async function importToPortOS() {
  // Use the {present, ok} result, not readStore()'s store-or-null: an evicted
  // store is present-but-unreadable, and reporting it as "file not found" is the
  // one message most likely to make the user repoint the path or re-seed — burying
  // the real data this module works to protect.
  const { present, ok, store } = await readStoreAtPathResult(await resolvePath());
  if (present && !ok) return { ok: false, reason: 'mortalloom-file-unreadable' };
  if (!store) return { ok: false, reason: 'mortalloom-file-not-found' };

  const report = { added: {}, skipped: {} };
  const mergeById = async (mlArr, localPath, pathDir) => {
    const local = await readJSONFile(localPath, []);
    const localArr = Array.isArray(local) ? local : [];
    const seen = new Set(localArr.map(x => x.id).filter(Boolean));
    let added = 0, skipped = 0;
    for (const item of mlArr) {
      if (item?.id && seen.has(item.id)) { skipped++; continue; }
      localArr.push(item); added++;
    }
    if (added > 0) {
      await ensureDir(pathDir);
      await atomicWrite(localPath, localArr);
    }
    return { added, skipped };
  };

  // Goals live in a wrapper object, not a bare array
  const goalsPath = dataPath('digital-twin', 'goals.json');
  const localGoals = await readJSONFile(goalsPath, { goals: [] });
  const seenGoalIds = new Set((localGoals.goals || []).map(g => g.id));
  let gAdded = 0, gSkipped = 0;
  for (const g of (store.goals || [])) {
    if (seenGoalIds.has(g.id)) { gSkipped++; continue; }
    localGoals.goals.push(g); gAdded++;
  }
  if (gAdded > 0) {
    await ensureDir(dataPath('digital-twin'));
    localGoals.updatedAt = new Date().toISOString();
    await atomicWrite(goalsPath, localGoals);
  }
  report.added.goals = gAdded; report.skipped.goals = gSkipped;

  for (const [mlKey, fileName] of [
    ['alcoholDrinks', 'alcohol-drinks.json'],
    ['nicotineEntries', 'nicotine-entries.json'],
    ['bloodTests', 'blood-tests.json'],
    ['bodyEntries', 'body-entries.json'],
    ['epigeneticTests', 'epigenetic-tests.json'],
    ['eyeExams', 'eyes.json'],
    ['saunaSessions', 'sauna-sessions.json'],
    ['habits', 'habits.json'],
    ['healthMetrics', 'health-metrics.json']
  ]) {
    const mlArr = store[mlKey] || [];
    if (mlArr.length === 0) { report.added[mlKey] = 0; report.skipped[mlKey] = 0; continue; }
    const { added, skipped } = await mergeById(mlArr, dataPath('meatspace', fileName), dataPath('meatspace'));
    report.added[mlKey] = added; report.skipped[mlKey] = skipped;
  }

  if (store.profile && typeof store.profile === 'object') {
    const profilePath = dataPath('meatspace', 'profile.json');
    if (!existsSync(profilePath)) {
      await ensureDir(dataPath('meatspace'));
      await atomicWrite(profilePath, store.profile);
      report.added.profile = 1; report.skipped.profile = 0;
    } else {
      report.added.profile = 0; report.skipped.profile = 1;
    }
  }

  report.ok = true;
  report.importedAt = new Date().toISOString();
  return report;
}
