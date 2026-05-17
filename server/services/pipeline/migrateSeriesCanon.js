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
import { updateSeries } from './series.js';
import { PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { getUniverse, createUniverse, updateUniverse } from '../universeBuilder.js';
import { mergeExtractedBible, BIBLE_FIELD, BIBLE_SOURCE } from '../../lib/storyBible.js';

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

export async function migrateSeriesCanon({ dryRun = false, log = console.log } = {}) {
  const { series: rawSeries } = await readRawSeriesState();
  const series = Array.isArray(rawSeries) ? rawSeries : [];
  const summary = { seriesScanned: 0, seriesMigrated: 0, universesCreated: 0, perKind: { characters: 0, settings: 0, objects: 0 } };

  for (const s of series) {
    summary.seriesScanned += 1;
    const counts = {
      characters: Array.isArray(s.characters) ? s.characters.length : 0,
      settings: Array.isArray(s.settings) ? s.settings.length : 0,
      objects: Array.isArray(s.objects) ? s.objects.length : 0,
    };
    if (counts.characters + counts.settings + counts.objects === 0) continue;

    // Auto-create a universe for orphan series so the migration completes
    // without manual linking. Named after the series so the user can find it
    // and merge later if desired.
    let universeId = s.universeId;
    if (!universeId) {
      if (dryRun) {
        log(`📋 [dry-run] Would create universe for orphan series "${s.name}" (${s.id})`);
      } else {
        const newUniverse = await createUniverse({
          name: `${s.name} (auto-migrated)`,
          starterPrompt: s.logline || s.premise?.slice(0, 500) || '',
        });
        await updateSeries(s.id, { universeId: newUniverse.id });
        universeId = newUniverse.id;
        summary.universesCreated += 1;
        log(`🌌 Created universe "${newUniverse.name}" (${newUniverse.id}) for orphan series "${s.name}"`);
      }
    }

    const universe = await getUniverse(universeId).catch(() => null);
    if (!universe) {
      log(`⚠️ Series "${s.name}" links to missing universe ${universeId} — skipping`);
      continue;
    }

    const patch = {};
    for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
      const incoming = Array.isArray(s[field]) ? s[field] : [];
      if (incoming.length === 0) continue;
      // mergeExtractedBible mutates its first arg (pushes new entries into
      // the array, then sorts in place). Snapshot the universe side BEFORE
      // the call so the diff check below sees the pre-merge length, and
      // pass a clone so the live universe object isn't mutated mid-loop.
      const before = Array.isArray(universe[field]) ? universe[field] : [];
      // Mirror the live extract path's provenance (textStages.js +
      // routes/pipeline.js): series-driven canon enters the universe as
      // SERIES_EXTRACT with autoLock so a later AI refine/differentiate
      // can't silently rewrite it. Without these opts the migrated
      // entries default to source:'ai' + autoLock:false, leaving them one
      // click away from being clobbered — the opposite of what the live
      // path promises.
      const merged = mergeExtractedBible([...before], incoming, kind, {
        source: BIBLE_SOURCE.SERIES_EXTRACT,
        autoLock: true,
        sourceSeriesId: s.id,
      });
      if (merged.length > before.length || JSON.stringify(merged) !== JSON.stringify(before)) {
        patch[field] = merged;
        summary.perKind[field] += incoming.length;
      }
    }

    if (Object.keys(patch).length > 0) {
      if (dryRun) {
        log(`📋 [dry-run] Would merge into universe "${universe.name}": ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')} from series "${s.name}"`);
      } else {
        await updateUniverse(universeId, patch);
        summary.seriesMigrated += 1;
        log(`✅ Migrated series "${s.name}" → universe "${universe.name}": ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
      }
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
