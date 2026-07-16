import { join } from 'path';
import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';
import { safeJSONParse, PATHS, atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject, POLLUTING_KEYS } from '../lib/objects.js';

// POLLUTING_KEYS (`__proto__`/`constructor`/`prototype`) is the project-wide
// prototype-pollution denylist (defined in server/lib/objects.js). Without it,
// rebuilding the cleaned object via `cleaned[k] = v` against a payload that
// JSON.parse exposed those names on would invoke the prototype setter and
// mutate Object.prototype. Settings never legitimately uses these keys.

const SETTINGS_FILE = join(PATHS.data, 'settings.json');

// Keys that belong to the MortalLoom iCloud store (MortalLoom.json), NOT to
// PortOS settings (data/settings.json). A historical bug or hand-edit can pollute
// settings.json with these top-level arrays/objects, which then bloats every
// `GET /api/settings` response and rides forward through every
// `saveSettings({ ...current, x: y })` mutation. Strip them on both read and
// write so the corruption auto-heals on the next save and can't propagate.
// Superset of ARRAY_KEYS in mortalLoomStore.js — also includes the non-array
// store objects `profile` and `genomeScanRecord` observed in the actual
// corruption. Keep both sides in sync when MortalLoom adds new store keys.
const MORTALLOOM_STORE_KEYS = new Set([
  'alcoholDrinks', 'alcoholPresets', 'bloodTests', 'bodyEntries',
  'epigeneticTests', 'eyeExams', 'goals', 'habits', 'healthMetrics',
  'nicotineEntries', 'nicotinePresets', 'saunaPresets', 'saunaSessions',
  'profile', 'genomeScanRecord'
]);

// Pure rebuild — drops MortalLoom store keys and prototype-pollution keys.
// Non-plain-object inputs (arrays, null, primitives) pass through unchanged;
// rebuilding them as `{}` would silently coerce-then-lose the original value.
// Warning emission is the caller's responsibility (see `save()`) so a single
// updateSettings call produces at most one log line, tied to a successful
// persisted write.
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

// Tiny pub/sub so cache holders (annotationIdentity, etc.) can invalidate on
// writes without each subscribing through socket.io. Listeners receive the
// merged settings object so they can pick fields they care about. Use a
// shared module-level emitter so duplicate imports observe the same bus.
export const settingsEvents = new EventEmitter();
// Cache holders that subscribe per-process can accumulate without bound on
// hot-reload — bump the cap so vitest's per-test re-imports don't trip the
// default-10-listeners warning.
settingsEvents.setMaxListeners(50);

// Reads are always silent — a polluted file would otherwise spam logs on
// every GET /api/settings. `save()` warns based on what it's HANDED, so:
// - `updateSettings(patch)` exposes both disk pollution (via the unstripped
//   raw snapshot) AND patch pollution to save(), yielding one consolidated
//   warning per successful write.
// - Manual `getSettings() → modify → saveSettings(...)` flows hand save() an
//   already-stripped object, so no warning fires — but those flows also
//   can't reintroduce store-key pollution, so silence is correct.
// - A direct `saveSettings(badObject)` with store keys warns once after the
//   write resolves.
const loadRaw = async () => {
  const raw = await tryReadFile(SETTINGS_FILE);
  return safeJSONParse(raw ?? '{}', {});
};

/**
 * Security-sensitive STRICT read of settings.json for the auth gate (#2684).
 *
 * The normal loadRaw()/getSettings() path collapses THREE distinct states to
 * `{}`: an ABSENT file (fresh install — legitimately no settings), a file that
 * exists but can't be READ (permission / I/O error), and a file that reads but
 * won't PARSE (truncated / corrupt JSON, or a non-object root). For feature
 * reads that collapse is fine, but for the auth-enabled decision it fails OPEN:
 * a corrupt settings.json makes `isAuthEnabled()` compute `false` over `{}` and
 * silently disables the password gate (see `server/lib/authGate.js`).
 *
 * This read preserves the distinction so a security caller can fail CLOSED on
 * the two failure modes while still treating a genuinely absent file as
 * "auth off" (the correct default for a fresh install):
 *   { present: false, corrupt: false } → absent (ENOENT): auth legitimately off
 *   { present: true,  corrupt: true }  → exists but unreadable/unparseable: fail closed
 *   { present: true,  corrupt: false } → parsed cleanly into `settings`
 *
 * `settings` is always a plain object (`{}` in the two non-clean cases) so
 * callers can read it unconditionally; they gate their fail-closed behavior on
 * `corrupt`. The default path is the real SETTINGS_FILE; the optional argument
 * exists so unit tests can point it at a temp file without touching real data.
 */
