// Machine-local integration keys. Only settings.js writes this store at runtime,
// inside its existing write queue. No public reader returns key material.
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, safeJSONParse } from '../lib/fileUtils.js';
import { CREDENTIALS } from '../lib/credentialRegistry.js';
import { isPlainObject } from '../lib/objects.js';

export const PRIVATE_CREDENTIALS = CREDENTIALS.filter(entry => entry.privateStore);

export function credentialValue(settings, entry) {
  return entry.settingsPath.split('.').reduce((value, key) => value?.[key], settings);
}

export function putCredential(settings, entry, value) {
  const parts = entry.settingsPath.split('.');
  const leaf = parts.pop();
  let parent = settings;
  for (const key of parts) {
    if (!isPlainObject(parent[key])) parent[key] = {};
    parent = parent[key];
  }
  parent[leaf] = value;
}

export async function readPrivateKeys(dataDir) {
  const raw = await readFile(join(dataDir, 'private/api-keys.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw new Error('Private key store could not be read');
  });
  if (raw === null) return {};
  // Never include malformed input (which can contain secrets) in parser errors.
  const store = safeJSONParse(raw, null);
  if (!isPlainObject(store) || store.schemaVersion !== 1 || !isPlainObject(store.keys)
    || Object.values(store.keys).some(value => typeof value !== 'string')) {
    throw new Error('Private key store has an unsupported format');
  }
  return store.keys;
}

export async function hydratePrivateKeys(settings, dataDir) {
  const keys = await readPrivateKeys(dataDir);
  for (const entry of PRIVATE_CREDENTIALS) {
    if (Object.hasOwn(keys, entry.id)) putCredential(settings, entry, keys[entry.id]);
  }
  return settings;
}

export async function persistPrivateKeys(settings, dataDir, { preserveExisting = false } = {}) {
  const keys = await readPrivateKeys(dataDir);
  const publicSettings = structuredClone(settings);
  let changed = false;
  for (const entry of PRIVATE_CREDENTIALS) {
    const value = credentialValue(settings, entry);
    if (typeof value !== 'string') continue;
    if (!preserveExisting || !Object.hasOwn(keys, entry.id)) {
      const normalized = value.trim(); // Empty is a tombstone: legacy values cannot reappear.
      if (keys[entry.id] !== normalized) changed = true;
      keys[entry.id] = normalized;
    }
    const parts = entry.settingsPath.split('.');
    const leaf = parts.pop();
    const parent = parts.reduce((object, key) => object?.[key], publicSettings);
    if (parent) delete parent[leaf];
  }
  if (Object.keys(keys).length) {
    const directory = join(dataDir, 'private');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = join(directory, 'api-keys.json');
    // Directory permissions protect even pre-existing files while tightened.
    if (changed) await atomicWrite(file, { schemaVersion: 1, keys });
    await chmod(file, 0o600);
  }
  return publicSettings;
}
