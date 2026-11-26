import { hydratePrivateKeys, persistPrivateKeys } from './privateKeyStore.js';
import { join } from 'path';
import { stat } from 'node:fs/promises';
import { EventEmitter } from 'events';
import { safeJSONParse, PATHS, atomicWrite, tryReadFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue, drainDetachedWrites, trackDetachedWrite } from '../lib/fileWriteQueue.js';
import { canonicalStringify, isPlainObject, POLLUTING_KEYS } from '../lib/objects.js';
// `./userActions.js` is imported lazily at its single call site: it reaches the DB
// layer, and a static edge from this widely imported module instantiated that subtree
// in ~200 suites.

// POLLUTING_KEYS (server/lib/objects.js) is the prototype-pollution denylist: rebuilding
// via `cleaned[k] = v` on a JSON.parse payload with these names would mutate
// Object.prototype. Settings never legitimately uses them.

const SETTINGS_FILE = join(PATHS.data, 'settings.json');

// Keys of the MortalLoom iCloud store (MortalLoom.json), not PortOS settings. A stray
// write can pollute settings.json with them, bloating `GET /api/settings`; strip on
// read and write so it self-heals. Superset of ARRAY_KEYS in mortalLoomStore.js (adds
// `profile`, `genomeScanRecord`); keep both in sync.
const MORTALLOOM_STORE_KEYS = new Set([
  'alcoholDrinks', 'alcoholPresets', 'bloodTests', 'bodyEntries',
  'epigeneticTests', 'eyeExams', 'goals', 'habits', 'healthMetrics',
  'nicotineEntries', 'nicotinePresets', 'saunaPresets', 'saunaSessions',
  'profile', 'genomeScanRecord'
]);

// Pure rebuild dropping MortalLoom store and pollution keys. Non-plain-object inputs
// pass through (rebuilding as `{}` would lose the value). Warning is the caller's job
// (see `save()`) so one updateSettings call logs at most once.
const stripStoreKeys = (settings) => {
  if (!isPlainObject(settings)) return settings;
  const cleaned = {};
  for (const [k, v] of Object.entries(settings)) {
    if (POLLUTING_KEYS.has(k)) continue;
    if (MORTALLOOM_STORE_KEYS.has(k)) continue;
    cleaned[k] = v;
  }
  return cleaned;
};

// Pub/sub so cache holders invalidate on writes without socket.io; listeners receive the
// merged settings. Shared module-level emitter so duplicate imports see one bus.
export const settingsEvents = new EventEmitter();
// Raised listener cap: hot-reload / per-test re-imports trip the default-10 warning.
settingsEvents.setMaxListeners(50);

// Reads are silent (a polluted file would spam every GET). `save()` warns on what it is
// HANDED: `updateSettings(patch)` exposes disk and patch pollution for one consolidated
// warning; a manual getSettings() -> saveSettings() hands save() stripped data (no
// warning, and it can't reintroduce pollution); a direct saveSettings(bad) warns once.

/**
 * Security-sensitive STRICT read of settings.json for the auth gate (#2684).
 *
 * getSettings() collapses ABSENT, unreadable and unparseable files to `{}`,
 * which would make a corrupt file fail OPEN (auth disabled). This preserves the
 * distinction so security callers fail CLOSED:
 *   { present: false, corrupt: false } absent (ENOENT): auth legitimately off
 *   { present: true,  corrupt: true }  unreadable/unparseable: fail closed
 *   { present: true,  corrupt: false } parsed cleanly into `settings`
 *
 * `settings` is always a plain object, so callers gate on `corrupt`. The optional
 * argument lets tests point at a temp file.
 */
export const readSettingsStrict = async (filePath = SETTINGS_FILE) => {
  // `tryReadFileStrict` reports absence from the read's own errno (no second `access()`
  // probe that could disagree). `ok: false` = absence unconfirmed (EACCES, ENOTDIR, EIO):
  // fail closed.
  const { ok, value: raw } = await tryReadFileStrict(filePath);
  if (!ok) return { present: true, corrupt: true, settings: {} };
  if (raw === null) return { present: false, corrupt: false, settings: {} };
  // safeJSONParse returns null for malformed/empty input; a non-object root is likewise
  // not a settings document. Treat both as corrupt.
  const parsed = safeJSONParse(raw, null);
  if (!isPlainObject(parsed)) return { present: true, corrupt: true, settings: {} };
  return { present: true, corrupt: false, settings: parsed };
};

