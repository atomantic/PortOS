/**
 * Isolated unit test for the legacy-artifact prune. No live DB needed — the
 * module accepts an injectable `db` (a `{ query }` stub backed by a per-table
 * id-set) and a `dataDir` override pointing at a temp tree. Proves the contract:
 *   1. prunes a domain's parked artifacts when EVERY parked record id is present
 *      in its table (identity verification, not a row count),
 *   2. WITHHOLDS (keeps the recovery files) when ANY parked id is missing — the
 *      wiped / partial-restore signature — including the secondary id sets
 *      (universe_runs, writers_room_draft_versions) that share a domain,
 *   3. prunes the genuinely-empty case (no ids on disk → nothing to verify),
 *   4. removes the per-record nested artifacts but leaves live siblings + bodies,
 *   5. file-split backups gate on the successor existing (+ timestamped variant),
 *   6. marker-gated: a clean pass stamps the marker and the next run no-ops; a
 *      blocked pass withholds the marker; a force-blocked run drops a stale one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneImportedLegacyFiles } from './pruneImportedLegacyFiles.js';

let dataDir;

const exists = (p) => stat(p).then(() => true, () => false);
const writeJSON = (p, obj) => writeFile(p, JSON.stringify(obj), 'utf-8');

// A db stub backed by a per-table set of present ids. Answers the prune's only
// query shape: `SELECT id FROM <table> WHERE id = ANY($1)`.
function stubDb(tables) {
  return {
    async query(text, params) {
      const table = text.match(/FROM (\w+)/)?.[1];
      const present = new Set(tables[table] ?? []);
      const asked = params?.[0] ?? [];
      return { rows: asked.filter((id) => present.has(id)).map((id) => ({ id })) };
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'legacy-prune-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Build a universes.imported tree: one subdir per universe id, each holding an
// index.json whose `.id` IS the record id the migrator inserted (the verifier
// reads the parsed id, not the folder name), plus a type-level index.json
// carrying config.runs[] of the given run ids.
async function seedUniverses(ids, runIds = []) {
  const dir = join(dataDir, 'universes.imported');
  await mkdir(dir, { recursive: true });
  for (const id of ids) {
    await mkdir(join(dir, id), { recursive: true });
    await writeJSON(join(dir, id, 'index.json'), { id, name: `Universe ${id}` });
  }
  await writeJSON(join(dir, 'index.json'), { config: { runs: runIds.map((id) => ({ id, universeId: ids[0] })) } });
}

describe('pruneImportedLegacyFiles', () => {
  it('prunes a domain when every parked record id is present in the DB', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 2, runs: 1 });
    await seedUniverses(['u1', 'u2'], ['r1']);
    // The .bak-034 monolith is a deeper recovery layer and is intentionally NOT
    // pruned — it must survive the prune.
    await writeFile(join(dataDir, 'universe-builder.json.bak-034'), 'legacy', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['u1', 'u2'], universe_runs: ['r1'] }) });

    expect(res.skipped).toBe(false);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(false);
    expect(await exists(join(dataDir, 'universe-builder.json.bak-034'))).toBe(true); // kept
    expect(res.markerWritten).toBe(true);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(true);
  });

  it('does NOT delete the .bak-NNN monolith or file-split backups (deeper recovery layer)', async () => {
    await writeJSON(join(dataDir, 'pipeline-issues.migrated.json'), { imported: 1 });
    const imp = join(dataDir, 'pipeline-issues.imported');
    await mkdir(join(imp, 'iss-1'), { recursive: true });
    await writeJSON(join(imp, 'iss-1', 'index.json'), { id: 'iss-1' });
    await writeFile(join(dataDir, 'pipeline-issues.json.bak-035'), 'monolith', 'utf-8');
    await writeFile(join(dataDir, 'history.json.bak-037'), 'x', 'utf-8');
    await writeFile(join(dataDir, 'history.jsonl'), '', 'utf-8');

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ pipeline_issues: ['iss-1'] }) });

    // The .imported tree is pruned…
    expect(await exists(imp)).toBe(false);
    // …but every .bak backup survives for manual recovery.
    expect(await exists(join(dataDir, 'pipeline-issues.json.bak-035'))).toBe(true);
    expect(await exists(join(dataDir, 'history.json.bak-037'))).toBe(true);
    expect(res.markerWritten).toBe(true);
  });

  it('WITHHOLDS prune + marker when a parked universe id is missing (wiped/restored DB)', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 2, runs: 0 });
    await seedUniverses(['u1', 'u2']);

    // DB only has u1 — u2 was lost. Must keep the recovery dir.
    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['u1'] }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(true);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(false);
  });

  it('WITHHOLDS universe prune when a run id is missing even though all universes are present', async () => {
    // Partial restore: universe rows back, run history lost. universes.imported
    // is the only recovery source for universe_runs, so keep it.
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 2 });
    await seedUniverses(['u1'], ['r1', 'r2']);

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['u1'], universe_runs: ['r1'] }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(true);
  });

  it('verifies the parsed index.json id, not the folder name, when they drift', async () => {
    // The migrator inserts record.id from the JSON; the folder name can differ.
    // A DB that has the folder name but NOT the real id must block.
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 0 });
    const dir = join(dataDir, 'universes.imported');
    await mkdir(join(dir, 'folder-name'), { recursive: true });
    await writeJSON(join(dir, 'folder-name', 'index.json'), { id: 'real-id' });
    await writeJSON(join(dir, 'index.json'), { config: { runs: [] } });

    // DB only has the folder name, not the real record id → block.
    const blocked = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['folder-name'] }) });
    expect(blocked.blocked).toBe(1);
    expect(await exists(dir)).toBe(true);

    // DB has the real id → prunes.
    const ok = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['real-id'] }) });
    expect(ok.markerWritten).toBe(true);
    expect(await exists(dir)).toBe(false);
  });

  it('BLOCKS a record directory whose index.json has no string id', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 0 });
    const dir = join(dataDir, 'universes.imported');
    await mkdir(join(dir, 'u1'), { recursive: true });
    await writeJSON(join(dir, 'u1', 'index.json'), { name: 'no id here' });
    await writeJSON(join(dir, 'index.json'), { config: { runs: [] } });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['u1'] }) });

    expect(res.blocked).toBe(1);
    expect(await exists(dir)).toBe(true);
  });

  it('does NOT pass identity verification just because the table has unrelated rows', async () => {
    // The count-based predecessor would have passed (1 row >= 1 imported); the
    // id check must fail because the DB row is a DIFFERENT universe.
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 0 });
    await seedUniverses(['u1']);

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ universes: ['some-other-universe'] }) });

    expect(res.blocked).toBe(1);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(true);
  });

  it('prunes the genuinely-empty case (no ids on disk → nothing to verify)', async () => {
    await writeJSON(join(dataDir, 'story-builder.migrated.json'), { imported: 0 });
    await mkdir(join(dataDir, 'story-builder.imported'), { recursive: true });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ story_builder_sessions: [] }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(dataDir, 'story-builder.imported'))).toBe(false);
  });

  it('skips a domain with no migration marker (never parked anything)', async () => {
    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({}) });
    expect(res.blocked).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.markerWritten).toBe(true);
  });

  it('removes per-record nested artifacts but keeps live siblings', async () => {
    await writeJSON(join(dataDir, 'pipeline-series.migrated.json'), { imported: 2 });
    const seriesA = join(dataDir, 'pipeline-series', 'ser-a');
    const seriesB = join(dataDir, 'pipeline-series', 'ser-b');
    await mkdir(seriesA, { recursive: true });
    await mkdir(seriesB, { recursive: true });
    await writeJSON(join(seriesA, 'index.json.imported'), { id: 'ser-a' });
    await writeFile(join(seriesA, 'index.json'), '{}', 'utf-8');            // live record
    await writeFile(join(seriesA, 'manuscript-review.json'), '{}', 'utf-8'); // live sibling
    await writeJSON(join(seriesB, 'index.json.imported'), { id: 'ser-b' });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ pipeline_series: ['ser-a', 'ser-b'] }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(seriesA, 'index.json.imported'))).toBe(false);
    expect(await exists(join(seriesB, 'index.json.imported'))).toBe(false);
    // Live record + sibling untouched.
    expect(await exists(join(seriesA, 'index.json'))).toBe(true);
    expect(await exists(join(seriesA, 'manuscript-review.json'))).toBe(true);
  });

  it('removes writers-room metadata artifacts but keeps .md draft bodies', async () => {
    await writeJSON(join(dataDir, 'writers-room.migrated.json'), { folders: 1, works: 1, exercises: 1 });
    const wr = join(dataDir, 'writers-room');
    const work = join(wr, 'works', 'work-1');
    const drafts = join(work, 'drafts');
    await mkdir(drafts, { recursive: true });
    await writeJSON(join(wr, 'folders.imported.json'), [{ id: 'f1' }]);
    await writeJSON(join(wr, 'exercises.imported.json'), [{ id: 'e1' }]);
    await writeJSON(join(work, 'manifest.imported.json'), { id: 'work-1', drafts: [{ id: 'd1' }, { id: 'd2' }] });
    await writeFile(join(drafts, 'draft-1.md'), '# body', 'utf-8'); // file-primary body

    const db = stubDb({
      writers_room_folders: ['f1'], writers_room_exercises: ['e1'],
      writers_room_works: ['work-1'], writers_room_draft_versions: ['d1', 'd2'],
    });
    const res = await pruneImportedLegacyFiles({ dataDir, db });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(wr, 'folders.imported.json'))).toBe(false);
    expect(await exists(join(wr, 'exercises.imported.json'))).toBe(false);
    expect(await exists(join(work, 'manifest.imported.json'))).toBe(false);
    // The prose body MUST survive (it's file-primary, not migrated to DB).
    expect(await exists(join(drafts, 'draft-1.md'))).toBe(true);
  });

  it('WITHHOLDS writers-room prune when a folder id is missing, not just works', async () => {
    await writeJSON(join(dataDir, 'writers-room.migrated.json'), { folders: 1, works: 1, exercises: 0 });
    const wr = join(dataDir, 'writers-room');
    const work = join(wr, 'works', 'work-1');
    await mkdir(work, { recursive: true });
    await writeJSON(join(wr, 'folders.imported.json'), [{ id: 'f1' }]);
    await writeJSON(join(work, 'manifest.imported.json'), { id: 'work-1', drafts: [] });

    // Works present, folder f1 lost.
    const db = stubDb({ writers_room_folders: [], writers_room_works: ['work-1'], writers_room_draft_versions: [] });
    const res = await pruneImportedLegacyFiles({ dataDir, db });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(wr, 'folders.imported.json'))).toBe(true);
  });

  it('WITHHOLDS writers-room prune when a draft-version id is missing', async () => {
    // Restore kept folders/works/exercises but lost a draft-version row. The
    // manifest is the only recovery source for that version metadata.
    await writeJSON(join(dataDir, 'writers-room.migrated.json'), { folders: 0, works: 1, exercises: 0 });
    const wr = join(dataDir, 'writers-room');
    const work = join(wr, 'works', 'work-1');
    await mkdir(work, { recursive: true });
    await writeJSON(join(work, 'manifest.imported.json'), { id: 'work-1', drafts: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] });

    const db = stubDb({ writers_room_works: ['work-1'], writers_room_draft_versions: ['d1', 'd2'] });
    const res = await pruneImportedLegacyFiles({ dataDir, db });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(work, 'manifest.imported.json'))).toBe(true);
  });

  it('BLOCKS a domain whose parked JSON is present but unparseable (not treated as empty)', async () => {
    // A truncated/corrupt recovery file must not be deleted just because it
    // can't be read — that would treat it as zero records and prune the only
    // recovery source without proving anything is in the DB.
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeFile(join(dataDir, 'creative-director-projects.json.imported'), '[{"id":"cd-1"', 'utf-8'); // truncated

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ creative_director_projects: ['cd-1'] }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(true);
  });

  it('WITHHOLDS completion when a domain migration is pending (source on disk, no marker)', async () => {
    // creative-director migration failed/never ran: the legacy source is still
    // on disk with no marker. The prune must NOT stamp the global completion
    // marker, or a later boot (after repair + migration parks .imported) would
    // skip the prune forever.
    await writeJSON(join(dataDir, 'creative-director-projects.json'), [{ id: 'cd-1' }]);

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({}) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(false);
  });

  it('prunes the creative-director JSON export when its project ids are present', async () => {
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeJSON(join(dataDir, 'creative-director-projects.json.imported'), [{ id: 'cd-1' }]);

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ creative_director_projects: ['cd-1'] }) });

    expect(res.markerWritten).toBe(true);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(false);
  });

  it('BLOCKS a domain whose parked array has an id-less record (skipped by the original migrator)', async () => {
    // A record with no string id can't be verified against the DB; treating it
    // as absent and pruning would lose the only copy of a record the migrator
    // skipped. Must block the domain.
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeJSON(join(dataDir, 'creative-director-projects.json.imported'), [{ id: 'cd-1' }, { name: 'no-id project' }]);

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ creative_director_projects: ['cd-1'] }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(true);
  });

  it('BLOCKS a domain whose parked JSON has the wrong top-level shape', async () => {
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeJSON(join(dataDir, 'creative-director-projects.json.imported'), { not: 'an array' });

    const res = await pruneImportedLegacyFiles({ dataDir, db: stubDb({ creative_director_projects: ['cd-1'] }) });

    expect(res.blocked).toBe(1);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(true);
  });

  it('is marker-gated: a current marker no-ops without touching the DB', async () => {
    await writeJSON(join(dataDir, 'legacy-prune.applied.json'), { version: 1, completedAt: 'x', removed: 0 });
    let queried = false;
    const db = { async query() { queried = true; return { rows: [] }; } };

    const res = await pruneImportedLegacyFiles({ dataDir, db });

    expect(res.skipped).toBe(true);
    expect(queried).toBe(false);
  });

  it('force re-runs even with a current marker', async () => {
    await writeJSON(join(dataDir, 'legacy-prune.applied.json'), { version: 1, completedAt: 'x', removed: 0 });
    await writeJSON(join(dataDir, 'creative-director-projects.migrated.json'), { imported: 1 });
    await writeJSON(join(dataDir, 'creative-director-projects.json.imported'), [{ id: 'cd-1' }]);

    const res = await pruneImportedLegacyFiles({ dataDir, force: true, db: stubDb({ creative_director_projects: ['cd-1'] }) });

    expect(res.skipped).toBe(false);
    expect(await exists(join(dataDir, 'creative-director-projects.json.imported'))).toBe(false);
  });

  it('force re-run that ends blocked drops the stale clean marker so a normal boot retries', async () => {
    await writeJSON(join(dataDir, 'legacy-prune.applied.json'), { version: 1, completedAt: 'x', removed: 0 });
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 0 });
    await seedUniverses(['u1']);

    const res = await pruneImportedLegacyFiles({ dataDir, force: true, db: stubDb({ universes: [] }) });

    expect(res.blocked).toBe(1);
    expect(res.markerWritten).toBe(false);
    expect(await exists(join(dataDir, 'legacy-prune.applied.json'))).toBe(false);
    expect(await exists(join(dataDir, 'universes.imported'))).toBe(true);
  });

  it('is idempotent across runs (second run finds nothing to remove)', async () => {
    await writeJSON(join(dataDir, 'universes.migrated.json'), { imported: 1, runs: 0 });
    await seedUniverses(['u1']);
    const db = stubDb({ universes: ['u1'] });

    const first = await pruneImportedLegacyFiles({ dataDir, db });
    expect(first.removed).toBe(1);

    const second = await pruneImportedLegacyFiles({ dataDir, db });
    expect(second.skipped).toBe(true);
  });
});
