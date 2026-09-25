/**
 * Backfill the commit-ordered federation change feed (#8315).
 *
 * ensureSchema() installs `sync_feed` and its deferred capture triggers, so
 * every row written from this boot on gets a feed position at commit. Rows
 * that predate the feed have none, and the readers only serve rows that do —
 * this (re)queues every row of every federated stream, in legacy
 * `sync_sequence` order, and drops entries that no longer match a row.
 *
 * Every row is queued, not just the ones without an entry: an install that
 * restores a pre-feed database dump keeps the feed rows written since the
 * upgrade, and those can point at a `sync_sequence` the restored table reuses
 * for a different row. Re-queueing everything above the current positions
 * costs nothing extra — the first pull after the upgrade replays each stream
 * anyway — and guarantees no row sits below a cursor a peer already holds.
 *
 * Every position is above SYNC_FEED_POSITION_BASE, above any legacy cursor a
 * peer holds, so a peer's next pull replays the whole stream once. That replay
 * is the recovery for rows the old write-time cursors skipped; the apply side
 * is LWW / ON CONFLICT upserts, so rows a peer already holds are skipped rather
 * than duplicated.
 *
 * The feed's advisory lock is taken in its own statement FIRST, so the
 * statements below run on snapshots taken after any in-flight feed commit
 * finished, and no live commit can draw a position until this transaction's
 * positions are committed. Derived from the install's own rows — no seed.
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
