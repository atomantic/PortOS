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
 * `fileCatalogImagesIntoUniverses` is idempotent: it adds only what each
 * collection lacks, never removes, and skips an image the user already took
 * out of that collection (its `removedItems` stamp). The same function answers
 * the one-time integrity pass (`dryRun` reports without writing) and the
 * live filing below, which runs after any catalog media or ref change.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { query } from '../lib/db.js';
import { PATHS } from '../lib/paths.js';
import { CANONICAL_REFS_CTE, STORYBOARD_PANEL_MEMBERS_SQL } from './catalogDB/shared.js';
import { catalogEvents } from './catalogEvents.js';
import {
  REF_MAX_LENGTH, bulkUpdateCollectionItems, findCollectionByUniverseId, findOrCreateUniverseCollection,
} from './mediaCollections.js';

// (record, universe, image) for every live portrait/reference on a record that
// belongs to a live universe. `$1` narrows to the given records (any member id
// of a merged identity resolves to its canonical record); NULL means all.
const PLACEMENTS_SQL = `WITH ${CANONICAL_REFS_CTE},
  member_universes AS (
    SELECT r.cid, r.ref_id AS universe_id FROM canonical_refs r WHERE r.ref_kind = 'universe'
    UNION SELECT r.cid, NULLIF(m.data#>>'{concept,universeId}', '') FROM canonical_refs r
      JOIN music_video_projects m ON r.ref_kind = 'music-video' AND m.id = r.ref_id AND m.deleted = false
    UNION SELECT r.cid, s.universe_id FROM canonical_refs r
      JOIN storyboards s ON r.ref_kind = 'storyboard' AND s.id = r.ref_id AND s.deleted = false
    UNION SELECT pm.cid, s.universe_id FROM (${STORYBOARD_PANEL_MEMBERS_SQL}) pm
      JOIN storyboards s ON s.id = pm.board_id
    UNION SELECT r.cid, p.universe_id FROM canonical_refs r
      JOIN pipeline_series p ON r.ref_kind = 'series' AND p.id = r.ref_id AND p.deleted = false)
  SELECT DISTINCT i.id AS ingredient_id, i.name AS ingredient_name, u.id AS universe_id, u.name AS universe_name, m.media_key
    FROM member_universes mu
    JOIN universes u ON u.id = mu.universe_id AND u.deleted = false
    JOIN catalog_ingredients i ON i.id = mu.cid AND i.deleted = false
    JOIN catalog_identity_read_media m ON m.ingredient_id = ANY(catalog_identity_member_ids(i.id))
     AND m.deleted = false AND m.kind IN ('portrait', 'reference')
     AND (m.role IS NULL OR m.role NOT LIKE 'archive:%')
   WHERE $1::text[] IS NULL OR i.id IN (SELECT catalog_canonical_ingredient_id(x) FROM unnest($1::text[]) x)
   ORDER BY u.id, i.id, m.media_key`;

const loadPlacements = async (ingredientIds) => {
  const { rows } = await query(PLACEMENTS_SQL, [ingredientIds]);
  return rows.map((row) => ({
    ingredientId: row.ingredient_id, ingredientName: row.ingredient_name,
    universeId: row.universe_id, universeName: row.universe_name, mediaKey: row.media_key,
  }));
};

// Only a gallery image (a data/images basename) can be a collection item.
const isGalleryImage = (key) => typeof key === 'string' && key.length > 0 && key.length <= REF_MAX_LENGTH
  && !/[:/\\]/.test(key) && key !== '.' && key !== '..' && existsSync(join(PATHS.images, key));

const deps = {
  loadPlacements, isGalleryImage, findCollectionByUniverseId, findOrCreateUniverseCollection, bulkUpdateCollectionItems,
};
export const __setUniverseFilingDepsForTests = (overrides) => Object.assign(deps, overrides);

/**
 * File every image of the given records (all records when `ingredientIds` is
 * null) into the collections of the universes they belong to. Returns a report
 * per universe: images already there, ones added (or that would be, on a dry
 * run), ones the user removed from that collection, and ones missing locally.
 */
export async function fileCatalogImagesIntoUniverses({ ingredientIds = null, dryRun = false } = {}) {
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
      else if (!deps.isGalleryImage(mediaKey)) report.missingFile.push(mediaKey);
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

// Live filing: catalog media/ref writes announce `assets-changed`, record-level
// changes (completion hook, universe membership) `primitive-changed`. Bursts
// for one record coalesce, and one pass runs at a time, so a batch of renders
// files with one collection write per universe. The delay also lets a caller's
// own transaction commit before the read.
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
    const { totals } = await fileCatalogImagesIntoUniverses({ ingredientIds });
    if (totals.added > 0) console.log(`🌍 Filed ${totals.added} catalog image(s) into ${totals.universes} universe collection(s)`);
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