export const readSettingsStrict = async (filePath = SETTINGS_FILE) => {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // ENOENT is the only "not a failure" case — no file means no settings yet.
    if (err?.code === 'ENOENT') return { present: false, corrupt: false, settings: {} };
    // EACCES / EIO / EISDIR / … — the file is there but we couldn't read it.
    return { present: true, corrupt: true, settings: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    // A valid-JSON but non-object root (array, string, number, null) is not a
    // settings document — treat it as corrupt rather than reading properties off it.
    if (!isPlainObject(parsed)) return { present: true, corrupt: true, settings: {} };
    return { present: true, corrupt: false, settings: parsed };
  } catch {
    return { present: true, corrupt: true, settings: {} };
  }
};

// Read-side cache. `getSettings()` is called 100+ times across the codebase
// (many per request), and each call previously did a fresh filesystem read +
// JSON.parse. Settings is app-wide, rarely-changing data — a textbook memoize.
// Correctness contract:
// - The cache is populated lazily on the first `getSettings()` and refreshed
//   from the `settings:updated` event the SAME emitter already fires on every
//   `save()` — so any write through the app (saveSettings/updateSettings/
//   updateSettingsWith) keeps the cache warm and consistent.
// - Write paths (`save`, `updateSettings`, `updateSettingsWith`) deliberately
//   still read `loadRaw()` off disk inside the write queue for their
//   read-merge-write, so their base snapshot is always the freshest persisted
//   truth, never the cache. The post-write `settings:updated` then syncs the
//   cache. This keeps the write-ordering guarantees intact.
// - `null` = not-yet-loaded (distinct from a legitimately empty `{}`), so a
//   fresh process reads disk exactly once.
// - The prior `stripStoreKeys(await loadRaw())` handed every caller a fresh deep
//   object graph, so callers may mutate nested settings in place. To preserve
//   that isolation the cache is never handed out directly: reads deep-clone it,
//   and the `settings:updated` listener stores a private clone (save() emits the
//   same `cleaned` object it also returns to its caller). structuredClone is the
//   right tool for this JSON-shaped data and stays far cheaper than the disk
//   read + full-tree JSON.parse it replaces.
// A manual edit of settings.json while the server runs is not observed until
// the next app-driven save or a restart — the standard trade-off for a cache,
// and app-driven changes (the only ones the schedulers care about) refresh it.
let settingsCache = null;
settingsEvents.on('settings:updated', (cleaned) => {
  settingsCache = structuredClone(cleaned);
});

// Test-only: drop the read cache so a suite that stubs the on-disk file per
// test observes each fresh stub. Production code never calls this — writes keep
// the cache coherent via the `settings:updated` event above.
export const __resetSettingsCache = () => {
  settingsCache = null;
};

// Re-sync the read cache with the current on-disk settings.json and notify every
// `settings:updated` listener. Call after a process replaces settings.json
// OUTSIDE the normal save() path — e.g. a backup restore rsyncs it into place —
// since such a write bypasses the save()-emitted event the cache rides on and
// would otherwise leave every settings consumer serving pre-restore values.
export const reloadSettings = async () => {
  const cleaned = stripStoreKeys(await loadRaw());
  settingsEvents.emit('settings:updated', cleaned);
  return cleaned;
};

// Serialize all writes to settings.json on a single tail so an updateSettings
// read-merge-write can't interleave with a concurrent save (two browser tabs,
// a background job racing a user save) and clobber the other's patch. Reads
// stay off the queue — atomicWrite's temp-file+rename keeps every read whole.
const queueWrite = createFileWriteQueue();

