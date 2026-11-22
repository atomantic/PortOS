/**
 * Postgres-backed tests for the autonomous job notepad (#17392): the advisory-locked cap check, upsert SQL,
 * key-ordered reads and per-job isolation only run here against real constraints. Runs via `npm run test:db`
 * (portos_test only). Fixture ids are invented and nonce-scoped.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';

// Exercise the real PG backend; the dedicated DB runner still enforces portos_test for all SQL.
vi.mock('../../lib/pgFileFacade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPgFileFacade: (options) => actual.createPgFileFacade({ ...options, isFile: () => false }),
    resolvePgBackend: async ({ loadDb, makePg }) => makePg(await loadDb()),
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
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/autonomousJobs/notepad.db.test', dbReady, skipReason);

const { listJobNotes, getJobNotepad, setJobNote, deleteJobNote, clearJobNotes } = await import('./notepad.js');
const { MAX_JOB_TOTAL_BYTES, MAX_VALUE_BYTES } = await import('../../lib/autonomousJobNotepad.js');

const nonce = `notepad-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const JOB = `${nonce}-a`;
const OTHER = `${nonce}-b`;

afterAll(async () => {
  if (dbReady) {
    await query('DELETE FROM autonomous_job_notepads WHERE job_id LIKE $1', [`${nonce}%`]);
    await close();
  }
});

describe.skipIf(!runDb)('autonomous job notepad (postgres)', () => {
  beforeEach(async () => {
    await clearJobNotes(JOB);
    await clearJobNotes(OTHER);
  });

  it('upserts, orders by key, isolates jobs and clears one job only', async () => {
    await setJobNote(JOB, 'b', '2');
    await setJobNote(JOB, 'a', '1');
    await setJobNote(JOB, 'b', '3');
    await setJobNote(OTHER, 'a', 'other');
    expect((await listJobNotes(JOB)).map(({ key, value }) => [key, value])).toEqual([['a', '1'], ['b', '3']]);
    expect(await deleteJobNote(JOB, 'zzz')).toBe(false);
    await clearJobNotes(JOB);
    expect(await listJobNotes(JOB)).toEqual([]);
    expect(await listJobNotes(OTHER)).toHaveLength(1);
  });

  it('rejects an overflow atomically, including under concurrent writers', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => setJobNote(JOB, `c${i}`, 'v'.repeat(MAX_VALUE_BYTES - 2))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 400)).toBe(true);
    const { usedBytes } = await getJobNotepad(JOB);
    expect(usedBytes).toBeLessThanOrEqual(MAX_JOB_TOTAL_BYTES);
    const before = await listJobNotes(JOB);
    await expect(setJobNote(JOB, 'extra', 'x')).rejects.toMatchObject({ status: 400 });
    expect(await listJobNotes(JOB)).toEqual(before);
  });
});
