/**
 * One-time cleanup: prune the legacy file→Postgres migration artifacts that the
 * file→DB migrators intentionally park aside instead of deleting.
 *
 * Every file→DB migrator (migrateUniversesToDB, migrateIssuesToDB,
 * migrateSeriesToDB, migrateStoryBuilderToDB, migrateWritersRoomToDB,
 * migrateCreativeDirectorToDB) renames its source aside — `…​.imported` /
 * `index.json.imported` / `manifest.imported.json` — and the split migrations
 * (034–036) left `…​.bak-NNN` copies, "a recovery source for at least one
 * release." Nothing ever removed them, so on a long-lived install they linger in
 * `./data` indefinitely (multiple MB). This removes them once the DB is provably
 * authoritative. (They are deliberately NOT excluded from rsync backups: while a
 * prune is blocked they are the only recovery source, so a snapshot must keep
 * them — see the NOTE in server/services/backup.js. Once pruned from disk they
 * leave subsequent snapshots naturally.)
 *
 * WHY THIS RUNS AT BOOT (not in scripts/migrations/): the prune reads Postgres
 * row counts, but the `scripts/migrations/` runner executes BEFORE the DB pool
 * is up. So — exactly like repairUniverseTags / reconcileCanonCatalog — the real
 * work runs here from server/index.js (after ensureSchema + every store's
 * file→DB warm import), and scripts/migrations/077-prune-imported-legacy-files.js
 * is a registration stub so the change still lands in the migration ledger.
 *
 * SAFETY — the count-vs-marker guard (avoids the .length-truthiness footgun in
 * CLAUDE.md). A domain is pruned only when:
 *   (1) its `<domain>.migrated.json` marker exists (the migrator stamped it ONLY
 *       after a successful import + rename), AND
 *   (2) the live DB row count is >= the `imported` count the marker recorded.
 * "Table non-empty" would be WRONG: an install with genuinely zero records
 * (imported:0) would never prune its empty `.imported` dir and would re-walk
 * every boot forever. Comparing against the marker's recorded count instead
 * prunes the empty case (0 >= 0) while still WITHHOLDING when the marker says
 * `imported:13` but the table has 0 rows — the signature of a wiped / restored
 * DB, where the `.imported` files are the only remaining recovery source and
 * must NOT be deleted. This whole repair is also gated upstream by the
 * `dbReady` block in server/index.js, so it never runs under the
 * MEMORY_BACKEND=file escape hatch (no DB → no prune → recovery files kept).
 *
 * File-split backups (037 history.json, 059 media-collections.json) are NOT a
 * Postgres move — their successors live on disk — so they use a successor-exists
 * gate instead of a row count.
 *
 * Idempotent: `rm({ recursive: true, force: true })` no-ops on already-removed
 * paths, and a marker in `data/legacy-prune.applied.json` skips the walk once a
 * clean, complete pass has run. The marker is WITHHELD if any domain was blocked
 * (marker present but row count short) so a future boot retries that domain.
 */

