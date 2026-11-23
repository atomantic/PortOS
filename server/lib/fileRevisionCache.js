/**
 * Bounded LRU of per-file parse results keyed by path and guarded by a file
 * revision string, so a periodic scan re-parses only files that changed.
 */

import { stat } from 'fs/promises';

/** `dev:ino:size:mtimeMs` for a file, or null when it is gone. */
export async function fileRevision(path) {
  const info = await stat(path).catch(() => null);
  return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : null;
}

/** Revision of a SQLite DB plus its `-wal` (a missing WAL is part of the revision). */
export async function sqliteRevision(path) {
  const main = await fileRevision(path);
  if (main == null) return null;
  const wal = await fileRevision(`${path}-wal`);
  return `${main}|${wal ? wal.split(':').slice(2).join(':') : 'nowal'}`;
}

export function createRevisionCache(maxEntries = 2000) {
  const entries = new Map();
  return {
    /** The cached value when `revision` still matches, else undefined. */
    get(path, revision) {
      const hit = entries.get(path);
      if (!hit || hit.revision !== revision) return undefined;
      entries.delete(path);
      entries.set(path, hit);
      return hit.value;
    },
    set(path, revision, value) {
      entries.delete(path);
      entries.set(path, { revision, value });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    get size() { return entries.size; },
  };
}
