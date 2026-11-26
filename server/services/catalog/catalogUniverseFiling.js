/**
 * Catalog → universe collection filing.
 *
 * A Casting / Environments / Objects record belongs to a universe when it is
 * linked to it directly, or to a story that sits in it (a music video's
 * concept universe, a storyboard's or a Pipeline series' universe, including a
 * storyboard whose panels use the record). Every portrait and reference image
 * on such a record goes into that universe's "Universe: <name>" collection, so
 * a reference remixed or generated from the record page lands beside the
 * universe's other renders and not only in whichever music video it came from.
 *
 * Independently of universes, every image also goes into its record type's
 * library-wide collection (Cast, Environments, Objects) via
 * `fileCatalogImagesIntoTypeCollections`.
 *
 * `fileCatalogImagesIntoUniverses` is idempotent: it adds only what each
 * collection lacks, never removes, and skips an image the user already took
 * out of that collection (its `removedItems` stamp). The same function answers
 * the one-time integrity pass (`dryRun` reports without writing) and the
 * live filing below, which runs after any catalog media or ref change.
 */

import { access, readdir } from 'node:fs/promises';
import { join } from 'path';
import { query } from '../../lib/db.js';
import { PATHS } from '../../lib/paths.js';
import { CANONICAL_REFS_CTE, storyboardPanelMembersSql } from '../catalogDB/shared.js';
import { catalogEvents } from './catalogEvents.js';
import {
  CATALOG_TYPE_COLLECTIONS, ERR_NOT_FOUND, ITEMS_MAX, REF_MAX_LENGTH, bulkUpdateCollectionItems, findCollectionByUniverseId,
  findOrCreateCatalogTypeCollection, findOrCreateUniverseCollection, getCollection,
} from '../mediaCollections.js';

// The scoped queries resolve only the changed IDs before looking up catalog
// rows. The array predicates push through the identity views to their indexes.
const SCOPED_INGREDIENT_IDS = `ARRAY(SELECT DISTINCT catalog_canonical_ingredient_id(requested.id)
  FROM unnest($1::text[]) AS requested(id))`;
const SCOPED_MEMBER_IDS = 'ARRAY(SELECT DISTINCT member_id FROM target_members)';

const targetMembersSql = (scoped, typeOnly = false) => `target_members AS MATERIALIZED (
  SELECT i.id AS cid, i.name, i.type, member_id FROM catalog_ingredients i
    CROSS JOIN LATERAL unnest(catalog_identity_member_ids(i.id)) AS member_id
   WHERE i.deleted = false
     AND ${scoped ? `i.id = ANY(${SCOPED_INGREDIENT_IDS})` : 'i.id = catalog_canonical_ingredient_id(i.id)'}
     ${typeOnly ? `AND i.type = ANY($${scoped ? 2 : 1}::text[])` : ''})`;

const SCOPED_REFS_CTE = `canonical_refs AS MATERIALIZED (
  SELECT catalog_canonical_ingredient_id(ingredient_id) AS cid, ref_kind, ref_id
    FROM catalog_identity_read_refs
   WHERE deleted = false AND ingredient_id = ANY(${SCOPED_MEMBER_IDS}))`;

const placementMediaJoinSql = (scoped) => `JOIN catalog_identity_read_media m ON m.ingredient_id = tm.member_id
     AND m.deleted = false AND m.kind IN ('portrait', 'reference')
     AND (m.role IS NULL OR m.role NOT LIKE 'archive:%')
     ${scoped ? `AND m.ingredient_id = ANY(${SCOPED_MEMBER_IDS})` : ''}`;

