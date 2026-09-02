/**
 * Postgres-backed round-trip for the Creative Director DB store.
 *
 * Like catalogDB.test.js, this needs a live PostgreSQL with the schema applied.
 * If no DB is reachable (CI, fresh checkout), it SKIPS cleanly rather than
 * failing red. When a DB IS reachable it exercises the full project lifecycle
 * (create → treatment → scene patch → run append/update → delete) and a
 * concurrent-write race (the reason the DB backend uses SELECT … FOR UPDATE),
 * tearing its rows back out so the suite is repeatable.
 *
 * mediaCollections.createCollection is mocked so createProject doesn't need the
 * full media stack — we only care about the project row here.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';

vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-test' })),
}));

const syncCounter = vi.hoisted(() => ({ baseHash: 0 }));
vi.mock('../../lib/conflictJournal.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    maybeJournalBeforeOverwrite: vi.fn(async () => {}),
    setSyncBaseHash: vi.fn(async () => { syncCounter.baseHash += 1; }),
    flushBaseHashes: vi.fn(async () => {}),
  };
});

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({}));
    // hasSchema is the memory-schema flag; ensureSchema also creates our table.
    // Probe the table directly so we don't couple to the memory schema state.
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'creative_director_projects') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'creative_director_projects table not present';
  }
}

const runDb = requireDbOrSkip('services/creativeDirector/projectsDB.test', dbReady, skipReason);

const CREATE_INPUT = {
  name: 'DB round-trip', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9,
};
const TREATMENT = {
  logline: 'A ball bounces.', synopsis: 'It bounces a lot.',
  scenes: [{ sceneId: 'scene-1', order: 0, intent: 'bounce', prompt: 'a bouncing ball', durationSeconds: 3 }],
};

describe.skipIf(!runDb)('projectsDB round-trip', () => {
  const created = [];
  let db;
  // Import AFTER the skip gate so a no-DB run never touches the pool.
  beforeAll(async () => { db = await import('./projectsDB.js'); });

  afterAll(async () => {
    for (const id of created) {
      await query(`DELETE FROM creative_director_projects WHERE id = $1`, [id]).catch(() => {});
    }
    await close();
  });

  it('creates, reads back, and lists a project (lossless shape)', async () => {
    const p = await db.createProject(CREATE_INPUT);
    created.push(p.id);
    expect(p.id).toMatch(/^cd-/);
    expect(p.status).toBe('draft');
    expect(p.collectionId).toBe('col-test');

    const fetched = await db.getProject(p.id);
    expect(fetched).toEqual(p);

    const list = await db.listProjects();
    expect(list.some((x) => x.id === p.id)).toBe(true);
  });

  // A legacy/partial write can leave the JSONB without an `id` while the PK
  // column still has one. Reads used to hand that record out id-less, and the
  // Creative Director grid then rendered a card keyed on `undefined` that
  // linked to /creative-director/undefined/overview (start/pause/delete all
  // acting on `undefined`). Reads must backfill from the authoritative column.
  it('backfills a missing JSONB id from the primary-key column', async () => {
    const id = 'cd-legacy-no-json-id';
    created.push(id);
    // Deliberately write `data` WITHOUT an id to reproduce the bad row.
    await query(
      `INSERT INTO creative_director_projects (id, status, data, created_at, updated_at, deleted)
       VALUES ($1, 'draft', $2::jsonb, now(), now(), FALSE)`,
      [id, JSON.stringify({ name: 'Legacy row', status: 'draft' })],
    );

    const fetched = await db.getProject(id);
    expect(fetched.id).toBe(id);
    expect(fetched.name).toBe('Legacy row'); // the spread must not drop fields

    const all = await db.listProjects();
    expect(all.find((p) => p.name === 'Legacy row')?.id).toBe(id);
  });

  it('rejects persistence when the project id is missing', async () => {
    await expect(db.persist(query, { name: 'Missing id' })).rejects.toMatchObject({ code: 'PROJECT_ID_MISSING' });
  });

  it('same-updatedAt re-push does not persist or rewrite the base hash', async () => {
    const remote = {
      id: 'cd-same-timestamp', name: 'Same', status: 'draft', runs: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      deleted: false, deletedAt: null,
    };
    created.push(remote.id);
    await db.mergeProjectsFromSync([remote]);
    const before = await query(`SELECT xmin::text AS version FROM creative_director_projects WHERE id = $1`, [remote.id]);
    syncCounter.baseHash = 0;

    expect(await db.mergeProjectsFromSync([remote])).toEqual({ applied: false, count: 0 });
    const after = await query(`SELECT xmin::text AS version FROM creative_director_projects WHERE id = $1`, [remote.id]);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect(syncCounter.baseHash).toBe(0);
  });

  // #4148 — the batch-by-id read the Creative Commission detail page uses so it
  // doesn't list every project on the install.
  it('batch-fetches by id, skipping unknown ids and tombstoned projects', async () => {
    const a = await db.createProject(CREATE_INPUT);
    const b = await db.createProject(CREATE_INPUT);
    const gone = await db.createProject(CREATE_INPUT);
    created.push(a.id, b.id, gone.id);
    await db.deleteProject(gone.id);

    const batch = await db.getProjectsByIds([a.id, 'cd-does-not-exist', gone.id, b.id]);
    expect(batch.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());

    expect(await db.getProjectsByIds([])).toEqual([]);
    // includeDeleted opts the tombstone back in (the sync/GC read shape).
    const withDeleted = await db.getProjectsByIds([gone.id], { includeDeleted: true });
    expect(withDeleted.map((p) => p.id)).toEqual([gone.id]);
  });

  it('applies a treatment and patches a scene', async () => {
    const p = await db.createProject(CREATE_INPUT);
    created.push(p.id);
    const withTreatment = await db.setTreatment(p.id, TREATMENT);
    expect(withTreatment.status).toBe('rendering');
    expect(withTreatment.treatment.scenes[0].status).toBe('pending');

    const updatedScene = await db.updateScene(p.id, 'scene-1', { status: 'rendering', renderedJobId: 'job-1' });
    expect(updatedScene).toMatchObject({ status: 'rendering', renderedJobId: 'job-1' });
    const reread = await db.getProject(p.id);
    expect(reread.treatment.scenes[0].renderedJobId).toBe('job-1');
  });

  it('appends and updates runs; unknown runId returns null', async () => {
    const p = await db.createProject(CREATE_INPUT);
    created.push(p.id);
    const run = await db.recordRun(p.id, { kind: 'treatment', status: 'running' });
    expect(run.runId).toBeTruthy();

    const done = await db.updateRun(p.id, run.runId, { status: 'completed' });
    expect(done.status).toBe('completed');

    const missing = await db.updateRun(p.id, 'no-such-run', { status: 'completed' });
    expect(missing).toBeNull();
  });

  it('deletes a project (and 404s on a missing one)', async () => {
    const p = await db.createProject(CREATE_INPUT);
    const res = await db.deleteProject(p.id);
    expect(res).toEqual({ ok: true });
    expect(await db.getProject(p.id)).toBeNull();
    await expect(db.updateProject(p.id, { name: 'Zombie' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(db.deleteProject(p.id)).rejects.toThrow(/not found/);
  });

  it('serializes concurrent run appends to the same project (no lost update)', async () => {
    const p = await db.createProject(CREATE_INPUT);
    created.push(p.id);
    // Fire 10 concurrent recordRun calls. With SELECT … FOR UPDATE each one
    // sees the prior append, so all 10 survive; a naive read-modify-write would
    // lose most of them.
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      db.recordRun(p.id, { runId: `r${i}`, kind: 'evaluate', status: 'running' })));
    const reread = await db.getProject(p.id);
    expect(reread.runs).toHaveLength(10);
    expect(new Set(reread.runs.map((r) => r.runId)).size).toBe(10);
  });
});
