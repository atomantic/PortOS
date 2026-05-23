import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

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
const stripStoreKeys = (settings, { warn = false } = {}) => {
  if (!settings || typeof settings !== 'object') return settings;
  const cleaned = {};
  const polluted = [];
  for (const [k, v] of Object.entries(settings)) {
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

const load = async () => {
  const raw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
  return stripStoreKeys(safeJSONParse(raw, {}));
};

const save = async (settings) => {
  const cleaned = stripStoreKeys(settings, { warn: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  settingsEvents.emit('settings:updated', cleaned);
};

export const getSettings = load;
export const saveSettings = save;

export const updateSettings = async (patch) => {
  const current = await load();
  const merged = { ...current, ...stripStoreKeys(patch, { warn: true }) };
  await save(merged);
  return merged;
};
