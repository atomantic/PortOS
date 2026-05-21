// One-shot migration: copy legacy series.{characters,settings,objects} into
// the linked universe so Phase B readers (which only consult universe canon)
// have data to read. Idempotent — re-running merges by name without dupes.
//
// Runs on demand via CLI: `node server/services/pipeline/migrateSeriesCanon.js`
// or programmatically from server boot if we ever auto-migrate.
//
// Phase B.4 note: `sanitizeSeries` no longer round-trips the legacy canon
// fields, so calling `listSeries()` here would silently produce empty arrays
// and the migration would no-op for any install that hadn't already migrated.
// This script intentionally reads the raw `pipeline-series.json` instead, so
// the recovery path stays viable until the user runs it. Once migrated, the
// next series-side write will rewrite the JSON without the legacy fields.

import { join } from 'path';
import { createHash } from 'node:crypto';
import { updateSeries } from './series.js';
import { PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { getUniverse, insertUniverseWithId, updateUniverse, ERR_DUPLICATE } from '../universeBuilder.js';
import { mergeExtractedBible, BIBLE_FIELD, BIBLE_SOURCE } from '../../lib/storyBible.js';

// Derive a stable universe id from the importing series so a retry after a
// mid-helper throw (insert succeeded, a later write failed) reuses the orphan
// from the prior pass instead of minting a second "(auto-migrated)" universe
// per retry. sha1 of `series.id` truncated to 32 hex chars fits UNIVERSE_ID_RE
// (`[A-Za-z0-9-]{8,80}`) regardless of the series-id format.
export const deriveOrphanUniverseId = (seriesId) =>
  `uni-from-series-${createHash('sha1').update(String(seriesId)).digest('hex').slice(0, 32)}`;

// Raw read of pipeline-series.json (bypasses sanitizeSeries, which post-B.4
// strips the legacy canon fields the migration needs to see).
const readRawSeriesState = () =>
  readJSONFile(join(PATHS.data, 'pipeline-series.json'), { series: [] }, { logError: false });

// Reverse of BIBLE_FIELD — maps the persisted field name (`characters`) back
// to its BIBLE_KIND value (`character`) so the migration can call
// mergeExtractedBible per field. Sourcing this from BIBLE_FIELD keeps one
// source of truth: when a new kind lands in storyBible.js, this map updates
// automatically.
const KIND_BY_FIELD = Object.freeze(
  Object.fromEntries(Object.entries(BIBLE_FIELD).map(([kind, field]) => [field, kind])),
);

const formatCounts = (counts) =>
  Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');

/**
 * Move a single series record's legacy `characters/settings/objects` arrays
 * into its linked (or freshly-created) universe. Pure orchestrator: does NOT
 * write the series itself — the caller decides whether to call `updateSeries`
 * (CLI batch) or stamp `universeId` onto an in-memory record (sharing
 * importer) so `sanitizeSeries` doesn't strip the new link before the record
 * lands.
 *
 * Returns:
 *   - `perKindSeen`     — raw incoming counts per field on the source record.
 *   - `perKindApplied`  — incoming counts only where the universe-side patch
 *                         actually grew or changed (zero when the universe
 *                         already had every entry).
 *   - `universeId`      — the universe the series should be linked to (existing
 *                         or freshly-created), null when the helper couldn't
 *                         resolve one (dry-run orphan, missing universe).
 *   - `universeCreated` — true when this call created a new orphan universe.
 *   - `migrated`        — true when the universe was actually patched.
 *   - `skipped`         — `'no-legacy' | 'missing-universe' | 'dry-run-orphan' | null`.
 */
export async function applyLegacySeriesCanonToUniverse(series, { dryRun = false, log = console.log } = {}) {
  // Coalesce the pre-022 `settings[]` alias onto `places[]` so peers that
  // shipped from a pre-rename install still migrate cleanly. Local disk is
  // post-rename (migration 022 ran at setup), so this is a no-op for the
  // CLI batch and only carries weight for cross-peer share-bucket imports.
  const incomingPlaces = Array.isArray(series.places) && series.places.length > 0
    ? series.places
    : (Array.isArray(series.settings) ? series.settings : []);
  const normalized = { ...series, places: incomingPlaces };

  const perKindSeen = {
    characters: Array.isArray(normalized.characters) ? normalized.characters.length : 0,
    places: incomingPlaces.length,
    objects: Array.isArray(normalized.objects) ? normalized.objects.length : 0,
  };
  const perKindApplied = { characters: 0, places: 0, objects: 0 };
  if (perKindSeen.characters + perKindSeen.places + perKindSeen.objects === 0) {
    return { perKindSeen, perKindApplied, universeId: normalized.universeId || null, universeCreated: false, migrated: false, skipped: 'no-legacy' };
  }
  series = normalized;

  let universeId = series.universeId;
  let universeCreated = false;
  let freshlyInserted = null;
  if (!universeId) {
    if (dryRun) {
      log(`📋 [dry-run] Would create universe for orphan series "${series.name}" (${series.id})`);
      return { perKindSeen, perKindApplied, universeId: null, universeCreated: false, migrated: false, skipped: 'dry-run-orphan' };
    }
    const deterministicId = deriveOrphanUniverseId(series.id);
    freshlyInserted = await insertUniverseWithId({
      id: deterministicId,
      name: `${series.name} (auto-migrated)`,
      starterPrompt: series.logline || series.premise?.slice(0, 500) || '',
    }).catch((err) => {
      if (err?.code === ERR_DUPLICATE) return null;
      throw err;
    });
    universeId = deterministicId;
    universeCreated = true;
    if (freshlyInserted) {
      log(`🌌 Created universe "${freshlyInserted.name}" (${freshlyInserted.id}) for orphan series "${series.name}"`);
    } else {
      // Prior retry minted this universe but threw before updateUniverse
      // landed — still flag `universeCreated` so the caller stamps
      // `series.universeId` and the merge below populates the empty canon.
      log(`♻️ Reusing universe ${deterministicId} for orphan series "${series.name}" (retry after prior failure)`);
    }
  }

  const universe = freshlyInserted || await getUniverse(universeId).catch(() => null);
  if (!universe) {
    log(`⚠️ Series "${series.name}" links to missing universe ${universeId} — skipping`);
    return { perKindSeen, perKindApplied, universeId, universeCreated, migrated: false, skipped: 'missing-universe' };
  }

  const patch = {};
  for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
    const incoming = Array.isArray(series[field]) ? series[field] : [];
    if (incoming.length === 0) continue;
    // mergeExtractedBible mutates its first arg AND can mutate matched
    // entries in place (firstAppearance / evidence / missingFromProse).
    // `[...arr]` is only a shallow clone, so a mutation would also reach
    // the live universe object AND defeat the post-merge diff check
    // (stringifying the mutated object on both sides hides the change).
    // Snapshot to JSON before the call, run the merge on a deep clone, and
    // diff against the frozen snapshot.
    const beforeJson = JSON.stringify(Array.isArray(universe[field]) ? universe[field] : []);
    // Mirror the live extract path's provenance (textStages.js +
    // routes/pipeline.js): series-driven canon enters the universe as
    // SERIES_EXTRACT with autoLock so a later AI refine/differentiate can't
    // silently rewrite it. Without these opts the migrated entries default
    // to source:'ai' + autoLock:false, leaving them one click away from
    // being clobbered — the opposite of what the live path promises.
    const merged = mergeExtractedBible(JSON.parse(beforeJson), incoming, kind, {
      source: BIBLE_SOURCE.SERIES_EXTRACT,
      autoLock: true,
      sourceSeriesId: series.id,
    });
    if (JSON.stringify(merged) !== beforeJson) {
      patch[field] = merged;
      perKindApplied[field] = incoming.length;
    }
  }

  let migrated = false;
  if (Object.keys(patch).length > 0) {
    if (dryRun) {
      log(`📋 [dry-run] Would merge into universe "${universe.name}": ${formatCounts(perKindSeen)} from series "${series.name}"`);
    } else {
      await updateUniverse(universeId, patch);
      migrated = true;
      log(`✅ Migrated series "${series.name}" → universe "${universe.name}": ${formatCounts(perKindSeen)}`);
    }
  }

  return { perKindSeen, perKindApplied, universeId, universeCreated, migrated, skipped: null };
}

