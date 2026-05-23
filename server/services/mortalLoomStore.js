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
import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { safeJSONParse, readJSONFile, dataPath, ensureDir } from '../lib/fileUtils.js';
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
// EAGAIN (errno -11) or EDEADLK from Node's fs calls. 50ms + 100ms covers the
// common sub-200ms coordination windows without making transients observable.
// Exposed (not const) so tests can set it to `[0, 0]` to keep the retry path
// covered without paying the backoff sleep. (An empty array would still work
// — and run faster still — but it would disable the retry loop entirely,
// which defeats the purpose of testing the retry behavior.)
export let TRANSIENT_RETRY_DELAYS_MS = [50, 100];
export function _setRetryDelaysForTest(delays) { TRANSIENT_RETRY_DELAYS_MS = delays; }

function isTransientFsError(err) {
  return !!err && (err.code === 'EAGAIN' || err.code === 'EDEADLK' || err.errno === -11);
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
// `brctl download <path>` is the documented verb to materialize the file
// now. It does NOT set a persistent retention flag against future eviction
// (that requires Finder's "Keep Downloaded" or undocumented `brctl unevict`),
// so re-eviction under future disk pressure is still possible — the retry-
// on-EAGAIN path handles that case. Best-effort, fire-and-forget; on
// non-macOS we never spawn brctl, and on macOS when brctl is unexpectedly
// missing (sandboxed env, removed binary) we warn ONCE and then fall
// through to the retry path silently — without the dedupe, every
// settings:updated would re-warn.

let lastPinnedPath = null;
let brctlMissingWarned = false;

function pinAgainstEviction(path) {
  if (process.platform !== 'darwin') return;
  if (!path || lastPinnedPath === path) return;
  lastPinnedPath = path;

  // detached + unref so a long-running `brctl download` (large evicted file,
  // slow network) can't keep the Node process alive on shutdown. Matches the
  // repo's fire-and-forget spawn pattern in server/routes/apps.js +
  // server/routes/brain.js.
  const child = spawn('brctl', ['download', path], { detached: true, stdio: 'ignore' });
  child.unref();
  // Capture `path` in each handler so a late-arriving error/exit from a stale
  // child (one whose path has since been replaced by a newer pinAgainstEviction
  // call) doesn't clear the dedupe cache for the *current* path. Without this
  // capture, the stale exit would null out lastPinnedPath even though the new
  // path's child is still in flight (or has already succeeded), defeating
  // dedupe and causing repeated spawns on subsequent settings:updated events.
  child.on('error', (err) => {
    if (lastPinnedPath === path) lastPinnedPath = null;
    if (err.code === 'ENOENT') {
      // brctl isn't in PATH. On darwin this is extremely unusual; surface it
      // once so operators in a sandbox aren't left wondering why pinning is
      // a silent no-op, then dedupe so we don't spam on every settings change.
      if (!brctlMissingWarned) {
        brctlMissingWarned = true;
        console.warn('⚠️ brctl not found on PATH; MortalLoom store pinning disabled (retry-on-EAGAIN path remains)');
      }
      return;
    }
    console.warn(`⚠️ brctl download failed for MortalLoom store: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (code === 0) {
      console.log(`📥 MortalLoom store pinned for download: ${path}`);
      return;
    }
    // Non-zero exit OR signal-kill (code===null,signal set). Either way the
    // pin didn't complete, so clear the dedupe cache to allow a retry on the
    // next settings:updated event. Without this, a SIGTERM'd brctl would
    // permanently mask its own retry. Guard with the captured `path` so a
    // stale child can't clear cache for a path that has already moved on.
    if (lastPinnedPath === path) lastPinnedPath = null;
    if (code !== null) {
      console.warn(`⚠️ brctl download exited ${code} for MortalLoom store: ${path}`);
    } else {
      console.warn(`⚠️ brctl download killed by ${signal} for MortalLoom store: ${path}`);
    }
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
  brctlMissingWarned = false;
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
 * Read + parse the store at `path`. Returns `null` for:
 *  - file absent (ENOENT or `existsSync` false) — silently
 *  - any other `readFile` failure (EAGAIN/EDEADLK/EACCES/unknown errno/etc.) —
 *    with one warn. The intent is iCloud-ubiquity transients (mid-sync,
 *    downloading, conflict resolution) but the catch is intentionally broad —
 *    read consumers all treat null as "fall through to local data," and the
 *    write side has its own overwrite guard, so suppressing a permission /
 *    unexpected error here just loses the iCloud copy for one cycle, never
 *    truncates the user's data.
 *  - corrupt JSON — `safeJSONParse` falls back to null
 *  - top-level JSON that isn't a plain object (array/string/number/boolean) —
 *    every consumer treats the store as `{ alcoholDrinks: [...], goals: [...],
 *    profile: {...}, … }` so an unexpected shape is just as "unavailable" as
 *    a corrupt file. Returning null keeps callers from misreading an array as
 *    a successful read and reporting empty counts to the UI.
 */
async function readStoreAtPath(path) {
  if (!existsSync(path)) return null;
  const raw = await withTransientRetry(() => readFile(path, 'utf-8')).catch((err) => {
    // existsSync→readFile race: file disappeared between the two calls.
    // Treat as "absent" silently — no warning noise.
    if (err.code === 'ENOENT') return null;
    console.warn(`⚠️ MortalLoom store unavailable (${err.code || err.errno || 'unknown'}): ${path}`);
    return null;
  });
  if (raw === null || raw === undefined) return null;
  const parsed = safeJSONParse(raw, null, { context: path });
  return isPlainObject(parsed) ? parsed : null;
}

export async function readStore() {
  return readStoreAtPath(await resolvePath());
}

async function writeStoreAtPath(path, data) {
  await withTransientRetry(() => writeFile(path, JSON.stringify(data, null, 2)));
}

/** Atomic read → mutate → write. Ensures all array keys are initialized. */
export async function updateStore(mutator) {
  // Resolve the path once and pass it through to both read and write — settings
  // could change mid-call, so we'd otherwise risk reading from one path and
  // writing to another (or the overwrite-guard's existsSync looking at a
  // different file than the read).
  const path = await resolvePath();
  const store = await readStoreAtPath(path);
  // The overwrite guard is based solely on post-read state, not a pre-read
  // snapshot. readStoreAtPath returns null for four reasons; we only care
  // about the *currently observable* state when deciding whether it's safe
  // to write:
  //   (1) file does not exist now → safe to seed a fresh store (whether it
  //       was absent the whole time, disappeared mid-call, or never appeared
  //       in the first place).
  //   (2) file exists now but parsed to a non-plain-object value → unreadable
  //       (transient iCloud read failure, corrupt JSON, or unexpected shape
  //       like a top-level array which JSON.stringify would silently drop).
  //       Refuse to overwrite the user's iCloud data.
  // Without this guard, the iCloud transient-failure tolerance in
  // readStoreAtPath would let updateStore silently truncate a momentarily
  // unreadable iCloud file.
  if (existsSync(path) && !isPlainObject(store)) {
    // Log the resolved path server-side for diagnostics; keep the thrown
    // message path-free so it doesn't get echoed back to the UI (route
    // errors serialize as `error: error.message`).
    console.error(`❌ MortalLoom store at ${path} is unreadable; refusing to overwrite`);
    throw new Error('MortalLoom store is unreadable; refusing to overwrite');
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
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
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
  const store = await readStore();
  if (!store || !Array.isArray(store[key])) return null;
  const sameDate = store[key].filter(r => r.date === date);
  return sameDate[index]?.id ?? null;
}

// === Read-side convenience ===

/** Returns an array for `key` from the store when enabled, else null (fall through to local). */
export async function mlArrayIfEnabled(key) {
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
  if (!store || !Array.isArray(store[key])) return null;
  return store[key];
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

export async function readDailyLogIfEnabled() {
  if (!(await isMortalLoomEnabled())) return null;
  const store = await readStore();
  return store ? buildDailyLogFromMortalLoom(store) : null;
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
  const raw = st ? await withTransientRetry(() => readFile(path, 'utf-8')).catch((err) => {
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
  const store = await readStore();
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
      await writeFile(localPath, JSON.stringify(localArr, null, 2));
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
    await writeFile(goalsPath, JSON.stringify(localGoals, null, 2));
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
      await writeFile(profilePath, JSON.stringify(store.profile, null, 2));
      report.added.profile = 1; report.skipped.profile = 0;
    } else {
      report.added.profile = 0; report.skipped.profile = 1;
    }
  }

  report.ok = true;
  report.importedAt = new Date().toISOString();
  return report;
}
