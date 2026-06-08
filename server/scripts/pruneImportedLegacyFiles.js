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
 * WHY THIS RUNS AT BOOT (not in scripts/migrations/): the prune reads Postgres,
 * but the `scripts/migrations/` runner executes BEFORE the DB pool is up. So —
 * exactly like repairUniverseTags / reconcileCanonCatalog — the real work runs
 * here from server/index.js (after ensureSchema + every store's file→DB warm
 * import), and scripts/migrations/077-prune-imported-legacy-files.js is a
 * registration stub so the change still lands in the migration ledger.
 *
 * SAFETY — IDENTITY verification (not a row count). A domain's artifacts are
 * deleted only when EVERY record id those artifacts hold is confirmed present in
 * the database. The ids come straight off disk: the parked directory NAMES
 * (`universes.imported/<id>/`, `pipeline-issues.imported/<id>/`) or the parsed
 * JSON `.id` (the creative-director array, each writers-room manifest/folder/
 * exercise, the universe `config.runs[]`, each manifest's `drafts[]`). We then
 * verify those exact ids exist via `SELECT id ... WHERE id = ANY($1)`.
 *
 * Why identity, not `COUNT(*) >= marker.imported` (the prior approach, rejected
 * in review): a count can be satisfied by UNRELATED rows after a wipe+restore to
 * a different record set, and the migrators record `imported` from
 * `INSERT … ON CONFLICT DO NOTHING`, so a partial-retry marker can undercount
 * the parked source — either way a count `>=` check can pass while the specific
 * migrated rows are gone, deleting the only recovery copy. Checking the actual
 * ids can't be fooled by substitute rows or an undercounted marker. It also
 * handles the genuinely-empty install for free (no ids on disk → nothing to
 * verify → safe to prune the empty `.imported` dir) without depending on any
 * marker field. The `<domain>.migrated.json` marker is now used ONLY as a
 * "migration ran" signal (no marker → nothing was parked → skip).
 *
 * A wiped / partially-restored DB that is missing ANY parked id WITHHOLDS the
 * whole domain's prune and leaves the completion marker unwritten, so a future
 * boot retries once the DB is whole. Two more conditions also withhold: (a) a
 * parked artifact that EXISTS but can't be turned into a verifiable id set —
 * unreadable/truncated, wrong top-level shape, or an id-less record (one the
 * original migrator may have SKIPPED and parked) — blocks its domain rather than
 * being mistaken for "zero records" and deleted; (b) a domain whose migration is
 * still PENDING — its legacy source
 * is on disk but no marker was stamped (migration failed or hasn't run) — blocks
 * the GLOBAL completion marker, so a later boot (after the source is repaired and
 * finally parked) still prunes it instead of skipping forever via the applied
 * marker. This repair is also gated upstream by the `dbReady` block in
 * server/index.js, so it never runs under the MEMORY_BACKEND=file escape hatch
 * (no DB → no prune → recovery files kept).
 *
 * SCOPE — only the `.imported` file→DB artifacts are pruned. The `.bak-NNN`
 * monolith backups (the file→FILE split migrations 034–036) and the file-split
 * backups (037 history.json, 059 media-collections.json) are deliberately LEFT
 * for manual cleanup: they are a deeper, separate recovery layer that can hold
 * records the split migrator SKIPPED (invalid records `makeSplitMigration`
 * leaves only in the `.bak` file), and they predate the DB so their record set
 * is a superset of (and not identity-verifiable against) the live DB — e.g.
 * `universe-builder.json.bak-034` carries 30 universes incl. soft-deleted ones
 * the DB legitimately won't have, so any id check against the DB would block
 * forever. Auto-deleting them unverified would risk losing skipped records;
 * verifying them is impossible. So we don't touch them. The big wins
 * (`universes.imported`, `pipeline-issues.imported` — multiple MB each) are
 * still pruned.
 *
 * Idempotent: `rm({ recursive: true, force: true })` no-ops on already-removed
 * paths, and a marker in `data/legacy-prune.applied.json` skips the walk once a
 * clean, complete pass has run.
 */

import { readFile, writeFile, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'legacy-prune.applied.json';

// Thrown by an id extractor when a parked artifact EXISTS but can't be read /
// parsed (truncated after a crash, hand-edited to invalid JSON). The verify
// loop treats this as a block — a domain whose recovery source we can't read is
// NOT proven safe to delete, so we must keep it rather than treat the
// unreadable file as "zero records" and prune it. (Distinct from a genuinely
// absent file, which legitimately yields no ids.)
class ParkedArtifactUnreadable extends Error {}

// Read a parked JSON artifact. Returns null when ABSENT; throws
// ParkedArtifactUnreadable when present-but-unreadable/unparseable — so a
// corrupt recovery file blocks its domain instead of being mistaken for empty.
async function readParkedJson(base, file) {
  let raw;
  try {
    raw = await readFile(join(base, file), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null; // genuinely absent → no records
    throw new ParkedArtifactUnreadable(`${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ParkedArtifactUnreadable(`${file}: invalid JSON (${err.message})`);
  }
}

// --- id extractors: pull the record ids a parked artifact holds, off disk. ---

// Record ids for a per-record-directory layout. The migrators key the DB row on
// the PARSED `index.json.id`, NOT the directory name (the two normally match but
// can drift), so we must verify the same id the migrator inserted. Reads each
// subdir's `<leaf>` and blocks (throws) on a missing/unparseable/id-less record
// — an unverifiable record must not let the prune delete its recovery copy.
// `leaf` defaults to the live record file; pass `index.json.imported` for the
// in-place rename layout (pipeline-series) and a missing leaf is skipped there.
async function idsFromRecordDirs(base, dir, { leaf = 'index.json', requireLeaf = false } = {}) {
  const entries = await readdir(join(base, dir), { withFileTypes: true }).catch(() => []);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'index.json' || entry.name.startsWith('.')) continue;
    const rel = join(dir, entry.name, leaf);
    if (requireLeaf && !await pathExists(join(base, rel))) continue; // unrelated sibling dir
    const record = await readParkedJson(base, rel);
    if (record === null) {
      if (requireLeaf) continue; // leaf vanished between listing and read — skip
      throw new ParkedArtifactUnreadable(`${rel}: missing or unreadable record`);
    }
    if (typeof record.id !== 'string') throw new ParkedArtifactUnreadable(`${rel}: record has no string id`);
    ids.push(record.id);
  }
  return ids;
}

// Map array elements to their string `.id`, BLOCKING (throw) on any element
// that lacks one. An unidentifiable record can't be verified against the DB, so
// treating it as "not there" and pruning anyway could delete the only copy of a
// record the original migrator skipped — block the domain instead.
function idsOrBlock(arr, label) {
  return arr.map((r, i) => {
    if (!r || typeof r.id !== 'string') {
      throw new ParkedArtifactUnreadable(`${label}: record ${i} has no string id`);
    }
    return r.id;
  });
}

// `.id` of every element of a top-level JSON array file (the CD export, and the
// writers-room folders.imported.json / exercises.imported.json bare arrays).
// Present-but-corrupt OR wrong-shape OR any id-less record throws (blocks the
// domain); absent → no ids.
async function idsFromJsonArray(base, file) {
  const arr = await readParkedJson(base, file);
  if (arr === null) return [];
  if (!Array.isArray(arr)) throw new ParkedArtifactUnreadable(`${file}: expected a JSON array`);
  return idsOrBlock(arr, file);
}

// Universe run ids: the type-level index.json's `config.runs[]`, each `{ id }`.
// (migrateUniversesToDB reads runs from `universes.imported/index.json`.)
async function universeRunIds(base) {
  const file = 'universes.imported/index.json';
  const typeIndex = await readParkedJson(base, file);
  if (typeIndex === null) return [];
  const runs = typeIndex?.config?.runs;
  if (runs == null) return []; // no runs key → no run history was parked
  if (!Array.isArray(runs)) throw new ParkedArtifactUnreadable(`${file}: config.runs is not an array`);
  return idsOrBlock(runs, `${file}#config.runs`);
}

// Writers-room work ids + draft-version ids, read from each parked manifest.
// A present-but-corrupt manifest, or one with an id-less work / draft, throws.
async function writersRoomManifestIds(base) {
  const worksDir = 'writers-room/works';
  const subdirs = await readdir(join(base, worksDir), { withFileTypes: true }).catch(() => []);
  const workIds = [];
  const draftIds = [];
  for (const entry of subdirs) {
    if (!entry.isDirectory()) continue;
    const file = join(worksDir, entry.name, 'manifest.imported.json');
    const manifest = await readParkedJson(base, file);
    if (manifest === null) continue; // no parked manifest in this dir
    if (typeof manifest.id !== 'string') throw new ParkedArtifactUnreadable(`${file}: work has no string id`);
    workIds.push(manifest.id);
    const drafts = manifest.drafts;
    if (drafts != null) {
      if (!Array.isArray(drafts)) throw new ParkedArtifactUnreadable(`${file}: drafts is not an array`);
      draftIds.push(...idsOrBlock(drafts, `${file}#drafts`));
    }
  }
  return { workIds, draftIds };
}

// Per-domain "is a legacy migration still pending?" predicate — true when the
// migrator's SOURCE is still on disk but its marker is absent (migration not
// run, or it failed leaving the source in place). Used ONLY when a domain has
// no marker: if its source is still present we must NOT let the global
// completion marker be written, or a later boot (after the user repairs the
// source and the migration finally parks a `.imported` artifact) would skip the
// prune forever. The rename-away migrators (universes/pipeline-issues/story-
// builder/creative-director) leave nothing at the source path post-migration,
// so the path's presence alone signals "pending". The in-place migrators
// (pipeline-series/writers-room) keep their dir, so we look for the specific
// un-renamed legacy file.
async function pipelineSeriesPending(base) {
  const entries = await readdir(join(base, 'pipeline-series'), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const live = join(base, 'pipeline-series', e.name, 'index.json');
    const parked = join(base, 'pipeline-series', e.name, 'index.json.imported');
    if (await pathExists(live) && !await pathExists(parked)) return true;
  }
  return false;
}
async function writersRoomPending(base) {
  if (await pathExists(join(base, 'writers-room/folders.json'))) return true;
  if (await pathExists(join(base, 'writers-room/exercises.json'))) return true;
  const works = await readdir(join(base, 'writers-room/works'), { withFileTypes: true }).catch(() => []);
  for (const e of works) {
    if (e.isDirectory() && await pathExists(join(base, 'writers-room/works', e.name, 'manifest.json'))) return true;
  }
  return false;
}

// DB-gated domains. `markerFile` is the migrator's completion marker (used only
// as a "migration ran" signal — no marker means nothing was parked). `verify`
// returns `{ table, ids }[]`: the record ids each table must still contain for
// the artifacts to be safe to delete. `artifacts` are the parked sources to
// remove (file OR dir); `nestedGlobs` are per-record artifacts inside a still-
// live directory (one level deep).
const DB_DOMAINS = [
  {
    label: 'universes',
    markerFile: 'universes.migrated.json',
    // universes.imported holds both the universe records (subdir names) and the
    // config.runs[] log decomposed into universe_runs — verify both id sets.
    verify: async (base) => [
      { table: 'universes', ids: await idsFromRecordDirs(base, 'universes.imported') },
      { table: 'universe_runs', ids: await universeRunIds(base) },
    ],
    pending: (base) => pathExists(join(base, 'universes')),
    artifacts: ['universes.imported'],
  },
  {
    label: 'pipeline-issues',
    markerFile: 'pipeline-issues.migrated.json',
    verify: async (base) => [
      { table: 'pipeline_issues', ids: await idsFromRecordDirs(base, 'pipeline-issues.imported') },
    ],
    pending: (base) => pathExists(join(base, 'pipeline-issues')),
    artifacts: ['pipeline-issues.imported'],
  },
  {
    label: 'pipeline-series',
    markerFile: 'pipeline-series.migrated.json',
    // migrateSeriesToDB renamed each record's index.json IN PLACE, leaving the
    // pipeline-series/<id>/ dir (+ manuscript-review.json sibling) intact — so
    // the series ids are the subdir names holding an index.json.imported.
    verify: async (base) => [
      { table: 'pipeline_series', ids: await idsFromRecordDirs(base, 'pipeline-series', { leaf: 'index.json.imported', requireLeaf: true }) },
    ],
    pending: pipelineSeriesPending,
    artifacts: [],
    nestedGlobs: [{ baseDir: 'pipeline-series', leaf: 'index.json.imported' }],
  },
  {
    label: 'story-builder',
    markerFile: 'story-builder.migrated.json',
    verify: async (base) => [
      { table: 'story_builder_sessions', ids: await idsFromRecordDirs(base, 'story-builder.imported') },
    ],
    pending: (base) => pathExists(join(base, 'story-builder')),
    artifacts: ['story-builder.imported'],
  },
  {
    label: 'writers-room',
    markerFile: 'writers-room.migrated.json',
    // This domain deletes the recovery copy of folders + works + exercises +
    // each work's drafts[], so verify every id set those artifacts hold.
    verify: async (base) => {
      const { workIds, draftIds } = await writersRoomManifestIds(base);
      return [
        { table: 'writers_room_folders', ids: await idsFromJsonArray(base, 'writers-room/folders.imported.json') },
        { table: 'writers_room_exercises', ids: await idsFromJsonArray(base, 'writers-room/exercises.imported.json') },
        { table: 'writers_room_works', ids: workIds },
        { table: 'writers_room_draft_versions', ids: draftIds },
      ];
    },
    pending: writersRoomPending,
    artifacts: ['writers-room/folders.imported.json', 'writers-room/exercises.imported.json'],
    nestedGlobs: [{ baseDir: 'writers-room/works', leaf: 'manifest.imported.json' }],
  },
  {
    label: 'creative-director',
    markerFile: 'creative-director-projects.migrated.json',
    verify: async (base) => [
      { table: 'creative_director_projects', ids: await idsFromJsonArray(base, 'creative-director-projects.json.imported') },
    ],
    pending: (base) => pathExists(join(base, 'creative-director-projects.json')),
    artifacts: ['creative-director-projects.json.imported'],
  },
];

async function pathExists(p) {
  return stat(p).then(() => true, () => false);
}

async function readJson(base, file) {
  const raw = await readFile(join(base, file), 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Of `ids`, return those NOT present in `table` (the rows a prune would orphan).
// Empty `ids` → no query, nothing missing (genuinely-empty install prunes free).
async function missingIds(query, table, ids) {
  if (ids.length === 0) return [];
  const { rows } = await query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids]);
  const present = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !present.has(id));
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

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force] - re-run even if the marker is current (tests/admin).
 * @param {object} [opts.db] - injectable db module ({ query }); defaults to server/lib/db.js.
 * @param {string} [opts.dataDir] - override data dir (tests). Defaults to PATHS.data.
 */
export async function pruneImportedLegacyFiles({ force = false, db, dataDir } = {}) {
  const base = dataDir ?? PATHS.data;

  const existing = await readJson(base, MARKER_FILENAME);
  if (existing?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker: existing };
  }

  const { query } = db ?? await import('../lib/db.js');
  const totals = { removed: 0, blocked: 0, pruned: [] };

  for (const domain of DB_DOMAINS) {
    const marker = await readJson(base, domain.markerFile);
    if (!marker) {
      // No marker → migrator hasn't completed for this domain. Usually a fresh
      // install with nothing parked (skip silently). BUT if the migrator's
      // SOURCE is still on disk, the migration is pending/failed — count it as
      // blocked so the global completion marker is withheld; otherwise a later
      // boot (after the source is repaired and finally parked) would skip the
      // prune forever via the applied marker.
      if (await domain.pending(base)) {
        console.warn(`🧹 legacy-prune: ${domain.label} pending — no migration marker but legacy source still on disk; withholding completion so a later boot prunes it`);
        totals.blocked++;
      }
      continue;
    }

    // Identity guard: every id the parked artifacts hold must still be present
    // in its table. A missing id means the DB lost a migrated record (wipe /
    // partial restore) — the parked files are the recovery source, so WITHHOLD
    // the whole domain and let a future boot retry once the DB is whole. A
    // present-but-unreadable parked artifact (ParkedArtifactUnreadable) also
    // blocks: we can't prove its records exist, so we must not delete it.
    let blocked = false;
    let checks;
    try {
      checks = await domain.verify(base);
    } catch (err) {
      if (!(err instanceof ParkedArtifactUnreadable)) throw err;
      console.warn(`🧹 legacy-prune: ${domain.label} blocked — parked recovery artifact unreadable (${err.message}); keeping recovery files`);
      totals.blocked++;
      continue;
    }
    for (const { table, ids } of checks) {
      const missing = await missingIds(query, table, ids);
      if (missing.length > 0) {
        console.warn(`🧹 legacy-prune: ${domain.label} blocked — ${missing.length}/${ids.length} ${table} id(s) missing from DB (e.g. ${missing[0]}); keeping recovery files`);
        blocked = true;
        break;
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