// Read-side cache: getSettings() is called 100+ times, so memoize.
// - Populated lazily; refreshed from the `settings:updated` event save() already emits,
//   so every write path keeps it coherent.
// - Write paths still read settings.json from disk inside the write queue, so their
//   read-merge-write base is never the cache.
// - `null` = not-yet-loaded, distinct from a legitimately empty `{}`.
// - Callers may mutate nested settings in place, so the cache is never handed out:
//   reads deep-clone it and the listener stores a private clone.
// The local review bridge writes from another process; reviewer-selection reads refresh
// from disk metadata explicitly, while ordinary getSettings() skips the stat.
const readSettingsSignature = async () => {
  try {
    const { mtimeMs, size } = await stat(SETTINGS_FILE);
    return { mtimeMs, size };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Metadata is advisory; the strict read below owns unreadable/corrupt
    // handling and invalidates consumers without broadcasting auth-off data.
    return undefined;
  }
};
let settingsSignature;
let settingsCache = null;
settingsEvents.on('settings:updated', (cleaned) => {
  settingsCache = structuredClone(cleaned);
});

// Test-only: drop the read cache so suites stubbing the on-disk file see each stub.
export const __resetSettingsCache = () => {
  settingsCache = null;
  settingsSignature = undefined;
};

// Re-sync the read cache with on-disk settings.json and notify `settings:updated`
// listeners. Call after something replaces the file OUTSIDE save() (e.g. a backup
// restore), which bypasses the event the cache rides on.
const reloadSettingsFromDisk = async (signaturePromise = readSettingsSignature()) => {
  const signature = await signaturePromise;
  const { corrupt, settings } = await readSettingsStrict();
  if (corrupt) {
    // Do NOT broadcast a corrupt settings.json as `{}` (#2684), e.g. from a backup restore
    // of a malformed snapshot: it would prime the read cache and the auth enabled-cache to
    // an empty/disabled state, reopening the gate (FAIL OPEN). Invalidate instead so the
    // next read goes to disk and fails closed.
    settingsCache = null;
    settingsSignature = undefined;
    settingsEvents.emit('settings:invalidated');
    return {};
  }
  const cleaned = stripStoreKeys(await hydratePrivateKeys(settings, PATHS.data));
  settingsSignature = signature;
  settingsEvents.emit('settings:updated', cleaned);
  return cleaned;
};

export const reloadSettings = () => reloadSettingsFromDisk();

// Serialize all settings.json writes on one tail so a read-merge-write can't interleave
// with a concurrent save and clobber a patch. Reads stay off the queue; explicit disk
// refreshes serialize their cache events.
const queueWrite = createFileWriteQueue();

// Share the write queue so an older disk snapshot cannot emit after a newer
// in-process save. reloadSettings itself stays usable inside the restore lock.
export const refreshSettingsIfChangedOnDisk = () => queueWrite(async () => {
  const signature = await readSettingsSignature();
  if (settingsCache !== null && settingsSignature !== undefined && signature !== undefined
    && signature?.mtimeMs === settingsSignature?.mtimeMs
    && signature?.size === settingsSignature?.size) return;
  await reloadSettingsFromDisk(signature);
});

/**
 * Drain admitted settings writes and hold later writes through an out-of-band
 * restore and its cache reconciliation. The callback must not re-enter any
 * settings write API; reloadSettings reads directly and is safe inside it.
 * For a full restore acquire this queue before CoS config, then CoS state.
 */
export const withLiveSettingsRestore = (restore) => queueWrite(restore);

// Longest scalar kept verbatim; longer values are blobs where only THAT they changed matters.
const LEDGER_SCALAR_MAX_CHARS = 120;

// `undefined` counts (first-time set); recorded as null.
const isShortScalar = (value) => (
  value === null
  || value === undefined
  || typeof value === 'boolean'
  || typeof value === 'number'
  || (typeof value === 'string' && value.length <= LEDGER_SCALAR_MAX_CHARS)
);

// Shallow top-level diff: settings is a map of feature slices, so "the `federation`
// slice changed" is the answerable question; a deep diff would leak slice internals.
// Only SHORT SCALARS keep values. Secret-shaped keys are NOT filtered here:
// `recordUserAction` redacts by key name, so the denylist has one home. Equality uses
// `canonicalStringify` so a merely rebuilt slice is not reported as an edit.
const diffSettings = (prev, next) => {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const keysChanged = [];
  const changes = {};
  for (const key of keys) {
    const before = prev[key];
    const after = next[key];
    if (canonicalStringify(before) === canonicalStringify(after)) continue;
    keysChanged.push(key);
    changes[key] = isShortScalar(before) && isShortScalar(after)
      ? { from: before ?? null, to: after ?? null }
      : { changed: true };
  }
  return { keysChanged, changes };
};

