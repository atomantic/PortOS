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
 * Identity comes from data/instances.json (self.instanceId / self.name). If
 * `self` is missing — possible on a brand-new install where the migration
 * runner fires before `ensureSelf()` in server boot — we lazy-create the
 * identity here using the same shape `ensureSelf()` uses (`crypto.randomUUID()`
 * + `os.hostname()`) and persist it. Without this, the migration would write
 * the literal `'unknown'` as a phantom author forever — `setAnnotation` refuses
 * to write under `'unknown'`, and `annotationsSync.flushAll` refuses to export
 * it, so the user's pre-multi-author notes would become unrecoverable.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import crypto from 'crypto';

// Mirrors `safeJSONParse` in server/lib/fileUtils.js — a syntactically corrupt
// instances.json must NOT crash the migration runner, otherwise this fix would
// itself be a new boot-blocker. Treat parse failure as "no usable file" and let
// the caller fall back to the default shape (which triggers fresh-identity
// creation, the same recovery the in-server reader provides).
async function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️ migration 014: ${path} is not valid JSON (${err.message}); falling back to defaults`);
    return fallback;
  }
}

// Self-contained ensureSelf: matches `server/services/instances.js`
// (`{ instanceId: randomUUID(), name: hostname() }`) but avoids importing the
// service so this migration doesn't drag in peer-relay/event-emitter modules
// at migration-runner time (which can also run via the `npm run migrations`
// CLI with no server lifecycle).
async function ensureSelfIdentity(instancesPath) {
  const data = await readJsonOr(instancesPath, { self: null, peers: [] });
  // Strict: only reuse a real-looking identity. Reject the `'unknown'` sentinel
  // (this is exactly the value we're trying to never persist), reject non-string
  // shapes, and reject empty / whitespace-only / padded-sentinel strings —
  // any of those would re-introduce the phantom-author bug we're fixing.
  // Trim before comparing so `'  unknown  '` is rejected the same as `'unknown'`.
  // Fall through to fresh-identity creation when invalid.
  const rawId = data?.self?.instanceId;
  const normalizedId = typeof rawId === 'string' ? rawId.trim() : '';
  if (normalizedId && normalizedId !== 'unknown') {
    return data.self;
  }
  const self = { instanceId: crypto.randomUUID(), name: os.hostname() };
  const next = {
    self,
    peers: Array.isArray(data?.peers) ? data.peers : [],
  };
  await writeFile(instancesPath, JSON.stringify(next, null, 2));
  console.log(`🌐 migration 014: created instance identity ${self.name} (${self.instanceId})`);
  return self;
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
    const self = await ensureSelfIdentity(instancesPath);
    const instanceId = self.instanceId;
    const authorName = self.name || '';

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
