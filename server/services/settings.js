import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

const SETTINGS_FILE = join(PATHS.data, 'settings.json');

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
  return safeJSONParse(raw, {});
};

const save = async (settings) => {
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  settingsEvents.emit('settings:updated', settings);
};

export const getSettings = load;
export const saveSettings = save;

export const updateSettings = async (patch) => {
  const current = await load();
  const merged = { ...current, ...patch };
  await save(merged);
  return merged;
};
