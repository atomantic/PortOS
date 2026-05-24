/**
 * Canonicalize universe/series-LINKED media-collection ids to a deterministic
 * scheme so federated peers converge instead of duplicating.
 *
 * Before this migration every machine minted a random UUID for its
 * "Universe: X" / "Series: Y" collection via `findOrCreateUniverseCollection`
 * (et al). Because per-record collection sync keys on `id`, two machines'
 * copies of the SAME universe's collection had different ids — so integrity
 * reported both as "local only" and the merge created a duplicate on every
 * peer instead of reconciling.
 *
 * The live code now derives the id from the owner: `uc-<universeId>` /
 * `sc-<seriesId>` (see `linkedCollectionId` in services/mediaCollections.js —
 * KEEP THIS IN SYNC with that helper). This migration rewrites existing
 * linked-collection ids to that scheme on each machine independently; once both
 * have run, the same universe's collection carries the same id everywhere and
 * the next sync cycle merges (union of items) instead of duplicating.
 *
 * If a machine already accumulated duplicates (e.g. it received a peer's
 * differently-id'd copy before this shipped), every collection for the same
 * owner collapses to the one canonical id, unioning their items — that's the
 * "clean up duplicates" step.
 *
 * Tombstones are left untouched: `deleteCollection` nulls universeId/seriesId,
 * so a deleted collection has no owner link to canonicalize; its old-id
 * tombstone simply propagates as a delete for an id no live record uses and is
 * pruned by tombstone GC.
 *
 * Also rewrites any `mediaCollection` peer subscriptions whose `recordId` was an
 * old collection id (regenerating the derived subscription id and de-duping).
 *
 * Idempotent: a second run finds every linked id already canonical → no-op.
 */

import { mkdir, readFile, writeFile, rename, stat } from 'fs/promises';
import { join } from 'path';

// Inlined copy of services/mediaCollections.js#linkedCollectionId — migrations
// stay dependency-light (importing the service would pull its whole module
// graph + side effects). Keep the scheme identical to that helper.
const linkedIdFor = (c) => {
  if (c.universeId) return `uc-${c.universeId}`;
  if (c.seriesId) return `sc-${c.seriesId}`;
  return null;
};

const itemKey = (it) => `${it?.kind}:${it?.ref}`;
const parseMs = (s) => { const ms = Date.parse(s || ''); return Number.isFinite(ms) ? ms : -Infinity; };

// Union two collections' items: dedupe by kind:ref, keep the earliest addedAt
// (a replay shouldn't bump an item's age). Mirrors mergeCollectionItems intent.
const unionItems = (a = [], b = []) => {
  const byKey = new Map();
  for (const it of [...(a || []), ...(b || [])]) {
    if (!it || typeof it.ref !== 'string') continue;
    const k = itemKey(it);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, it); continue; }
    if (parseMs(it.addedAt) < parseMs(prev.addedAt)) byKey.set(k, it);
  }
  return [...byKey.values()];
};

/**
 * Pure transform. Returns `{ collections, idMap, merged, renamed }`.
 *   - idMap: oldId -> newId for every rewritten linked collection.
 *   - merged: count of collections folded into an existing canonical id.
 *   - renamed: count of collections whose id changed (incl. merged).
 */
