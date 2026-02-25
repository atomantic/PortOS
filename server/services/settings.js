import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeJSONParse } from '../lib/fileUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = join(__dirname, '..', '..', 'data', 'settings.json');

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
