/**
 * Rewrap data/media-annotations.json into the multi-author shape.
 *
 * Before: `{ annotations: { [key]: { starred, note, updatedAt } } }`
 * After:  `{ annotations: { [key]: { authors: { [instanceId]: { authorName, starred, note, updatedAt } } } } }`
 *
 * Every existing entry is attributed to the local instance — the user wrote
 * those notes here, so they should stay editable in their own textarea and
 * (once exported) appear attributed on peers' machines. Idempotent: any entry
 * that already has an `authors` field is left alone.
 *
 * Reads identity from data/instances.json (self.instanceId / self.name).
 * Falls back to a deterministic placeholder if instances.json is missing —
 * the multi-author service still works with a `'unknown'` author entry, and
 * the placeholder gets overwritten the first time the user edits the note
 * (setAnnotation always stamps with the real instanceId).
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

async function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

export default {
  async up({ rootDir }) {
    const annotationsPath = join(rootDir, 'data', 'media-annotations.json');
    if (!existsSync(annotationsPath)) {
      return { changed: false, reason: 'no-annotations-file' };
    }
    const state = await readJsonOr(annotationsPath, { annotations: {} });
    const entries = state?.annotations && typeof state.annotations === 'object'
      ? state.annotations
      : {};

    const instancesPath = join(rootDir, 'data', 'instances.json');
    const instances = await readJsonOr(instancesPath, { self: null });
    const instanceId = instances?.self?.instanceId || 'unknown';
    const authorName = instances?.self?.name || '';

    let migrated = 0;
    let alreadyCurrent = 0;
    const next = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.authors && typeof entry.authors === 'object') {
        next[key] = entry;
        alreadyCurrent += 1;
        continue;
      }
      const starred = entry.starred === true;
      const note = typeof entry.note === 'string' ? entry.note : '';
      if (!starred && !note) continue;
      const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString();
      next[key] = {
        authors: {
          [instanceId]: { authorName, starred, note, updatedAt },
        },
      };
      migrated += 1;
    }

    if (migrated === 0) {
      return { changed: false, alreadyCurrent };
    }
    await writeFile(annotationsPath, JSON.stringify({ annotations: next }, null, 2));
    console.log(`📝 migration 014: attributed ${migrated} annotation(s) to instanceId=${instanceId} (already-multi-author=${alreadyCurrent})`);
    return { changed: true, migrated, alreadyCurrent };
  },
};
