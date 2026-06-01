import { join } from 'path';
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

// Serialize all writes to settings.json on a single tail so an updateSettings
// read-merge-write can't interleave with a concurrent save (two browser tabs,
// a background job racing a user save) and clobber the other's patch. Reads
// stay off the queue — atomicWrite's temp-file+rename keeps every read whole.
const queueWrite = createFileWriteQueue();

const save = async (settings) => {
  const cleaned = stripStoreKeys(settings);
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

export const getSettings = async () => stripStoreKeys(await loadRaw());
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
