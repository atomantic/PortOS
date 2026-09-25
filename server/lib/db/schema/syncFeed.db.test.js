/**
 * Postgres-backed contract for the commit-ordered federation change feed (#8315).
 *
 * The bug this pins is a visibility interleaving that only a real database can
 * produce: transaction T1 writes a row (drawing a LOWER write-time
 * sync_sequence) and stays open, T2 writes and commits, a peer pulls and
 * advances its cursor past T2, then T1 commits. Paging by sync_sequence skipped
 * T1's row forever. Each test here holds real transactions open across real
 * pulls through the public sync readers.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in DB_TEST_INCLUDE). Every row uses a per-run id prefix and is
 * removed in afterAll, so the shared test database stays usable by concurrent
 * worktrees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';
import { SYNC_FEED_POSITION_BASE } from './syncFeed.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasSchema: false, hasCatalogSchema: false }));
    if (recheck.hasSchema && recheck.hasCatalogSchema) dbReady = true;
    else skipReason = 'memory/catalog schema not present';
  }
}
const runDb = requireDbOrSkip('lib/db/schema/syncFeed.db.test', dbReady, skipReason);

const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TAG_PREFIX = `cat-tag-feedtest-${nonce}`;
const memoryIds = [];

const insertMemory = async (client, content) => {
  const id = randomUUID();
  memoryIds.push(id);
  const { rows: [row] } = await client.query(
    `INSERT INTO memories (id, type, content) VALUES ($1, 'fact', $2) RETURNING id, sync_sequence::text AS seq`,
    [id, content],
  );
  return row;
};

const insertTag = async (client, suffix) => {
  const { rows: [row] } = await client.query(
    `INSERT INTO catalog_tags (id, label) VALUES ($1, $2) RETURNING id, sync_sequence::text AS seq`,
    [`${TAG_PREFIX}-${suffix}`, `Feed test ${suffix}`],
  );
  return row;
};

// Run `write` inside a transaction that stays OPEN until commit() is called.
// `written` resolves once the write has executed (its sync_sequence is drawn),
// or rejects if the write fails, so a broken fixture fails instead of hanging.
function holdOpen(write) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalWritten;
  const writtenSignal = new Promise((resolve) => { signalWritten = resolve; });
  const done = withTransaction(async (client) => {
    const out = await write(client);
    signalWritten(out);
    await gate;
    return out;
  });
  return { written: Promise.race([writtenSignal, done]), commit: () => { release(); return done; } };
}

// Drain a reader from `cursor` to the end of its feed, returning every item
// and the final cursor, the way syncOrchestrator pages a peer.
async function drain(read, cursor) {
  const items = [];
  let next = cursor;
  let more = true;
  while (more) {
    const page = await read(next);
    items.push(...page.items);
    if (page.items.length === 0) break;
    next = page.items[page.items.length - 1].syncSequence;
    more = page.hasMore;
  }
  return { items, cursor: next };
}

describe.skipIf(!runDb)('commit-ordered sync feed (#8315)', () => {
  let memorySync;
  let catalogDB;
  let backfillSyncFeed;
  const readMemories = (since) => memorySync.getChangesSince(since, 1000)
    .then(({ memories, hasMore }) => ({ items: memories, hasMore }));
  const readTags = (since) => catalogDB.getTagChangesSince(since, 1000);

  beforeAll(async () => {
    memorySync = await import('../../../services/memorySync.js');
    catalogDB = await import('../../../services/catalogDB.js');
    ({ up: backfillSyncFeed } = await import('../../../scripts/db-migrations/009-commit-ordered-sync-feed.js'));
  });

  afterAll(async () => {
    if (memoryIds.length) await query('DELETE FROM memories WHERE id = ANY($1::uuid[])', [memoryIds]).catch(() => {});
    await query('DELETE FROM catalog_tags WHERE id LIKE $1', [`${TAG_PREFIX}%`]).catch(() => {});
    await close();
  });

  it('still delivers a memory whose transaction commits after a peer advanced past a later one', async () => {
    const start = await memorySync.getMaxSequence();
    const t1 = holdOpen((client) => insertMemory(client, 'late committer'));
    const late = await t1.written;
    const early = await withTransaction((client) => insertMemory(client, 'early committer'));
    // The legacy hazard: the late row holds the LOWER write-time sequence, so a
    // `sync_sequence > cursor` pull that already saw the early row skips it.
    expect(BigInt(late.seq)).toBeLessThan(BigInt(early.seq));

    const firstPull = await drain(readMemories, start);
    expect(firstPull.items.map((m) => m.id)).toContain(early.id);
    expect(firstPull.items.map((m) => m.id)).not.toContain(late.id);

    await t1.commit();
    const secondPull = await drain(readMemories, firstPull.cursor);
    expect(secondPull.items.map((m) => m.id)).toContain(late.id);
  });

  it('still delivers a catalog row whose transaction commits after a peer advanced past a later one', async () => {
    const { tags: start } = await catalogDB.getMaxSequences();
    const t1 = holdOpen((client) => insertTag(client, 'late'));
    const late = await t1.written;
    const early = await withTransaction((client) => insertTag(client, 'early'));
    expect(BigInt(late.seq)).toBeLessThan(BigInt(early.seq));

    const firstPull = await drain(readTags, start);
    expect(firstPull.items.map((t) => t.id)).toEqual([early.id]);

    await t1.commit();
    const secondPull = await drain(readTags, firstPull.cursor);
    expect(secondPull.items.map((t) => t.id)).toEqual([late.id]);
  });

  it('orders feed positions by commit, not by write, under concurrent writers', async () => {
    const writers = ['a', 'b', 'c', 'd', 'e'].map((suffix) => holdOpen((client) => insertTag(client, `concurrent-${suffix}`)));
    const rows = await Promise.all(writers.map((w) => w.written));
    // Commit in an order unrelated to write order (write order is a..e).
    const commitOrder = [3, 0, 4, 1, 2];
    for (const i of commitOrder) await writers[i].commit();

    const { rows: feed } = await query(
      `SELECT t.id FROM sync_feed f JOIN catalog_tags t ON t.sync_sequence = f.row_sequence
       WHERE f.stream = 'catalog_tags' AND t.id = ANY($1::text[]) ORDER BY f.position`,
      [rows.map((r) => r.id)],
    );
    expect(feed.map((r) => r.id)).toEqual(commitOrder.map((i) => rows[i].id));
  });

  it('keeps one feed entry per live row version', async () => {
    const row = await withTransaction((client) => insertMemory(client, 'versioned'));
    const positionsFor = async (seq) => (await query(
      `SELECT position::text AS position FROM sync_feed WHERE stream = 'memories' AND row_sequence = $1`,
      [seq],
    )).rows.map((r) => r.position);
    const currentSeq = async () => (await query('SELECT sync_sequence::text AS seq FROM memories WHERE id = $1', [row.id])).rows[0].seq;
    const [created] = await positionsFor(row.seq);
    expect(created).toBeDefined();

    // An access-stat update does not move sync_sequence, so the feed is untouched.
    await query('UPDATE memories SET access_count = access_count + 1 WHERE id = $1', [row.id]);
    expect(await currentSeq()).toBe(row.seq);
    expect(await positionsFor(row.seq)).toEqual([created]);

    // A content edit re-queues the row at a later position and retires the old entry.
    await query(`UPDATE memories SET content = 'versioned, edited' WHERE id = $1`, [row.id]);
    const editedSeq = await currentSeq();
    expect(await positionsFor(row.seq)).toEqual([]);
    const [edited] = await positionsFor(editedSeq);
    expect(BigInt(edited)).toBeGreaterThan(BigInt(created));

    await query('DELETE FROM memories WHERE id = $1', [row.id]);
    expect(await positionsFor(editedSeq)).toEqual([]);
  });

  it('upgrade backfill replays rows below a legacy cursor without duplicating applied rows', async () => {
    // An install upgrading into the feed: rows that predate it carry no feed
    // entry, and a peer holds a legacy cursor at the newest row's sync_sequence
    // — past the row its old pulls skipped.
    const legacyRows = [];
    for (const label of ['legacy one', 'legacy skipped', 'legacy three']) {
      legacyRows.push(await withTransaction((client) => insertMemory(client, label)));
    }
    const ids = legacyRows.map((r) => r.id);
    await query(
      `DELETE FROM sync_feed WHERE stream = 'memories'
       AND row_sequence IN (SELECT sync_sequence FROM memories WHERE id = ANY($1::uuid[]))`,
      [ids],
    );
    const legacyCursor = legacyRows.at(-1).seq;
    expect(BigInt(legacyCursor)).toBeLessThan(BigInt(SYNC_FEED_POSITION_BASE));

    // Before the backfill those rows are invisible to the feed at any cursor.
    expect((await drain(readMemories, '0')).items.map((m) => m.id)).not.toContain(ids[1]);

    // A restored pre-feed dump can leave feed entries that match no row; and a
    // peer may already hold a POSITION cursor at the current feed maximum.
    const STALE_SEQUENCE = '-8315';
    await query(
      `INSERT INTO sync_feed (stream, row_sequence, position) VALUES ('memories', $1, nextval('memories_sync_feed_seq'))
       ON CONFLICT (stream, row_sequence) DO NOTHING`,
      [STALE_SEQUENCE],
    );
    const positionCursor = await memorySync.getMaxSequence();

    await withTransaction((client) => backfillSyncFeed(client));

    const { rows: stale } = await query(
      `SELECT 1 FROM sync_feed WHERE stream = 'memories' AND row_sequence = $1`,
      [STALE_SEQUENCE],
    );
    expect(stale).toEqual([]);
    // Every row is queued past cursors peers already hold, legacy or position.
    const pastPositionCursor = (await drain(readMemories, positionCursor)).items.map((m) => m.id);
    expect(pastPositionCursor).toEqual(expect.arrayContaining(ids));

    // The peer's legacy cursor now replays every row, including the skipped one…
    const replay = await drain(readMemories, legacyCursor);
    const replayed = replay.items.filter((m) => ids.includes(m.id));
    expect(replayed.map((m) => m.id).sort()).toEqual([...ids].sort());
    expect(BigInt(replay.cursor)).toBeGreaterThanOrEqual(BigInt(SYNC_FEED_POSITION_BASE));

    // …and re-applying the replay where the rows already exist is a pure LWW skip.
    const applied = await memorySync.applyRemoteChanges(replayed);
    expect(applied).toEqual({ inserted: 0, updated: 0, skipped: ids.length });
    const { rows: [{ count }] } = await query('SELECT COUNT(*)::int AS count FROM memories WHERE id = ANY($1::uuid[])', [ids]);
    expect(count).toBe(ids.length);
  });
});