// (record, universe, image) for every live portrait/reference on a record that
// belongs to a live universe.
const placementsSql = (scoped) => `WITH ${targetMembersSql(scoped)}, ${scoped ? SCOPED_REFS_CTE : CANONICAL_REFS_CTE},
  member_universes AS (
    SELECT r.cid, r.ref_id AS universe_id FROM canonical_refs r WHERE r.ref_kind = 'universe'
    UNION SELECT r.cid, NULLIF(m.data#>>'{concept,universeId}', '') FROM canonical_refs r
      JOIN music_video_projects m ON r.ref_kind = 'music-video' AND m.id = r.ref_id AND m.deleted = false
    UNION SELECT r.cid, s.universe_id FROM canonical_refs r
      JOIN storyboards s ON r.ref_kind = 'storyboard' AND s.id = r.ref_id AND s.deleted = false
    UNION SELECT pm.cid, pm.universe_id
      FROM (${storyboardPanelMembersSql({ byUniverse: true, memberIdsSql: scoped ? SCOPED_MEMBER_IDS : undefined })}) pm
    UNION SELECT r.cid, p.universe_id FROM canonical_refs r
      JOIN pipeline_series p ON r.ref_kind = 'series' AND p.id = r.ref_id AND p.deleted = false)
  SELECT DISTINCT tm.cid AS ingredient_id, tm.name AS ingredient_name, u.id AS universe_id, u.name AS universe_name, m.media_key
    FROM member_universes mu
    JOIN universes u ON u.id = mu.universe_id AND u.deleted = false
    JOIN target_members tm ON tm.cid = mu.cid
    ${placementMediaJoinSql(scoped)}
   ORDER BY u.id, tm.cid, m.media_key`;
const SCOPED_PLACEMENTS_SQL = placementsSql(true);
const FULL_PLACEMENTS_SQL = placementsSql(false);

const loadPlacements = async (ingredientIds) => {
  const { rows } = ingredientIds
    ? await query(SCOPED_PLACEMENTS_SQL, [ingredientIds])
    : await query(FULL_PLACEMENTS_SQL);
  return rows.map((row) => ({
    ingredientId: row.ingredient_id, ingredientName: row.ingredient_name,
    universeId: row.universe_id, universeName: row.universe_name, mediaKey: row.media_key,
  }));
};

// (type, image) for every live portrait/reference on a canonical record of a
// type with a library collection.
const typePlacementsSql = (scoped) => `WITH ${targetMembersSql(scoped, true)}
  SELECT DISTINCT tm.type, m.media_key
    FROM target_members tm
    ${placementMediaJoinSql(scoped)}
   ORDER BY tm.type, m.media_key`;
const SCOPED_TYPE_PLACEMENTS_SQL = typePlacementsSql(true);
const FULL_TYPE_PLACEMENTS_SQL = typePlacementsSql(false);
const COLLECTION_TYPES = Object.keys(CATALOG_TYPE_COLLECTIONS);

const loadTypePlacements = async (ingredientIds) => {
  const { rows } = ingredientIds
    ? await query(SCOPED_TYPE_PLACEMENTS_SQL, [ingredientIds, COLLECTION_TYPES])
    : await query(FULL_TYPE_PLACEMENTS_SQL, [COLLECTION_TYPES]);
  return rows.map((row) => ({ type: row.type, mediaKey: row.media_key }));
};

// Only a gallery image (a data/images basename) can be a collection item.
const isGalleryBasename = (key) => typeof key === 'string' && key.length > 0 && key.length <= REF_MAX_LENGTH
  && !/[:/\\]/.test(key) && !key.includes('\0') && key !== '.' && key !== '..';
const isGalleryImage = (key) => access(join(PATHS.images, key)).then(() => true, () => false);
const readGallery = () => readdir(PATHS.images, { withFileTypes: true }).catch(() => null);

const findCatalogTypeCollection = (type) => getCollection(CATALOG_TYPE_COLLECTIONS[type].id).catch((error) => {
  if (error.code === ERR_NOT_FOUND) return null;
  throw error;
});

const deps = {
  loadPlacements, loadTypePlacements, isGalleryImage, readGallery, findCollectionByUniverseId, findOrCreateUniverseCollection,
  findCatalogTypeCollection, findOrCreateCatalogTypeCollection, bulkUpdateCollectionItems,
};

