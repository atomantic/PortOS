import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';

// Prototype-pollution guard: when JSON.parse / PUT /api/settings hands us a
// payload with a `__proto__` (or `constructor`/`prototype`) own property,
// rebuilding the object via `cleaned[k] = v` would invoke the prototype
// setter and mutate Object.prototype. Skip these keys defensively — settings
// never legitimately uses them. Mirrors POLLUTING_KEYS in server/lib/objects.js.
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
// every GET /api/settings. The single source of warning is `save()`, which
// fires exactly once per successful write (after the writeFile resolves),
// covering both auto-heal of disk pollution and rejected patch pollution.
const loadRaw = async () => {
  const raw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
  return safeJSONParse(raw, {});
};

const save = async (settings) => {
  const cleaned = stripStoreKeys(settings);
  await writeFile(SETTINGS_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  // Warn AFTER the successful write so a thrown writeFile never produces
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
export const saveSettings = save;

// Merge against the unstripped on-disk snapshot so save() sees every
// MortalLoom store key in one place — guaranteeing exactly one warning
// per updateSettings call, only when the write succeeds.
export const updateSettings = async (patch) => {
  const raw = await loadRaw();
  const incoming = isPlainObject(patch) ? patch : {};
  const merged = { ...raw, ...incoming };
  return save(merged);
};