const save = async (settings) => {
  const cleaned = stripStoreKeys(settings);
  // Stamp `timezoneUpdatedAt` whenever the effective `timezone` actually
  // changes, so timezone-dependent schedulers can gate catch-up/re-evaluation
  // logic on "when did the zone last change" (see meatspacePostReminder's
  // missed-slot catch-up, #2040). Compare against the previous on-disk value so
  // unrelated settings saves NEVER touch the field. The read runs inside the
  // same queued write turn (every caller wraps save in queueWrite), so the
  // comparison is against the freshest persisted snapshot, and any prior
  // `timezoneUpdatedAt` on an unchanged-timezone save rides through untouched
  // via the merged object.
  if (isPlainObject(cleaned)) {
    const prev = stripStoreKeys(await loadRaw());
    if (isPlainObject(prev) && cleaned.timezone !== prev.timezone) {
      cleaned.timezoneUpdatedAt = Date.now();
    }
  }
  // atomicWrite (temp-file + rename) so a mid-write crash never truncates
  // settings.json. Pass a pre-stringified string to preserve the trailing
  // newline; atomicWrite's own JSON.stringify omits it.
  await atomicWrite(SETTINGS_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  // Warn AFTER the successful write so a thrown write never produces
  // a misleading "stripped" log line for a write that didn't happen.
  if (isPlainObject(settings)) {
    const polluted = Object.keys(settings).filter((k) => MORTALLOOM_STORE_KEYS.has(k));
    if (polluted.length > 0) {
      console.warn(`⚠️ settings.json: stripped MortalLoom store keys: ${polluted.join(', ')}`);
    }
  }
  settingsEvents.emit('settings:updated', cleaned);
  return cleaned;
};

export const getSettings = async () => {
  if (settingsCache === null) {
    const raw = await tryReadFile(SETTINGS_FILE);
    // Distinguish a CORRUPT (present but unparseable) settings.json from an
    // absent/empty one so a corrupt read does NOT poison the cache with `{}`
    // (issue #2684). Caching a corrupt-derived empty object would strand every
    // consumer — verifyPassword, schedulers, feature reads — on empty settings
    // until a save() or restart, defeating the no-restart self-heal that the
    // auth fail-closed path promises. A malformed file (`raw` present but not a
    // JSON object) is the corrupt case handled here; `tryReadFile` collapses an
    // absent OR unreadable file to null, which we treat as an empty, cacheable
    // snapshot (absent is the fresh-install default; the rarer unreadable case is
    // still failed CLOSED by isAuthEnabled's stricter readSettingsStrict).
    const parsed = raw === null ? {} : safeJSONParse(raw, null);
    const corrupt = raw !== null && !isPlainObject(parsed);
    const loaded = stripStoreKeys(isPlainObject(parsed) ? parsed : {});
    // A save()/reloadSettings() may have populated the cache via the
    // settings:updated listener while this cold read was awaiting the disk read.
    // Prefer that fresher in-memory value over our (older) on-disk snapshot.
    if (settingsCache !== null) return structuredClone(settingsCache);
    // On a corrupt read, hand back the empty snapshot WITHOUT caching it, so the
    // very next call re-reads and picks up a repair immediately.
    if (corrupt) return structuredClone(loaded);
    settingsCache = loaded;
  }
  // Hand out a private deep copy so a caller mutating nested settings in place
  // can't corrupt the shared cache — matching the prior per-call
  // `stripStoreKeys(await loadRaw())` deep-copy semantics, minus the I/O.
  return structuredClone(settingsCache);
};
export const saveSettings = (settings) => queueWrite(() => save(settings));

// Merge against the unstripped on-disk snapshot so save() sees every
// MortalLoom store key in one place — guaranteeing exactly one warning
// per updateSettings call, only when the write succeeds. The whole
// read-merge-write runs inside one queued turn so it merges against the
// freshest persisted snapshot, not a stale pre-image.
export const updateSettings = (patch) => queueWrite(async () => {
  const raw = await loadRaw();
  const incoming = isPlainObject(patch) ? patch : {};
  const merged = { ...raw, ...incoming };
  return save(merged);
});

// Read-modify-write INSIDE the write queue. For callers whose merge semantics
// `updateSettings`' shallow `{ ...raw, ...patch }` can't express — a deep merge
// (`deepMerge(current, …)`), or building the next object by spreading/deleting a
// sub-key. `mutate(current)` receives the freshest stripped settings (same shape
// `getSettings()` returns) and returns the FULL next settings object to persist.
//
// This closes the stale-base window in the old `getSettings() → modify →
// saveSettings(...)` pattern: there, a concurrent `updateSettings` landing
// between the external read and the queued write was clobbered by the caller's
// stale pre-image. Here the read and the write share one queued turn, so the
// mutator always sees the latest persisted snapshot.
export const updateSettingsWith = (mutate) => queueWrite(async () => {
  const current = stripStoreKeys(await loadRaw());
  const next = await mutate(current);
  // Guard the mutator's return BEFORE persisting: unlike the old
  // saveSettings(objectLiteral) callers, a mutator with a missing `return`
  // (or one that returns an array/primitive) would otherwise serialize
  // garbage like `undefined`/`"foo"` into settings.json. Fail loud instead.
  if (!isPlainObject(next)) {
    throw new TypeError('updateSettingsWith: mutate() must return a plain settings object');
  }
  return save(next);
});