// A full pass inventories the gallery once on first use. A scoped pass only
// checks candidate keys, sharing results when images land in multiple albums.
const createImageCheck = (scoped) => {
  let inventory;
  const checked = new Map();
  const fold = (key) => key.normalize('NFD').toLowerCase();
  return async (key) => {
    if (!isGalleryBasename(key)) return false;
    if (!scoped) {
      inventory ??= deps.readGallery().then((entries) => entries && ({
        linked: new Map(entries.map((entry) => [entry.name, entry.isSymbolicLink()])),
        variants: new Set(entries.map((entry) => fold(entry.name))),
      }));
      const gallery = await inventory;
      if (gallery?.linked.get(key) === false) return true;
      // Symlink targets and case/Unicode variants depend on filesystem lookup.
      if (gallery && !gallery.variants.has(fold(key))) return false;
    }
    if (!checked.has(key)) checked.set(key, deps.isGalleryImage(key));
    return checked.get(key);
  };
};

export const __setUniverseFilingDepsForTests = (overrides) => Object.assign(deps, overrides);

/**
 * File every image of the given records (all records when `ingredientIds` is
 * null) into the collections of the universes they belong to. Returns a report
 * per universe: images already there, ones added (or that would be, on a dry
 * run), ones the user removed from that collection, and ones missing locally.
 */
export async function fileCatalogImagesIntoUniverses({ ingredientIds = null, dryRun = false } = {}) {
  return fileUniversePlacements({ ingredientIds, dryRun }, createImageCheck(Boolean(ingredientIds?.length)));
}

async function fileUniversePlacements({ ingredientIds, dryRun }, imageExists) {
  const placements = await deps.loadPlacements(ingredientIds?.length ? ingredientIds : null);
  const byUniverse = new Map();
  for (const placement of placements) {
    const entry = byUniverse.get(placement.universeId)
      || { universeId: placement.universeId, universeName: placement.universeName, images: new Map() };
    const records = entry.images.get(placement.mediaKey) || new Set();
    records.add(placement.ingredientName || placement.ingredientId);
    entry.images.set(placement.mediaKey, records);
    byUniverse.set(placement.universeId, entry);
  }

  const universes = [];
  for (const { universeId, universeName, images } of byUniverse.values()) {
    const existing = await deps.findCollectionByUniverseId(universeId);
    const present = new Set((existing?.items || []).map((item) => `${item.kind}:${item.ref}`));
    const removed = existing?.removedItems || {};
    const report = { universeId, universeName, collectionId: existing?.id || null,
      alreadyFiled: 0, toAdd: [], userRemoved: [], missingFile: [] };
    for (const [mediaKey, records] of images) {
      const key = `image:${mediaKey}`;
      if (present.has(key)) report.alreadyFiled += 1;
      else if (removed[key]) report.userRemoved.push(mediaKey);
      else if (!await imageExists(mediaKey)) report.missingFile.push(mediaKey);
      else report.toAdd.push({ mediaKey, records: [...records].sort() });
    }
    report.added = 0;
    if (!dryRun && report.toAdd.length > 0) {
      const collection = existing || await deps.findOrCreateUniverseCollection({
        universeId, universeName: universeName || universeId,
        description: `Universe Builder renders for "${universeName || universeId}"`,
      });
      report.collectionId = collection.id;
      const result = await deps.bulkUpdateCollectionItems(collection.id, {
        add: report.toAdd.map(({ mediaKey }) => ({ kind: 'image', ref: mediaKey })),
      });
      report.added = result.added;
    }
    universes.push(report);
  }
  return {
    dryRun,
    universes,
    totals: {
      universes: universes.length,
      alreadyFiled: universes.reduce((sum, u) => sum + u.alreadyFiled, 0),
      toAdd: universes.reduce((sum, u) => sum + u.toAdd.length, 0),
      added: universes.reduce((sum, u) => sum + u.added, 0),
      userRemoved: universes.reduce((sum, u) => sum + u.userRemoved.length, 0),
      missingFile: universes.reduce((sum, u) => sum + u.missingFile.length, 0),
    },
  };
}

/**
 * File every image of the given records (all when `ingredientIds` is null)
 * into its type's collection (Cast, Environments, Objects). Adds only what is
 * missing and keeps images the user removed from that collection out
 * (`preserveRemovals`). Returns the number of images added.
 */
export async function fileCatalogImagesIntoTypeCollections({ ingredientIds = null } = {}) {
  const { added, types } = await fileTypePlacements(ingredientIds, createImageCheck(Boolean(ingredientIds?.length)));
  return { added, types };
}

