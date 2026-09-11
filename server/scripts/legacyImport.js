// Shared filesystem boundaries for the legacy creative importers. Only ENOENT
// means absence; a present source that cannot be verified keeps import pending.
import { readFile, stat, rename } from 'fs/promises';

const absent = error => {
  if (error.code === 'ENOENT') return null;
  throw error;
};

export async function legacyDirectory(path) {
  const entry = await stat(path).catch(absent);
  if (entry && !entry.isDirectory()) throw new Error('Legacy import source is not a directory');
  return entry;
}

export async function readLegacyJSON(path) {
  const raw = await readFile(path, 'utf8').then(value => ({ value }), error => ({ error }));
  if (raw.error) return { status: raw.error.code === 'ENOENT' ? 'missing' : 'invalid' };
  return Promise.resolve().then(() => JSON.parse(raw.value)).then(
    value => value && typeof value === 'object' ? { status: 'valid', value } : { status: 'invalid' },
    () => ({ status: 'invalid' }),
  );
}

export async function parkLegacyFile(path, aside) {
  // Preserve an older recovery copy; do not replace it with a different source.
  if (await stat(aside).catch(absent)) return false;
  return rename(path, aside).then(() => true, () => false);
}

export function incompleteImport(domain, counts, incomplete) {
  console.warn(`⚠️ ${domain}→DB import incomplete: ${incomplete} source(s) could not be verified or parked; retained for retry`);
  return { ok: true, reason: 'incomplete', ...counts, incomplete };
}
