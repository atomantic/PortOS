/**
 * Backfill the commit-ordered federation change feed (#8315).
 *
 * Rows that predate `sync_feed` have no position and readers only serve rows that do, so this
 * (re)queues EVERY row of every federated stream in legacy `sync_sequence` order and drops
 * entries matching no row (a restored pre-feed dump can leave feed rows pointing at a reused
 * `sync_sequence`). Every position is above SYNC_FEED_POSITION_BASE, so a peer's next pull
 * replays each stream once, which recovers rows the old cursors skipped (apply is LWW / ON
 * CONFLICT, so held rows are not duplicated).
 *
 * The feed's advisory lock is taken in its own statement FIRST so later statements see snapshots
 * after any in-flight feed commit and no live commit draws a position before this transaction
 * commits. Derived from the install's own rows, so no seed.
 */

import { SYNC_FEED_LOCK_KEY, syncFeedTables, syncFeedSequenceName } from '../../lib/db/schema/syncFeed.js';

export async function up(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_FEED_LOCK_KEY]);
  let total = 0;
  for (const table of syncFeedTables) {
    await client.query(
      `DELETE FROM sync_feed f
       WHERE f.stream = $1
         AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.sync_sequence = f.row_sequence)`,
      [table],
    );
    const { rowCount } = await client.query(
      `INSERT INTO sync_feed (stream, row_sequence, position)
       SELECT $1, legacy.sync_sequence, nextval($2::regclass)
       FROM (SELECT sync_sequence FROM ${table} ORDER BY sync_sequence) legacy
       ON CONFLICT (stream, row_sequence) DO UPDATE SET position = EXCLUDED.position`,
      [table, syncFeedSequenceName(table)],
    );
    total += rowCount ?? 0;
  }
  console.log(`🔁 Sync feed: queued ${total} row${total === 1 ? '' : 's'} across ${syncFeedTables.length} streams`);
}
