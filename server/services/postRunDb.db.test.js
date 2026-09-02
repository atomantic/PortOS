/** PostgreSQL atomicity/idempotency coverage for normalized POST runs (#4441). */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { saveNormalizedRun } from './postRunDb.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((error) => ({ connected: false, error: error?.message }));
  if (!health.connected) skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  else {
    await ensureSchema().catch(() => {});
    const probe = await query(`SELECT to_regclass('public.post_runs') IS NOT NULL AS ok`).catch(() => ({ rows: [] }));
    dbReady = probe.rows[0]?.ok === true;
    if (!dbReady) skipReason = 'post_runs schema unavailable';
  }
}
const runDb = requireDbOrSkip('services/postRunDb.db.test', dbReady, skipReason);

const nonce = `post-test-${Date.now()}`;
const runIds = [`${nonce}-one`, `${nonce}-owner`, `${nonce}-rollback`, `${nonce}-concurrent`];
const db = { query, withTransaction };

function makeRun(id, attempts) {
  return {
    id, mode: 'training', localDay: '2026-08-17',
    startedAt: '2026-08-17T10:00:00.000Z', completedAt: '2026-08-17T10:05:00.000Z',
    status: 'completed', planned: {}, data: { id }, attempts,
  };
}

const attempt = (id, score = 80) => ({
  id, module: 'mental-math', drillType: 'multiplication', score,
  latencyMs: 1000, completion: 1, data: { id, score },
});

afterAll(async () => {
  if (dbReady) {
    await query(`DELETE FROM post_runs WHERE id = ANY($1::text[])`, [runIds]).catch(() => {});
    await close();
  }
});

describe.skipIf(!runDb)('postRunDb transaction (#4441)', () => {
  it('upserts one run and its complete attempt set idempotently', async () => {
    await saveNormalizedRun(db, makeRun(runIds[0], [attempt(`${nonce}-a1`), attempt(`${nonce}-a2`)]));
    await saveNormalizedRun(db, makeRun(runIds[0], [attempt(`${nonce}-a2`), attempt(`${nonce}-a1`, 95)]));
    const result = await query(
      `SELECT count(*)::int AS count, max(score) AS max_score FROM post_attempts WHERE run_id = $1`,
      [runIds[0]],
    );
    expect(result.rows[0].count).toBe(2);
    expect(Number(result.rows[0].max_score)).toBe(95);
  });

  it('rolls back the run and earlier attempts when a later id collides', async () => {
    const sharedId = `${nonce}-shared`;
    await saveNormalizedRun(db, makeRun(runIds[1], [attempt(sharedId)]));
    await expect(saveNormalizedRun(db, makeRun(runIds[2], [
      attempt(`${nonce}-would-be-partial`), attempt(sharedId),
    ]))).rejects.toThrow(/another run/);
    const result = await query(
      `SELECT
         EXISTS(SELECT 1 FROM post_runs WHERE id = $1) AS run_exists,
         EXISTS(SELECT 1 FROM post_attempts WHERE id = $2) AS partial_exists`,
      [runIds[2], `${nonce}-would-be-partial`],
    );
    expect(result.rows[0]).toEqual({ run_exists: false, partial_exists: false });
  });

  it('serializes simultaneous first saves so only one is reported as new', async () => {
    const run = makeRun(runIds[3], [attempt(`${nonce}-concurrent-attempt`)]);
    const results = await Promise.all([
      saveNormalizedRun(db, run),
      saveNormalizedRun(db, run),
    ]);
    expect(results.map((result) => result.isNew).sort()).toEqual([false, true]);
    const stored = await query(`SELECT count(*)::int AS count FROM post_runs WHERE id = $1`, [runIds[3]]);
    expect(stored.rows[0].count).toBe(1);
  });
});
