/**
 * Postgres-backed round-trip for the Writers Room DB adapter (#1017). SKIPS
 * cleanly when no DB is reachable. Snapshots + restores all four tables.
 *
 * Covers the one decomposition unique to this slice: a work manifest's drafts[]
 * array is split into writers_room_draft_versions rows on write and reassembled
 * into the manifest on read; a version removed from the array prunes its row.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';

const TABLES = [
  'writers_room_folders', 'writers_room_works',
  'writers_room_draft_versions', 'writers_room_exercises',
];

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'writers_room_works') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'writers_room_works table not present';
  }
}

if (!dbReady) console.log(`⏭️  writersRoom/db.test.js skipped: ${skipReason}`);

const draft = (id, extra = {}) => ({
  id, label: 'Draft 1', contentFile: `drafts/${id}.md`, contentHash: 'h'.repeat(64),
  wordCount: 3, segmentIndex: [{ id: 'seg-001', kind: 'paragraph', heading: '(untitled)', start: 0, end: 10, wordCount: 3 }],
  createdAt: '2026-01-01T00:00:00.000Z', createdFromVersionId: null, ...extra,
});

const manifest = (id, extra = {}) => ({
  id, folderId: null, title: id, kind: 'short-story', status: 'drafting',
  activeDraftVersionId: 'wr-draft-a', drafts: [draft('wr-draft-a')],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra,
});

describe.skipIf(!dbReady)('Writers Room DB adapter round-trip', () => {
  let db;
  const snaps = {};
  beforeAll(async () => {
    db = await import('./db.js');
    for (const t of TABLES) snaps[t] = (await query(`SELECT * FROM ${t}`)).rows;
  });

  beforeEach(async () => {
    for (const t of TABLES) await query(`DELETE FROM ${t}`);
  });

  afterAll(async () => {
    for (const t of TABLES) await query(`DELETE FROM ${t}`).catch(() => {});
    // Restore folders + exercises + works + drafts verbatim from the snapshot.
    for (const r of snaps.writers_room_folders || []) {
      await query(
        `INSERT INTO writers_room_folders (id, parent_id, name, sort_order, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.parent_id, r.name, r.sort_order, JSON.stringify(r.data), r.created_at, r.updated_at],
      ).catch(() => {});
    }
    for (const r of snaps.writers_room_works || []) {
      await query(
        `INSERT INTO writers_room_works (id, folder_id, title, kind, status, active_draft_version_id, pipeline_series_id, pipeline_issue_id, cd_project_id, media_collection_id, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.folder_id, r.title, r.kind, r.status, r.active_draft_version_id, r.pipeline_series_id, r.pipeline_issue_id, r.cd_project_id, r.media_collection_id, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    for (const r of snaps.writers_room_draft_versions || []) {
      await query(
        `INSERT INTO writers_room_draft_versions (id, work_id, label, content_file, content_hash, word_count, segment_index, created_from_version_id, data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.work_id, r.label, r.content_file, r.content_hash, r.word_count, JSON.stringify(r.segment_index), r.created_from_version_id, JSON.stringify(r.data), r.created_at],
      ).catch(() => {});
    }
    for (const r of snaps.writers_room_exercises || []) {
      await query(
        `INSERT INTO writers_room_exercises (id, work_id, status, data, started_at, finished_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.work_id, r.status, JSON.stringify(r.data), r.started_at, r.finished_at],
      ).catch(() => {});
    }
    await close();
  });

  it('folder upsert round-trips and mirror columns reflect the body', async () => {
    await db.writeFolder({ id: 'wr-folder-1', parentId: null, name: 'Novels', sortOrder: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const all = await db.listFolders();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'wr-folder-1', name: 'Novels', sortOrder: 2 });
    const col = (await query(`SELECT name, sort_order FROM writers_room_folders WHERE id = 'wr-folder-1'`)).rows[0];
    expect(col.name).toBe('Novels');
    expect(col.sort_order).toBe(2);
  });

  it('writeWork decomposes drafts[] into rows and readWork reassembles them', async () => {
    const m = manifest('wr-work-1', {
      activeDraftVersionId: 'wr-draft-b',
      drafts: [draft('wr-draft-a'), draft('wr-draft-b', { label: 'Draft 2', createdFromVersionId: 'wr-draft-a' })],
    });
    await db.writeWork(m);
    // The work row's `data` must NOT carry drafts[] (the rows are authoritative).
    const workData = (await query(`SELECT data FROM writers_room_works WHERE id = 'wr-work-1'`)).rows[0].data;
    expect(workData.drafts).toBeUndefined();
    const draftRows = (await query(`SELECT id FROM writers_room_draft_versions WHERE work_id = 'wr-work-1' ORDER BY id`)).rows;
    expect(draftRows.map((r) => r.id)).toEqual(['wr-draft-a', 'wr-draft-b']);
    // readWork rebuilds the manifest with drafts[] embedded again.
    const back = await db.readWork('wr-work-1');
    expect(back.drafts.map((d) => d.id)).toEqual(['wr-draft-a', 'wr-draft-b']);
    expect(back.drafts[1].label).toBe('Draft 2');
    expect(back.title).toBe('wr-work-1');
  });

  it('removing a version from drafts[] prunes its row on the next write', async () => {
    await db.writeWork(manifest('wr-work-1', {
      drafts: [draft('wr-draft-a'), draft('wr-draft-b')],
    }));
    await db.writeWork(manifest('wr-work-1', { drafts: [draft('wr-draft-a')] }));
    const rows = (await query(`SELECT id FROM writers_room_draft_versions WHERE work_id = 'wr-work-1'`)).rows;
    expect(rows.map((r) => r.id)).toEqual(['wr-draft-a']);
  });

  it('promote/bridge links + draft metadata mirror into columns', async () => {
    await db.writeWork(manifest('wr-work-1', {
      pipelineSeriesId: 'ser-9', cdProjectId: 'cd-9', mediaCollectionId: 'col-9',
    }));
    const col = (await query(`SELECT pipeline_series_id, cd_project_id, media_collection_id, active_draft_version_id FROM writers_room_works WHERE id = 'wr-work-1'`)).rows[0];
    expect(col.pipeline_series_id).toBe('ser-9');
    expect(col.cd_project_id).toBe('cd-9');
    expect(col.media_collection_id).toBe('col-9');
    const dcol = (await query(`SELECT content_hash, word_count FROM writers_room_draft_versions WHERE id = 'wr-draft-a'`)).rows[0];
    expect(dcol.word_count).toBe(3);
    expect(dcol.content_hash).toBe('h'.repeat(64));
  });

  it('deleteWork soft-deletes (tombstone) — hidden from live reads, row + drafts retained for federation', async () => {
    await db.writeWork(manifest('wr-work-1'));
    await db.writeWork(manifest('wr-work-2', { drafts: [draft('wr-draft-c')], activeDraftVersionId: 'wr-draft-c' }));
    await db.deleteWork('wr-work-2'); // soft-delete tombstone (#1565 federation)
    const works = await db.listWorks();
    expect(works.map((w) => w.id)).toEqual(['wr-work-1']);
    expect(works[0].drafts.map((d) => d.id)).toEqual(['wr-draft-a']);
    // Live reads filter the tombstone out…
    expect(await db.readWork('wr-work-2')).toBeNull();
    expect(await db.listWorkIds()).toEqual(['wr-work-1']);
    // …but the row, its draft rows, and the tombstone trio survive until prune.
    expect((await query(`SELECT deleted FROM writers_room_works WHERE id = 'wr-work-2'`)).rows[0].deleted).toBe(true);
    expect((await query(`SELECT 1 FROM writers_room_draft_versions WHERE work_id = 'wr-work-2'`)).rows).toHaveLength(1);
    // readWork({ includeDeleted }) surfaces the tombstone for the federation push.
    const tomb = await db.readWork('wr-work-2', { includeDeleted: true });
    expect(tomb.deleted).toBe(true);
    expect(await db.listWorkIds({ includeDeleted: true })).toEqual(expect.arrayContaining(['wr-work-1', 'wr-work-2']));
  });

  it('countWorks counts the live set without rebuilding any manifest', async () => {
    // The cheap tally the character skill registry reads (#2729) instead of
    // listWorks().length — which runs the drafts query and reassembles every
    // manifest. Pin the two together so they can never disagree.
    expect(await db.countWorks()).toBe(0);

    await db.writeWork(manifest('wr-work-1'));
    await db.writeWork(manifest('wr-work-2'));
    expect(await db.countWorks()).toBe(2);
    expect(await db.countWorks()).toBe((await db.listWorks()).length);

    // A tombstoned work is retained for federation but must NOT be counted.
    await db.deleteWork('wr-work-2');
    expect(await db.listWorkIds({ includeDeleted: true })).toHaveLength(2);
    expect(await db.countWorks()).toBe(1);
    expect(await db.countWorks()).toBe((await db.listWorks()).length);
  });

  it('mergeWorksFromSync inserts a remote work and LWW-resolves a later edit', async () => {
    const insert = await db.mergeWorksFromSync([manifest('wr-work-1', { title: 'Remote', updatedAt: '2026-02-01T00:00:00.000Z' })]);
    expect(insert).toEqual({ applied: true, count: 1 });
    expect((await db.readWork('wr-work-1')).title).toBe('Remote');
    // Older remote loses (no-op); newer remote wins.
    expect(await db.mergeWorksFromSync([manifest('wr-work-1', { title: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' })])).toEqual({ applied: false, count: 0 });
    expect((await db.readWork('wr-work-1')).title).toBe('Remote');
    expect(await db.mergeWorksFromSync([manifest('wr-work-1', { title: 'Newer', updatedAt: '2026-03-01T00:00:00.000Z' })])).toEqual({ applied: true, count: 1 });
    expect((await db.readWork('wr-work-1')).title).toBe('Newer');
  });

  it('pruneTombstonedWorks hard-removes old tombstones (rows + drafts) and returns their ids', async () => {
    await db.writeWork(manifest('wr-work-1'));
    await db.mergeWorksFromSync([manifest('wr-work-1', { deleted: true, deletedAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' })]);
    // Cutoff before the tombstone → nothing pruned.
    expect(await db.pruneTombstonedWorks(Date.parse('2026-01-04T00:00:00.000Z'))).toEqual({ pruned: 0, ids: [] });
    expect((await query(`SELECT 1 FROM writers_room_works WHERE id = 'wr-work-1'`)).rows).toHaveLength(1);
    // Cutoff after the tombstone → row + draft rows gone, id returned.
    expect(await db.pruneTombstonedWorks(Date.parse('2026-02-01T00:00:00.000Z'))).toEqual({ pruned: 1, ids: ['wr-work-1'] });
    expect((await query(`SELECT 1 FROM writers_room_works WHERE id = 'wr-work-1'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM writers_room_draft_versions WHERE work_id = 'wr-work-1'`)).rows).toHaveLength(0);
  });

  it('deleteFolder soft-deletes (tombstone) — hidden from live reads, row retained for federation (#1645)', async () => {
    await db.writeFolder({ id: 'wr-folder-1', parentId: null, name: 'Keep', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    await db.writeFolder({ id: 'wr-folder-2', parentId: null, name: 'Gone', sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    await db.deleteFolder('wr-folder-2');
    expect((await db.listFolders()).map((f) => f.id)).toEqual(['wr-folder-1']);
    expect(await db.readFolder('wr-folder-2')).toBeNull();
    expect(await db.listFolderIds()).toEqual(['wr-folder-1']);
    expect((await query(`SELECT deleted FROM writers_room_folders WHERE id = 'wr-folder-2'`)).rows[0].deleted).toBe(true);
    const tomb = await db.readFolder('wr-folder-2', { includeDeleted: true });
    expect(tomb.deleted).toBe(true);
    expect(await db.listFolderIds({ includeDeleted: true })).toEqual(expect.arrayContaining(['wr-folder-1', 'wr-folder-2']));
  });

  it('mergeFoldersFromSync inserts + LWW-resolves, pruneTombstonedFolders hard-removes old tombstones (#1645)', async () => {
    const folder = (extra = {}) => ({ id: 'wr-folder-1', parentId: null, name: 'Remote', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', ...extra });
    expect(await db.mergeFoldersFromSync([folder()])).toEqual({ applied: true, count: 1 });
    expect((await db.readFolder('wr-folder-1')).name).toBe('Remote');
    expect(await db.mergeFoldersFromSync([folder({ name: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' })])).toEqual({ applied: false, count: 0 });
    expect(await db.mergeFoldersFromSync([folder({ name: 'Newer', updatedAt: '2026-03-01T00:00:00.000Z' })])).toEqual({ applied: true, count: 1 });
    expect((await db.readFolder('wr-folder-1')).name).toBe('Newer');
    // Tombstone + prune.
    await db.mergeFoldersFromSync([folder({ deleted: true, deletedAt: '2026-04-05T00:00:00.000Z', updatedAt: '2026-04-05T00:00:00.000Z' })]);
    expect(await db.pruneTombstonedFolders(Date.parse('2026-04-04T00:00:00.000Z'))).toEqual({ pruned: 0, ids: [] });
    expect((await query(`SELECT 1 FROM writers_room_folders WHERE id = 'wr-folder-1'`)).rows).toHaveLength(1);
    expect(await db.pruneTombstonedFolders(Date.parse('2026-05-01T00:00:00.000Z'))).toEqual({ pruned: 1, ids: ['wr-folder-1'] });
    expect((await query(`SELECT 1 FROM writers_room_folders WHERE id = 'wr-folder-1'`)).rows).toHaveLength(0);
  });

  it('mergeExercisesFromSync inserts + LWW-resolves, pruneTombstonedExercises hard-removes old tombstones (#1645)', async () => {
    const ex = (extra = {}) => ({ id: 'wr-ex-1', workId: null, prompt: 'go', status: 'running', startingWords: 0, startedAt: '2026-01-03T00:00:00.000Z', finishedAt: null, ...extra });
    expect(await db.mergeExercisesFromSync([ex()])).toEqual({ applied: true, count: 1 });
    expect((await db.readExercise('wr-ex-1')).status).toBe('running');
    // The finish transition (finishedAt advances the derived LWW key) wins.
    expect(await db.mergeExercisesFromSync([ex({ status: 'finished', finishedAt: '2026-01-03T01:00:00.000Z', wordsAdded: 50 })])).toEqual({ applied: true, count: 1 });
    expect((await db.readExercise('wr-ex-1')).status).toBe('finished');
    // A stale running push (older key) loses.
    expect(await db.mergeExercisesFromSync([ex()])).toEqual({ applied: false, count: 0 });
    // Tombstone + prune.
    await db.mergeExercisesFromSync([ex({ status: 'finished', deleted: true, deletedAt: '2026-02-05T00:00:00.000Z', updatedAt: '2026-02-05T00:00:00.000Z', finishedAt: '2026-01-03T01:00:00.000Z' })]);
    expect(await db.readExercise('wr-ex-1')).toBeNull();
    expect(await db.pruneTombstonedExercises(Date.parse('2026-02-04T00:00:00.000Z'))).toEqual({ pruned: 0, ids: [] });
    expect(await db.pruneTombstonedExercises(Date.parse('2026-03-01T00:00:00.000Z'))).toEqual({ pruned: 1, ids: ['wr-ex-1'] });
    expect((await query(`SELECT 1 FROM writers_room_exercises WHERE id = 'wr-ex-1'`)).rows).toHaveLength(0);
  });

  it('exercise upsert round-trips and mirror columns reflect work_id/status', async () => {
    await db.writeExercise({ id: 'wr-ex-1', workId: 'wr-work-1', status: 'running', prompt: 'go', startedAt: '2026-01-03T00:00:00.000Z', finishedAt: null });
    await db.writeExercise({ id: 'wr-ex-1', workId: 'wr-work-1', status: 'finished', prompt: 'go', wordsAdded: 50, startedAt: '2026-01-03T00:00:00.000Z', finishedAt: '2026-01-03T01:00:00.000Z' });
    const all = await db.listExercises();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('finished');
    expect(all[0].wordsAdded).toBe(50);
    const col = (await query(`SELECT status, work_id FROM writers_room_exercises WHERE id = 'wr-ex-1'`)).rows[0];
    expect(col.status).toBe('finished');
    expect(col.work_id).toBe('wr-work-1');
  });

  it('a work-less exercise (workId null) is allowed', async () => {
    await db.writeExercise({ id: 'wr-ex-free', workId: null, status: 'running', startedAt: '2026-01-04T00:00:00.000Z', finishedAt: null });
    const col = (await query(`SELECT work_id FROM writers_room_exercises WHERE id = 'wr-ex-free'`)).rows[0];
    expect(col.work_id).toBeNull();
  });

  it('tolerates malformed timestamps without throwing', async () => {
    await db.writeWork(manifest('wr-work-1', { createdAt: 'nope', updatedAt: 'not-a-date' }));
    const col = (await query(`SELECT created_at, updated_at FROM writers_room_works WHERE id = 'wr-work-1'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date);
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('listDraftVersionsForCoherence returns one entry per live draft row', async () => {
    await db.writeWork(manifest('wr-work-1', { drafts: [draft('wr-draft-a'), draft('wr-draft-b')] }));
    const coh = await db.listDraftVersionsForCoherence();
    expect(coh.map((c) => c.id).sort()).toEqual(['wr-draft-a', 'wr-draft-b']);
    expect(coh[0]).toMatchObject({ workId: 'wr-work-1', contentFile: expect.stringMatching(/^drafts\//) });
  });
});