/**
 * Persist settings. `actor` (#5594) names WHO is saving, defaulting to `'system'`
 * (schedulers, sync hooks); HTTP mutations pass `'user'`. `reloadSettings` does not
 * call this, so backup restore is excluded by construction.
 */
const save = async (settings, { actor = 'system', skipUserAction = false } = {}, previousSettings) => {
  const cleaned = stripStoreKeys(settings);
  // Stamp `timezoneUpdatedAt` only when the effective `timezone` changes, so schedulers
  // can gate catch-up on it (#2040). Compared against the previous on-disk value inside
  // the same queued write turn, so unrelated saves never touch it.
  const prev = isPlainObject(cleaned) ? previousSettings
    ?? stripStoreKeys(await hydratePrivateKeys((await readSettingsStrict()).settings, PATHS.data)) : null;
  // Diff BEFORE the stamp below so a timezone change reports `keysChanged: ['timezone']`.
  const change = isPlainObject(prev) ? diffSettings(prev, cleaned) : null;
  if (isPlainObject(prev) && cleaned.timezone !== prev.timezone) {
    cleaned.timezoneUpdatedAt = Date.now();
  }
  // Stamp `backupConfigUpdatedAt` when a registration-affecting backup field (cron,
  // enabled, destination) changes, like `timezoneUpdatedAt`, so backupScheduler's
  // missed-slot catch-up (#8456) skips a slot the current config never scheduled.
  if (isPlainObject(prev)) {
    const prevBackup = isPlainObject(prev.backup) ? prev.backup : {};
    const nextBackup = isPlainObject(cleaned.backup) ? cleaned.backup : {};
    const backupScheduleChanged = prevBackup.cronExpression !== nextBackup.cronExpression
      || prevBackup.enabled !== nextBackup.enabled
      || (prevBackup.destPath || null) !== (nextBackup.destPath || null);
    if (backupScheduleChanged) {
      cleaned.backupConfigUpdatedAt = Date.now();
    }
  }
  // atomicWrite (temp-file + rename) so a mid-write crash never truncates
  // settings.json. Pass a pre-stringified string to preserve the trailing
  // newline; atomicWrite's own JSON.stringify omits it.
  await atomicWrite(SETTINGS_FILE, JSON.stringify(await persistPrivateKeys(cleaned, PATHS.data, { previousSettings: prev }), null, 2) + '\n', { mode: 0o600 });
  await hydratePrivateKeys(cleaned, PATHS.data);
  // Another process can replace the file between our write and a stat. Never
  // label this in-memory save with metadata that might belong to that writer;
  // the next reviewer-selection read reconciles the persisted snapshot once.
  settingsSignature = undefined;
  // Warn AFTER the successful write so a thrown write never produces
  // a misleading "stripped" log line for a write that didn't happen.
  if (isPlainObject(settings)) {
    const polluted = Object.keys(settings).filter((k) => MORTALLOOM_STORE_KEYS.has(k));
    if (polluted.length > 0) {
      console.warn(`⚠️ settings.json: stripped MortalLoom store keys: ${polluted.join(', ')}`);
    }
  }
  settingsEvents.emit('settings:updated', cleaned);
  // A no-op save writes no ledger row: the settings page PUTs the whole object
  // on every visit, and a log full of "changed nothing" rows would bury the
  // changes that matter.
  if (!skipUserAction && change && change.keysChanged.length > 0) {
    recordSettingsChange(actor, change);
  }
  return cleaned;
};

// Record a settings change in the operator-action ledger (#5594) as DETACHED bookkeeping:
// awaiting a Postgres write inside the queued save turn let a DB outage stall every
// later save and reject one already on disk (skipping setPassword's session revocation,
// #12018). The chain is tracked so `flushSettingsLedger` can drain it; otherwise a suite
// removing its temp data root would see an in-flight row recreate the directory.
const recordSettingsChange = (actor, change) => {
  const happenedAt = new Date().toISOString();
  const changedKeys = change.keysChanged.join(',');
  trackDetachedWrite(import('./userActions.js')
    .then(({ recordUserAction }) => recordUserAction({
      type: 'settings.update',
      actor,
      summary: `Updated settings: ${change.keysChanged.join(', ')}`,
      payload: { keysChanged: change.keysChanged, changes: change.changes },
      source: { service: 'settings', fn: 'save' },
      happenedAt,
      // Timestamp (a save is not an idempotent retry) plus changed keys, since
      // `toISOString()` is millisecond-grained and same-ms saves would collapse.
      // Deterministic, so a genuine duplicate still dedupes.
      dedupeKey: `settings.update:${happenedAt}:${changedKeys.slice(0, 200)}`,
    }))
    .catch((error) => {
      console.error(`❌ Settings ledger write failed for keys ${changedKeys}: ${error.message}`);
    }));
};

