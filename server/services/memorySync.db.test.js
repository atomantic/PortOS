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
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
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

  it('negotiates versions without importing peer counters or history', async () => {
    await query('DELETE FROM memories');
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-01-01T00:00:00.000Z', { content: 'Original', version: 90 })], 1);
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2099-01-01T00:00:00.000Z', { content: 'Replacement', version: 91 })], 1);
    const local = (await query('SELECT content, version FROM memories WHERE id = $1', [ID_A])).rows[0];
    expect(local).toEqual({ content: 'Replacement', version: 2 });
    expect((await query('SELECT version, content FROM memory_versions WHERE memory_id = $1', [ID_A])).rows).toEqual([{ version: 1, content: 'Original' }]);
    const legacy = await memorySync.getChangesSince('0', 100);
    expect(legacy.memories[0]).not.toHaveProperty('version');
    const modern = await memorySync.getChangesSince('0', 100, 1);
    expect(modern.memories[0].version).toBe(2);
    expect(modern).not.toHaveProperty('versions');
    await expect(memorySync.applyRemoteChanges([remoteMemory(ID_B, '2099-02-01T00:00:00.000Z')], 2)).rejects.toMatchObject({ status: 409 });
    await expect(memorySync.getChangesSince('0', 100, 2)).rejects.toMatchObject({ status: 409 });
    expect(await contentOf(ID_B)).toBeNull();
  });
  beforeEach(async () => {
    await query(`DELETE FROM memories`);
  });
  afterAll(async () => {
    await query(`DELETE FROM memories`).catch(() => {});
    await close();
  });

  // Replay two successive exported states into the same row to exercise the
  // real receiver's strict clock comparison, including JavaScript wire precision.
  const expectPeerAccepts = async (first, second) => {
    await query('DELETE FROM memories WHERE id = $1', [ID_A]);
    await memorySync.applyRemoteChanges([first]);
    expect(await memorySync.applyRemoteChanges([second])).toEqual({ inserted: 0, updated: 1, skipped: 0 });
    expect(await contentOf(ID_A)).toBe(second.content);
    expect((await memorySync.getChangesSince()).memories[0].updatedAt).toBe(second.updatedAt);
  };

  it('exports overlapping transaction edits with clocks peers accept in commit order', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-01-01T00:00:00.000Z')]);
    let first;
    await withTransaction(async client => {
      // Pin the older transaction clock before a separate connection commits.
      const { rows } = await client.query('SELECT NOW() AS started');
      await query(`UPDATE memories SET content = 'first commit', updated_at = $2::timestamptz + INTERVAL '1 millisecond' WHERE id = $1`, [ID_A, rows[0].started]);
      first = (await memorySync.getChangesSince()).memories[0];
      await client.query(`UPDATE memories SET content = 'late commit' WHERE id = $1`, [ID_A]);
    });
    const page = await memorySync.getChangesSince(first.syncSequence);
    expect(page.memories).toHaveLength(1);
    await expectPeerAccepts(first, page.memories[0]);
  });

  it('advances successive edits in one transaction at millisecond wire precision', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-01-01T00:00:00.000Z')]);
    let first;
    await withTransaction(async client => {
      const { rows } = await client.query(`UPDATE memories SET content = 'first edit' WHERE id = $1 RETURNING updated_at`, [ID_A]);
      first = remoteMemory(ID_A, rows[0].updated_at.toISOString(), { content: 'first edit' });
      await client.query(`UPDATE memories SET content = 'second edit' WHERE id = $1`, [ID_A]);
    });
    await expectPeerAccepts(first, (await memorySync.getChangesSince()).memories[0]);
  });

  it('advances past a future peer clock while keeping access statistics out of the feed', async () => {
    const future = '2099-01-01T00:00:00.123Z';
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, future)]);
    const first = (await memorySync.getChangesSince()).memories[0];
    expect(first.updatedAt).toBe(future);
    await query('UPDATE memories SET access_count = access_count + 1, last_accessed = NOW() WHERE id = $1', [ID_A]);
    expect((await memorySync.getChangesSince(first.syncSequence)).memories).toEqual([]);
    expect((await memorySync.getChangesSince()).memories[0].updatedAt).toBe(future);
    await query(`UPDATE memories SET content = 'local edit after future peer', updated_at = NULL WHERE id = $1`, [ID_A]);
    const second = (await memorySync.getChangesSince(first.syncSequence)).memories[0];
    expect(second.updatedAt).toBe('2099-01-01T00:00:00.124Z');
    await expectPeerAccepts(first, second);
  });

  it('keeps local relation edits monotonic and returns their persisted clock', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2099-01-01T00:00:00.000Z')]);
    const { updateMemory } = await import('./memoryDB.js');
    const updated = await updateMemory(ID_A, { content: 'edited with relations', relatedMemories: [] });
    const exported = (await memorySync.getChangesSince()).memories[0];
    expect(Date.parse(exported.updatedAt)).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'));
    expect(updated.updatedAt).toBe(exported.updatedAt);
  });

  it('keeps chosen identity local through outbound and incoming federation, including id collisions', async () => {
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-01-02T00:00:00.000Z')]);
    await query(`UPDATE memories SET source_agent_id = $1, content = $2, tags = $3 WHERE id = $4`, ['cos-persistent-mind', 'Example Star', ['mind:chosen-name', 'mind:core-identity'], ID_A]);
    expect((await memorySync.getChangesSince()).memories).toEqual([]);
    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_A, '2026-01-03T00:00:00.000Z'),
      remoteMemory(ID_B, '2026-01-03T00:00:00.000Z', { sourceAgentId: 'cos-persistent-mind' }),
      remoteMemory('00000000-0000-4000-8000-00000000cccc', '2026-01-03T00:00:00.000Z', { tags: ['mind:chosen-name'] }),
    ]);
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 3 });
    expect(await contentOf(ID_A)).toBe('Example Star');
    expect(await contentOf(ID_B)).toBeNull();
  });

  it('keeps Brain-bridge rows out of the stream in both directions', async () => {
    // Each install derives its own bridged rows from the synced Brain record; a
    // replicated copy outlives the record's deletion on the origin (#14260).
    await memorySync.applyRemoteChanges([remoteMemory(ID_A, '2026-01-02T00:00:00.000Z')]);
    await query(`UPDATE memories SET source_agent_id = 'brain-bridge' WHERE id = $1`, [ID_A]);
    expect((await memorySync.getChangesSince()).memories).toEqual([]);
    const result = await memorySync.applyRemoteChanges([
      remoteMemory(ID_B, '2026-01-03T00:00:00.000Z', { sourceAgentId: 'brain-bridge' }),
    ]);
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect(await contentOf(ID_B)).toBeNull();
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