export function canonicalizeCollections(input) {
  const list = Array.isArray(input) ? input : [];
  const idMap = {};
  let merged = 0;
  let renamed = 0;

  // Tombstones + standalone (no owner link) pass through unchanged.
  const passthrough = [];
  // Canonical-id -> merged live record.
  const byCanon = new Map();

  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const canon = c.deleted === true ? null : linkedIdFor(c);
    if (!canon) { passthrough.push(c); continue; }
    if (c.id !== canon) { idMap[c.id] = canon; renamed += 1; }
    const existing = byCanon.get(canon);
    if (!existing) {
      byCanon.set(canon, { ...c, id: canon });
      continue;
    }
    // Two records collapse to the same canonical id → merge (LWW scalars on the
    // newer updatedAt; union items; earliest createdAt wins).
    merged += 1;
    const remoteWins = parseMs(c.updatedAt) > parseMs(existing.updatedAt);
    const scalar = remoteWins ? c : existing;
    const items = unionItems(existing.items, c.items);
    const presentKeys = new Set(items.map(itemKey));
    byCanon.set(canon, {
      ...existing,
      id: canon,
      name: scalar.name,
      description: scalar.description,
      coverKey: scalar.coverKey && presentKeys.has(scalar.coverKey) ? scalar.coverKey : null,
      universeId: scalar.universeId ?? existing.universeId ?? null,
      seriesId: scalar.seriesId ?? existing.seriesId ?? null,
      items,
      createdAt: parseMs(c.createdAt) < parseMs(existing.createdAt) ? c.createdAt : existing.createdAt,
      updatedAt: remoteWins ? c.updatedAt : existing.updatedAt,
    });
  }

  return { collections: [...passthrough, ...byCanon.values()], idMap, merged, renamed };
}

/**
 * Rewrite mediaCollection subscription recordIds via `idMap`, regenerating the
 * derived subscription id (`peer-mediaCollection-<recordId>-<peerId>`) and
 * de-duping collisions (keep the most-recently-pushed). Returns the new array.
 */
export function rewriteSubscriptions(subs, idMap) {
  const list = Array.isArray(subs) ? subs : [];
  const seen = new Map();
  for (const s of list) {
    if (!s || typeof s !== 'object') { continue; }
    let next = s;
    if (s.recordKind === 'mediaCollection' && idMap[s.recordId]) {
      const recordId = idMap[s.recordId];
      next = { ...s, recordId, id: `peer-mediaCollection-${recordId}-${s.peerId}` };
    }
    const existing = seen.get(next.id);
    if (!existing) { seen.set(next.id, next); continue; }
    // Collision after rewrite — keep whichever was pushed most recently.
    if (parseMs(next.lastPushedAt) > parseMs(existing.lastPushedAt)) seen.set(next.id, next);
  }
  return [...seen.values()];
}

const fileExists = (p) => stat(p).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
const readJson = async (p, fallback) => {
  const raw = await readFile(p, 'utf-8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};
const writeJsonAtomic = async (p, value) => {
  const tmp = `${p}.tmp-038`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, p);
};

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const collectionsPath = join(dataDir, 'media-collections.json');
    const subsPath = join(dataDir, 'sharing', 'peer_subscriptions.json');

    if (!(await fileExists(collectionsPath))) {
      console.log('📦 migration 038: no media-collections.json — fresh install, no-op');
      return { ok: true, reason: 'no-collections' };
    }

    const doc = await readJson(collectionsPath, { collections: [] });
    if (!doc || !Array.isArray(doc.collections)) {
      console.log('📦 migration 038: media-collections.json has no collections array — no-op');
      return { ok: true, reason: 'empty' };
    }

    const { collections, idMap, merged, renamed } = canonicalizeCollections(doc.collections);
    if (renamed === 0) {
      console.log('📦 migration 038: all linked-collection ids already canonical — no-op');
      return { ok: true, reason: 'already-canonical' };
    }

    await mkdir(dataDir, { recursive: true });
    await writeJsonAtomic(collectionsPath, { ...doc, collections });

    let subsDeduped = 0;
    if (await fileExists(subsPath)) {
      const subsDoc = await readJson(subsPath, { subscriptions: [] });
      if (subsDoc && Array.isArray(subsDoc.subscriptions)) {
        const before = subsDoc.subscriptions.length;
        const next = rewriteSubscriptions(subsDoc.subscriptions, idMap);
        subsDeduped = before - next.length; // subscriptions collapsed by id-rewrite dedupe
        await writeJsonAtomic(subsPath, { ...subsDoc, subscriptions: next });
      }
    }

    console.log(`📦 migration 038: canonicalized ${renamed} linked-collection id(s), merged ${merged} duplicate(s), deduped ${subsDeduped} mediaCollection subscription(s)`);
    return { ok: true, reason: 'migrated', renamed, merged, subsDeduped };
  },
};
