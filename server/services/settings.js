import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

const SETTINGS_FILE = join(PATHS.data, 'settings.json');

const load = async () => {
  const raw = await readFile(SETTINGS_FILE, 'utf-8').catch(() => '{}');
  return safeJSONParse(raw, {});
};

const save = async (settings) => {
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
};

export const getSettings = load;

export const updateSettings = async (patch) => {
  const current = await load();
  const merged = { ...current, ...patch };
  await save(merged);
  return merged;
};
