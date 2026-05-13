/**
 * One-shot merge of legacy World Builder collections.
 *
 * The pre-merge render route minted a fresh collection named
 *   `World: <world name> — YYYY-MM-DD HH:MM`
 * on every batch render. The new route reuses a single `World: <world name>`
 * bucket per world. This migration collapses the legacy date-suffixed rows
 * into one bucket per base name, dedupes items, and rewrites every
 * World Builder run whose collectionId pointed at a removed row.
 *
 * Idempotent — a re-run finds no date-suffixed names and exits cleanly.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const ITEMS_MAX = 5000;
const NAME_MAX_LENGTH = 80;

// Match "World: <base> — YYYY-MM-DD[ HH:MM]". The em-dash is U+2014 with
// surrounding ASCII spaces, matching the pre-merge `worldBuilder.js` format.
const DATE_SUFFIX_RE = /^(World: .+?)\s+—\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?$/;

const itemKey = (it) => `${it.kind}:${it.ref}`;

const readJson = async (path, fallback) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return fallback;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

export default {
  async up({ rootDir }) {
    const collectionsPath = join(rootDir, 'data', 'media-collections.json');
    const runsPath = join(rootDir, 'data', 'world-builder.json');

    const collectionsDoc = await readJson(collectionsPath, { collections: [] });
    const collections = Array.isArray(collectionsDoc.collections)
      ? collectionsDoc.collections
      : [];

    const groups = new Map();
    for (const c of collections) {
      if (!c || typeof c.name !== 'string') continue;
      const m = c.name.match(DATE_SUFFIX_RE);
      if (!m) continue;
      const base = m[1].trim().slice(0, NAME_MAX_LENGTH);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(c);
    }

    if (groups.size === 0) {
      console.log('🌍 migration: no date-suffixed World collections found, skipping');
      return;
    }

    // remap: removed sourceId -> surviving target id (used to fix run refs).
    const remap = new Map();
    const removedIds = new Set();
    const byId = new Map(collections.map((c) => [c.id, c]));

    for (const [baseName, sources] of groups) {
      // Reuse an already-clean collection if the user renamed one of them
      // manually; otherwise the first source is promoted to the target.
      const sourceSet = new Set(sources);
      const existingTarget = collections.find(
        (c) => !sourceSet.has(c) && typeof c.name === 'string'
          && c.name.toLowerCase() === baseName.toLowerCase(),
      );

      const mergedItems = [];
      const seen = new Set();
      const candidates = existingTarget ? [existingTarget, ...sources] : sources;
      for (const src of candidates) {
        if (!Array.isArray(src.items)) continue;
        for (const it of src.items) {
          if (!it || typeof it.kind !== 'string' || typeof it.ref !== 'string') continue;
          const key = itemKey(it);
          if (seen.has(key)) continue;
          seen.add(key);
          mergedItems.push(it);
          if (mergedItems.length >= ITEMS_MAX) break;
        }
        if (mergedItems.length >= ITEMS_MAX) break;
      }
      // Chronological order so the auto-cover (newest) matches what the
      // live sanitizeCollection picks.
      mergedItems.sort((a, b) => {
        const aT = Date.parse(a.addedAt || '');
        const bT = Date.parse(b.addedAt || '');
        return (Number.isFinite(aT) ? aT : 0) - (Number.isFinite(bT) ? bT : 0);
      });

      const allCreatedAts = candidates
        .map((c) => Date.parse(c.createdAt || ''))
        .filter(Number.isFinite);
      const earliestCreatedAt = allCreatedAts.length
        ? new Date(Math.min(...allCreatedAts)).toISOString()
        : new Date().toISOString();

      const target = existingTarget ?? sources[0];
      const targetId = target.id;
      const itemKeys = new Set(mergedItems.map(itemKey));
      const coverKey =
        typeof target.coverKey === 'string' && itemKeys.has(target.coverKey)
          ? target.coverKey
          : null;

      byId.set(targetId, {
        ...target,
        id: targetId,
        name: baseName,
        description: target.description || `World Builder renders for "${baseName.replace(/^World:\s*/, '')}"`,
        coverKey,
        items: mergedItems,
        createdAt: earliestCreatedAt,
        updatedAt: new Date().toISOString(),
      });

      for (const src of sources) {
        if (src.id === targetId) continue;
        remap.set(src.id, targetId);
        removedIds.add(src.id);
        byId.delete(src.id);
      }

      console.log(
        `🌍 merged ${sources.length} collection${sources.length === 1 ? '' : 's'} (${mergedItems.length} items) → "${baseName}"`,
      );
    }

    // Preserve original ordering; survivors keep their slot, removed ids drop.
    const nextCollections = [];
    const seenIds = new Set();
    for (const c of collections) {
      if (!c?.id || seenIds.has(c.id) || removedIds.has(c.id)) continue;
      const updated = byId.get(c.id) ?? c;
      seenIds.add(updated.id);
      nextCollections.push(updated);
    }

    await writeJson(collectionsPath, { collections: nextCollections });

    const runsDoc = await readJson(runsPath, null);
    if (runsDoc && Array.isArray(runsDoc.runs) && remap.size) {
      let touched = 0;
      const nextRuns = runsDoc.runs.map((r) => {
        if (!r || typeof r.collectionId !== 'string') return r;
        const target = remap.get(r.collectionId);
        if (!target) return r;
        touched++;
        return { ...r, collectionId: target };
      });
      if (touched > 0) {
        await writeJson(runsPath, { ...runsDoc, runs: nextRuns });
        console.log(`🌍 remapped ${touched} run collectionId reference${touched === 1 ? '' : 's'}`);
      }
    }
  },
};
