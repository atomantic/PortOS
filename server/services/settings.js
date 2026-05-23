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

// `warn` only emits the console warning when set — write paths pass true so
// the operator sees pollution being persisted-out/incoming, reads stay silent
// so a single polluted file doesn't spam logs on every GET /api/settings.
// Non-plain-object inputs (arrays, null, primitives) pass through unchanged;
// rebuilding them as `{}` would silently coerce-then-lose the original value.
const stripStoreKeys = (settings, { warn = false } = {}) => {
  if (!isPlainObject(settings)) return settings;
  const cleaned = {};
  const polluted = [];
  for (const [k, v] of Object.entries(settings)) {
    if (POLLUTING_KEYS.has(k)) continue;
    if (MORTALLOOM_STORE_KEYS.has(k)) {
      polluted.push(k);
      continue;
    }
    cleaned[k] = v;
  }
  if (warn && polluted.length > 0) {
    console.warn(`⚠️ settings.json: stripping MortalLoom store keys: ${polluted.join(', ')}`);
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

// `warn` defaults to false so the public `getSettings()` read path stays
// silent (a single polluted file would otherwise spam logs on every GET).
// `updateSettings` passes `warn: true` because it's part of a write/heal
// path — the operator should see the one-line "stripping…" notice that
// announces the auto-heal write that's about to happen.
const load = async ({ warn = false } = {}) => {
  const raw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
  return stripStoreKeys(safeJSONParse(raw, {}), { warn });
};

const save = async (settings) => {
  const cleaned = stripStoreKeys(settings, { warn: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  settingsEvents.emit('settings:updated', cleaned);
};

export const getSettings = () => load();
export const saveSettings = save;

export const updateSettings = async (patch) => {
  const current = await load({ warn: true });
  const merged = { ...current, ...stripStoreKeys(patch, { warn: true }) };
  await save(merged);
  return merged;
};