export async function migrateSeriesCanon({ dryRun = false, log = console.log } = {}) {
  const { series: rawSeries } = await readRawSeriesState();
  const series = Array.isArray(rawSeries) ? rawSeries : [];
  const summary = { seriesScanned: 0, seriesMigrated: 0, universesCreated: 0, perKind: { characters: 0, places: 0, objects: 0 } };

  for (const s of series) {
    summary.seriesScanned += 1;
    // For orphan series, defer the link-to-universe write until AFTER the
    // canon has landed in the universe. The link write strips the series'
    // legacy `characters/settings/objects` (sanitizeSeries no longer
    // round-trips them post-B.4), so a crash between linking and merging
    // would leave the series stripped + the new universe empty.
    const r = await applyLegacySeriesCanonToUniverse(s, { dryRun, log });
    if (r.skipped === 'no-legacy') continue;
    if (r.universeCreated) summary.universesCreated += 1;
    if (r.migrated) summary.seriesMigrated += 1;
    for (const field of Object.keys(summary.perKind)) summary.perKind[field] += r.perKindApplied[field];
    // Link the orphan series to the (now-populated) universe — sanitizeSeries
    // strips legacy canon during this write, but it's already in the universe
    // so the data isn't lost.
    if (r.universeCreated && !dryRun) {
      await updateSeries(s.id, { universeId: r.universeId });
    }
  }

  log(`📊 Migration complete: scanned ${summary.seriesScanned} series, migrated ${summary.seriesMigrated}, created ${summary.universesCreated} universe(s)`);
  return summary;
}

// CLI entrypoint: `node server/services/pipeline/migrateSeriesCanon.js [--dry-run]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  migrateSeriesCanon({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => { console.error('❌ Migration failed:', err); process.exit(1); });
}