// Await every ledger write scheduled so far. The writes are detached from the
// save that scheduled them, so a caller that must observe the row (a test, a
// shutdown drain) waits here rather than on the save's promise.
export const flushSettingsLedger = () => drainDetachedWrites();

/**
 * `getSettings`, but reporting whether the snapshot came from a CORRUPT read.
 *
 * getSettings() returns `{}` for malformed/unreadable files, which is indistinguishable
 * from a fresh install. That is wrong for spend- or privacy-bearing decisions (e.g. the
 * federated media router must fail loudly rather than render locally).
 *
 * @returns {Promise<{corrupt: boolean, settings: object}>}
 */
export const getSettingsWithStatus = async () => {
  if (settingsCache === null) {
    // Cold read goes through the STRICT reader so a corrupt file does not poison the cache
    // with `{}` (#2684), which would strand consumers until a save or restart. Only a
    // genuinely ABSENT file caches `{}`.
    const signature = await readSettingsSignature();
    const { corrupt, settings } = await readSettingsStrict();
    const loaded = stripStoreKeys(await hydratePrivateKeys(settings, PATHS.data));
    // A save()/reloadSettings() may have populated the cache via the
    // settings:updated listener while this cold read was awaiting the disk read.
    // Prefer that fresher in-memory value over our (older) on-disk snapshot.
    if (settingsCache !== null) return { corrupt: false, settings: structuredClone(settingsCache) };
    // On a corrupt read, hand back the empty snapshot WITHOUT caching it, so the
    // very next call re-reads and picks up a repair immediately.
    if (corrupt) return { corrupt: true, settings: structuredClone(loaded) };
    settingsCache = loaded;
    settingsSignature = signature;
  }
  // Hand out a private deep copy so a caller mutating nested settings in place
  // can't corrupt the shared cache.
  return { corrupt: false, settings: structuredClone(settingsCache) };
};

export const getSettings = async () => (await getSettingsWithStatus()).settings;
export const saveSettings = (settings, options) => queueWrite(() => save(settings, options));

// The merge base for every partial write, read strictly inside the queued turn.
// A tolerant read would turn a present-but-unreadable or malformed file into `{}`, and a
// partial write merged onto that replaced every setting (auth secret included)
// with just its patch. A confirmed-absent file (fresh install) is a valid empty
// base; anything else refuses until the file is repaired or restored.
const loadWriteBase = async () => {
  const { corrupt, settings } = await readSettingsStrict();
  if (corrupt) {
    const err = new Error('Cannot update settings: data/settings.json is unreadable or malformed — repair it or restore it from a backup');
    err.code = 'SETTINGS_UNREADABLE';
    throw err;
  }
  return hydratePrivateKeys(settings, PATHS.data);
};

// Merge against the unstripped on-disk snapshot so save() sees every
// MortalLoom store key in one place — guaranteeing exactly one warning
// per updateSettings call, only when the write succeeds. The whole
// read-merge-write runs inside one queued turn so it merges against the
// freshest persisted snapshot, not a stale pre-image.
export const updateSettings = (patch, options) => queueWrite(async () => {
  const raw = await loadWriteBase();
  const previous = structuredClone(stripStoreKeys(raw));
  const incoming = isPlainObject(patch) ? patch : {};
  const merged = { ...raw, ...incoming };
  return save(merged, options, previous);
});

// Read-modify-write INSIDE the write queue, for merges `updateSettings`' shallow spread
// can't express (deep merge, deleting a sub-key). `mutate(current)` gets the freshest
// stripped settings and returns the FULL next object. The read and write share one
// queued turn, closing the stale-base window of getSettings() -> saveSettings(). An
// unreadable or malformed file refuses (loadWriteBase) rather than yielding an empty base.
export const updateSettingsWith = (mutate, options) => queueWrite(async () => {
  const current = stripStoreKeys(await loadWriteBase());
  const previous = structuredClone(current);
  const next = await mutate(current);
  // Guard the mutator's return BEFORE persisting: unlike the old
  // saveSettings(objectLiteral) callers, a mutator with a missing `return`
  // (or one that returns an array/primitive) would otherwise serialize
  // garbage like `undefined`/`"foo"` into settings.json. Fail loud instead.
  if (!isPlainObject(next)) {
    throw new TypeError('updateSettingsWith: mutate() must return a plain settings object');
  }
  return save(next, options, previous);
});