import { readFile, writeFile, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'legacy-prune.applied.json';

// DB-gated domains: each was migrated file→Postgres. `markerFile` is the
// migrator's own completion marker; `guards` is the count-vs-marker check — one
// `{ table, expected(marker) }` per DB table whose data this domain's artifacts
// hold, so a wipe/restore that lost rows in ANY of them withholds the prune (a
// domain is pruned only when EVERY guard's live row count >= the marker's
// recorded count for that table); `artifacts` are the parked sources to remove
// (relative to data/, file OR dir — rm handles both); `nestedGlobs` are
// per-record artifacts that sit inside a still-live directory (one level deep).
const DB_DOMAINS = [
  {
    label: 'universes',
    markerFile: 'universes.migrated.json',
    // universes.imported / .bak-034 hold BOTH the universe rows AND the
    // cross-record config.runs[] log that migrateUniversesToDB decomposes into
    // universe_runs (recorded as marker.runs). Guard both, so a restore that
    // kept universes but lost the run history withholds the prune.
    guards: [
      { table: 'universes', expected: (m) => num(m?.imported) },
      { table: 'universe_runs', expected: (m) => num(m?.runs) },
    ],
    artifacts: ['universes.imported', 'universe-builder.json.bak-034'],
  },
  {
    label: 'pipeline-issues',
    markerFile: 'pipeline-issues.migrated.json',
    guards: [{ table: 'pipeline_issues', expected: (m) => num(m?.imported) }],
    artifacts: ['pipeline-issues.imported', 'pipeline-issues.json.bak-035'],
  },
  {
    label: 'pipeline-series',
    markerFile: 'pipeline-series.migrated.json',
    guards: [{ table: 'pipeline_series', expected: (m) => num(m?.imported) }],
    artifacts: ['pipeline-series.json.bak-036'],
    // migrateSeriesToDB renamed each record's index.json IN PLACE, leaving the
    // pipeline-series/<id>/ dir (+ manuscript-review.json sibling) intact.
    nestedGlobs: [{ baseDir: 'pipeline-series', leaf: 'index.json.imported' }],
  },
  {
    label: 'story-builder',
    markerFile: 'story-builder.migrated.json',
    guards: [{ table: 'story_builder_sessions', expected: (m) => num(m?.imported) }],
    artifacts: ['story-builder.imported'],
  },
  {
    label: 'writers-room',
    markerFile: 'writers-room.migrated.json',
    // The writers-room marker records folders/works/exercises separately, and
    // this domain deletes the recovery copy of ALL THREE (folders.imported.json,
    // each work's manifest.imported.json, exercises.imported.json) — so guard on
    // all three tables, not just works. (The migrator writes the marker only
    // after all three import, so on a clean migration works alone would proxy
    // the rest; the per-table guards make the wipe/restore case correct too — a
    // restore that brought back works but lost folders won't delete the folders
    // recovery file.)
    guards: [
      { table: 'writers_room_folders', expected: (m) => num(m?.folders) },
      { table: 'writers_room_works', expected: (m) => num(m?.works) },
      { table: 'writers_room_exercises', expected: (m) => num(m?.exercises) },
    ],
    // The per-work manifest.imported.json files carry the `drafts[]` metadata
    // that migrateWritersRoomToDB decomposes into writers_room_draft_versions
    // rows (the marker records no draft-version count, so it can't be a normal
    // marker guard). Before deleting the manifests, count the drafts they hold
    // and require at least that many version rows — else a restore that kept
    // works but lost draft-version rows would delete the only recovery source
    // for that version metadata. The .md bodies stay on disk regardless.
    manifestDraftGuard: {
      table: 'writers_room_draft_versions',
      manifestGlob: { baseDir: 'writers-room/works', leaf: 'manifest.imported.json' },
    },
    artifacts: ['writers-room/folders.imported.json', 'writers-room/exercises.imported.json'],
    nestedGlobs: [{ baseDir: 'writers-room/works', leaf: 'manifest.imported.json' }],
  },
  {
    label: 'creative-director',
    markerFile: 'creative-director-projects.migrated.json',
    guards: [{ table: 'creative_director_projects', expected: (m) => num(m?.imported) }],
    artifacts: ['creative-director-projects.json.imported'],
  },
];

// File-split backups: data reshaped file→file (NOT moved to Postgres), so they
// gate on the successor existing on disk rather than a DB row count. `backup` is
// a prefix: migration 037/059 normally write the bare `.bak-NNN`, but on a
// re-run collision they append `-<timestamp>`, so match the prefix to catch
// those variants too.
const FILE_SPLIT_BACKUPS = [
  { label: 'history', backupPrefix: 'history.json.bak-037', successor: 'history.jsonl' },
  { label: 'media-collections', backupPrefix: 'media-collections.json.bak-059', successor: 'media-collections' },
];

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function pathExists(p) {
  return stat(p).then(() => true, () => false);
}

async function readJsonMarker(base, filename) {
  const raw = await readFile(join(base, filename), 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Remove a path (file or dir) under `base`. force:true → no throw if absent.
// Returns true if the path existed before removal (so we can report a count).
async function removeUnder(base, rel) {
  const abs = join(base, rel);
  const existed = await pathExists(abs);
  if (existed) await rm(abs, { recursive: true, force: true });
  return existed;
}

// Remove `<baseDir>/<sub>/<leaf>` for every immediate subdir of baseDir.
async function removeNestedGlob(base, baseDir, leaf) {
  const entries = await readdir(join(base, baseDir), { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await removeUnder(base, join(baseDir, entry.name, leaf))) removed++;
  }
  return removed;
}

// Remove every top-level entry of `base` whose name starts with `prefix` (the
// bare `.bak-NNN` plus any `-<timestamp>` re-run collision variant).
async function removeByPrefix(base, prefix) {
  const entries = await readdir(base).catch(() => []);
  let removed = 0;
  for (const name of entries) {
    if (name.startsWith(prefix) && await removeUnder(base, name)) removed++;
  }
  return removed;
}

// Sum the `drafts[]` lengths across every `<baseDir>/<sub>/<leaf>` manifest —
// the number of draft-version rows those manifests were decomposed into. Used
// to verify writers_room_draft_versions wasn't lost before deleting the
// manifests (the only on-disk recovery source for that version metadata).
async function countManifestDrafts(base, baseDir, leaf) {
  const entries = await readdir(join(base, baseDir), { withFileTypes: true }).catch(() => []);
  let drafts = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonMarker(base, join(baseDir, entry.name, leaf));
    if (Array.isArray(manifest?.drafts)) drafts += manifest.drafts.length;
  }
  return drafts;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] - re-run even if the marker is current (tests/admin).
 * @param {object} [opts.db] - injectable db module ({ query }); defaults to server/lib/db.js.
 * @param {string} [opts.dataDir] - override data dir (tests). Defaults to PATHS.data.
 */
export async function pruneImportedLegacyFiles({ force = false, db, dataDir } = {}) {
  const base = dataDir ?? PATHS.data;

  const existing = await readJsonMarker(base, MARKER_FILENAME);
  if (existing?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker: existing };
  }

  const { query } = db ?? await import('../lib/db.js');
  const totals = { removed: 0, blocked: 0, pruned: [] };

  for (const domain of DB_DOMAINS) {
    const marker = await readJsonMarker(base, domain.markerFile);
    // No marker → migrator never completed for this install (or fresh install
    // with no legacy data). Nothing parked aside to prune; not a block.
    if (!marker) continue;

    // Count-vs-marker guard: a short count in ANY guarded table means the DB
    // lost rows the marker says were imported (wipe / restore) — the parked
    // files are the recovery source, so WITHHOLD and let a future boot retry
    // once the DB is whole. Check every table whose data this domain deletes.
    let blocked = false;
    for (const guard of domain.guards) {
      const expected = guard.expected(marker);
      const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${guard.table}`);
      const count = num(rows?.[0]?.n);
      if (count < expected) {
        console.warn(`🧹 legacy-prune: ${domain.label} blocked — ${guard.table} has ${count} row(s) but marker recorded ${expected}; keeping recovery files`);
        blocked = true;
        break;
      }
    }
    // Manifest-derived guard (writers-room draft versions): the expected count
    // comes from the parked manifests on disk, not the marker. Only checked when
    // not already blocked by a table guard.
    if (!blocked && domain.manifestDraftGuard) {
      const g = domain.manifestDraftGuard;
      const expected = await countManifestDrafts(base, g.manifestGlob.baseDir, g.manifestGlob.leaf);
      const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${g.table}`);
      const count = num(rows?.[0]?.n);
      if (count < expected) {
        console.warn(`🧹 legacy-prune: ${domain.label} blocked — ${g.table} has ${count} row(s) but parked manifests hold ${expected} draft(s); keeping recovery files`);
        blocked = true;
      }
    }
    if (blocked) {
      totals.blocked++;
      continue;
    }

    let domainRemoved = 0;
    for (const rel of domain.artifacts) {
      if (await removeUnder(base, rel)) domainRemoved++;
    }
    for (const glob of (domain.nestedGlobs ?? [])) {
      domainRemoved += await removeNestedGlob(base, glob.baseDir, glob.leaf);
    }
    if (domainRemoved > 0) {
      totals.removed += domainRemoved;
      totals.pruned.push(`${domain.label}(${domainRemoved})`);
    }
  }

  // File-split backups: prune only when the reshaped successor is present on
  // disk (proof the split landed). Absent successor → leave the backup alone.
  for (const item of FILE_SPLIT_BACKUPS) {
    if (!await pathExists(join(base, item.successor))) continue;
    const removed = await removeByPrefix(base, item.backupPrefix);
    if (removed > 0) {
      totals.removed += removed;
      totals.pruned.push(item.label);
    }
  }

  // Only stamp the completion marker on a clean pass with NO blocked domain —
  // a block means a future boot should retry (same logic as repairUniverseTags
  // withholding its marker on an incomplete pass).
  const markerWritten = totals.blocked === 0;
  if (markerWritten) {
    await writeFile(
      join(base, MARKER_FILENAME),
      JSON.stringify({ version: MARKER_VERSION, completedAt: new Date().toISOString(), removed: totals.removed }, null, 2) + '\n',
      'utf-8',
    );
  } else if (existing) {
    // A forced re-run that ended blocked must not leave a STALE clean marker on
    // disk — otherwise the next normal boot reads it, short-circuits via the
    // `skipped` branch above, and silently never retries the blocked domain.
    // Drop it so a normal boot re-evaluates. (Only reachable on the force path:
    // a non-forced run with a current marker returned `skipped` before any work.)
    await rm(join(base, MARKER_FILENAME), { force: true });
  }

  console.log(
    `🧹 legacy-prune: removed ${totals.removed} artifact(s)` +
    (totals.pruned.length ? ` [${totals.pruned.join(', ')}]` : '') +
    (totals.blocked ? `, ${totals.blocked} domain(s) blocked` : '') +
    (markerWritten ? '' : ' — marker NOT written (will retry next boot)'),
  );

  return { skipped: false, markerWritten, ...totals };
}
