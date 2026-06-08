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

vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-test' })),
}));

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

if (!dbReady) console.log(`⏭️  projectsDB.test.js skipped: ${skipReason}`);

const CREATE_INPUT = {
  name: 'DB round-trip', aspectRatio: '1:1', quality: 'draft', modelId: 'm', targetDurationSeconds: 9,
};
const TREATMENT = {
  logline: 'A ball bounces.', synopsis: 'It bounces a lot.',
  scenes: [{ sceneId: 'scene-1', order: 0, intent: 'bounce', prompt: 'a bouncing ball', durationSeconds: 3 }],
};

describe.skipIf(!dbReady)('projectsDB round-trip', () => {
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