async function fileTypePlacements(ingredientIds, imageExists) {
  const placements = await deps.loadTypePlacements(ingredientIds?.length ? ingredientIds : null);
  const byType = new Map();
  for (const { type, mediaKey } of placements) {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(mediaKey);
  }
  let added = 0;
  let types = 0;
  let updatedCollections = 0;
  for (const [type, mediaKeys] of byType) {
    try {
      const existing = await deps.findCatalogTypeCollection(type);
      // A library-wide collection can outgrow the item cap: file what fits
      // instead of rejecting the whole batch on every pass.
      const present = new Set((existing?.items || []).map((item) => item.ref));
      const room = Math.max(0, ITEMS_MAX - present.size);
      const add = [];
      let hasImages = false;
      for (const ref of mediaKeys) {
        if (present.has(ref)) hasImages = true;
        else if (await imageExists(ref)) {
          hasImages = true;
          if (add.length < room) add.push({ kind: 'image', ref });
        }
        if (hasImages && add.length === room) break;
      }
      if (hasImages) types += 1;
      if (!add.length) continue;
      const collection = existing || await deps.findOrCreateCatalogTypeCollection(type);
      const result = await deps.bulkUpdateCollectionItems(collection.id, { add }, { preserveRemovals: true });
      added += result.added;
      if (result.added > 0) updatedCollections += 1;
    } catch (error) {
      console.error(`❌ catalog ${type} collection filing failed: ${error.message}`);
    }
  }
  return { added, types, updatedCollections };
}

/** Both filings for the given records (all when null): `{ added, updatedCollections }`. */
export async function fileCatalogImages({ ingredientIds = null } = {}) {
  const imageExists = createImageCheck(Boolean(ingredientIds?.length));
  const [{ universes }, typed] = await Promise.all([
    fileUniversePlacements({ ingredientIds, dryRun: false }, imageExists),
    fileTypePlacements(ingredientIds, imageExists),
  ]);
  const filedUniverses = universes.filter((u) => u.added > 0);
  return {
    added: filedUniverses.reduce((sum, u) => sum + u.added, 0) + typed.added,
    updatedCollections: filedUniverses.length + typed.updatedCollections,
  };
}

// Live filing: catalog media/ref writes announce `assets-changed`, record-level
// changes (completion hook, universe membership) `primitive-changed`. Bursts
// for one record coalesce, and one pass runs at a time, so a batch of renders
// files with one collection write per universe.
const FILING_DELAY_MS = 1000;
const pending = new Set();
let timer = null;
let running = Promise.resolve();
let initialized = false;

const flush = () => {
  timer = null;
  const ingredientIds = [...pending];
  pending.clear();
  running = running.then(async () => {
    const { added, updatedCollections } = await fileCatalogImages({ ingredientIds });
    if (added > 0) console.log(`🌍 Filed ${added} catalog image(s) into ${updatedCollections} collection(s)`);
  }).catch((err) => console.error(`❌ catalog universe filing failed: ${err?.message || err}`));
};

const schedule = (event) => {
  if (typeof event?.ingredientId !== 'string' || !event.ingredientId) return;
  pending.add(event.ingredientId);
  if (!timer) timer = setTimeout(flush, FILING_DELAY_MS);
};

// Shutdown drain (the restart window): runs a debounced batch now instead of
// letting its timer die with the process, then resolves once the pass settles.
// Idle when nothing is pending or running.
export async function flushCatalogUniverseFiling() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (pending.size) flush();
  await running;
}

export function initCatalogUniverseFiling() {
  if (initialized) return;
  initialized = true;
  catalogEvents.on('assets-changed', schedule);
  catalogEvents.on('primitive-changed', schedule);
  console.log('🌍 Catalog universe filing initialized');
}

export const __testing = {
  reset() {
    catalogEvents.off('assets-changed', schedule);
    catalogEvents.off('primitive-changed', schedule);
    initialized = false;
    if (timer) clearTimeout(timer);
    timer = null;
    pending.clear();
  },
  flushNow: flushCatalogUniverseFiling,
};
