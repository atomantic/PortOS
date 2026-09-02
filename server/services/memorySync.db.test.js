/**
 * Postgres-backed tests for `applyRemoteChanges` — the federation write path.
 *
 * This is the one function in `memorySync.js` that takes a REMOTE peer's payload
 * and writes it, so it is the place where an assumption about that payload's
 * shape becomes a data bug. It batches 100 rows into a single multi-row
 * `INSERT … ON CONFLICT (id) DO UPDATE` inside one transaction, which makes two
 * properties worth pinning against a real Postgres:
 *
 *   - a repeated id in the payload must not abort the apply (Postgres refuses a
 *     multi-row upsert that names one conflict key twice), and
 *   - the last-writer-wins rule must be decided by `updated_at`, never by where
 *     a row happened to sit in the peer's list.
 *
 * Neither is expressible without the database: the first is a Postgres statement
 * constraint and the second lives in the `WHERE EXCLUDED.updated_at >` clause.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this). Registered in `DB_TEST_INCLUDE` in `vitest.config.db.js`, without which
 * it would silently never run.
 *
 * `applyRemoteChanges` reads and writes the whole `memories` table by id, so
 * like `memoryDB.db.test.js` this suite clears the table and seeds its own rows.
 * `fileParallelism: false` means nothing else is touching it meanwhile.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasSchema: false }));
    if (recheck.hasSchema) dbReady = true;
    else skipReason = 'memory schema not present';
  }
}
const runDb = requireDbOrSkip('services/memorySync.db.test', dbReady, skipReason);

// Obviously-fake ids; the payload shape is what applyRemoteChanges expects off
// the wire (camelCase, since it maps to columns itself).
const ID_A = '00000000-0000-4000-8000-00000000aaaa';
const ID_B = '00000000-0000-4000-8000-00000000bbbb';

const remoteMemory = (id, updatedAt, overrides = {}) => ({
  id,
  type: 'fact',
  content: `content @ ${updatedAt}`,
  summary: null,
  category: 'general',
  tags: [],
  embedding: null,
  embeddingModel: null,
  confidence: 0.5,
  importance: 0.5,
  status: 'active',
  sourceTaskId: null,
  sourceAgentId: null,
  sourceAppId: null,
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt,
  originInstanceId: '00000000-0000-4000-8000-00000000feed',
  ...overrides,
});

const contentOf = async (id) => {
  const res = await query(`SELECT content FROM memories WHERE id = $1`, [id]);
  return res.rows[0]?.content ?? null;
};

describe.skipIf(!runDb)('memorySync.applyRemoteChanges', () => {
  let memorySync;
  beforeAll(async () => {
    memorySync = await import('./memorySync.js');
  });
  beforeEach(async () => {
    await query(`DELETE FROM memories`);
  });
  afterAll(async () => {
    await query(`DELETE FROM memories`).catch(() => {});
    await close();
  });

  it('applies a duplicated id instead of aborting the whole transaction', async () => {
    // Regression: a peer payload repeating one id made the batched multi-row
    // upsert throw "ON CONFLICT DO UPDATE command cannot affect row a second
    // time". Because the batches share a transaction, that rolled back EVERY
    // row in the payload — including the ones with no duplicate at all, which is
    // what turns a peer's malformed page into a permanently stalled sync.
    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-05-01T00:00:00.000Z'),
      remoteMemory(ID_A, '2026-05-02T00:00:00.000Z'),
      remoteMemory(ID_B, '2026-05-01T00:00:00.000Z'),
    ]);

    // The unrelated row survived — that is the property the rollback destroyed.
    expect(await contentOf(ID_B)).toBe('content @ 2026-05-01T00:00:00.000Z');
    expect(await contentOf(ID_A)).toBe('content @ 2026-05-02T00:00:00.000Z');
    // The collapsed copy lost last-writer-wins, so it counts as skipped and the
    // three tallies still account for every row the peer sent.
    expect(result).toEqual({ inserted: 2, updated: 0, skipped: 1 });
  });

  it('resolves a duplicated id by updated_at, not by payload order', async () => {
    // The tie-break has to match what the ON CONFLICT clause would have done had
    // the same two rows arrived in separate batches — otherwise a peer could
    // flip which copy wins just by reordering its page.
    await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-06-09T00:00:00.000Z'),   // newest, sent FIRST
      remoteMemory(ID_A, '2026-06-01T00:00:00.000Z'),
    ]);
    expect(await contentOf(ID_A)).toBe('content @ 2026-06-09T00:00:00.000Z');
  });

  it('keeps the parseable copy when a duplicate carries a malformed clock', async () => {
    // A malformed `updatedAt` must not win the collapse: it would be handed to a
    // timestamptz column and fail the statement, losing a row we could have
    // applied intact. NaN compares false against everything, so the comparator
    // has to sort it below a real clock explicitly rather than by accident.
    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-09-01T00:00:00.000Z'),
      remoteMemory(ID_A, 'not-a-timestamp'),
    ]);
    expect(await contentOf(ID_A)).toBe('content @ 2026-09-01T00:00:00.000Z');
    expect(result).toMatchObject({ inserted: 1, skipped: 1 });
  });

  it('still refuses a remote row older than the local one (last-writer-wins)', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-07-10T00:00:00.000Z')]);

    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-07-01T00:00:00.000Z'),
    ]);
    expect(await contentOf(ID_A)).toBe('content @ 2026-07-10T00:00:00.000Z');
    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
  });

  it('updates in place when the remote row is newer', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-08-01T00:00:00.000Z')]);

    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-08-20T00:00:00.000Z'),
    ]);
    expect(await contentOf(ID_A)).toBe('content @ 2026-08-20T00:00:00.000Z');
    expect(result).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });
  });
});
