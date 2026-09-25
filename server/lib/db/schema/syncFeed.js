// Commit-ordered federation change feed (#8315).
//
// Every federated PostgreSQL stream (memories + the seven catalog tables) used
// to hand peers its `sync_sequence` BIGSERIAL as the pull cursor. A sequence
// value is allocated when a row is WRITTEN, not when its transaction COMMITS,
// so a transaction that took 100 and committed after one that took 101 was
// invisible to a pull that already advanced the peer's cursor to 101 — and
// every later `> 101` pull skipped it for good.
//
// The feed fixes that without touching the row tables' write paths. Each row
// change queues a DEFERRED constraint trigger; at commit the trigger takes one
// transaction-scoped advisory lock (held until the transaction ends) and only
// then draws the stream's feed position. Two committers therefore draw their
// positions one after the other, and whoever holds the lower position has
// already committed by the time a higher one exists — so a reader that sees
// position N can never later discover a committed position below N. The lock
// is held only for the commit instant, and a lock holder touches nothing but
// `sync_feed`, so it cannot close a deadlock cycle with row locks.
//
// `sync_feed` holds one row per live row version: (stream = table name,
// row_sequence = that row's current `sync_sequence`) → position. An update that
// moves `sync_sequence` replaces the entry; a delete removes it. Readers join
// the feed to the table on `sync_sequence` and page by `position`.
//
// Positions start at SYNC_FEED_POSITION_BASE, far above any legacy
// `sync_sequence` an install could have allocated. That keeps the wire shape
// (one numeric-string cursor per stream) while making an old cursor
// self-identifying: a peer holding a legacy cursor pulls `position > legacy`,
// which is the whole feed, so the upgrade replays every row once and recovers
// anything the old cursors skipped. Apply paths are LWW / ON CONFLICT upserts,
// so the replay rewrites nothing a peer already holds. The reverse (a peer
// that downgrades) is caught by the existing reset detection: a saved cursor
// above the peer's reported maximum rewinds to 0.
//
// The db-migration `009-commit-ordered-sync-feed.js` backfills rows that
// predate the feed. Mirrored in server/scripts/init-db.sql (parity-locked by
// db.ddlParity.test.js).

export const SYNC_FEED_POSITION_BASE = '1000000000000000';

// Transaction-scoped advisory lock key that serializes feed position draws
// with commit. Distinct from SCHEMA_DDL_ADVISORY_LOCK_KEY (5977001) in db.js.
export const SYNC_FEED_LOCK_KEY = 8315001;

// Every table whose rows federate through a `sync_sequence` pull cursor. The
// feed stream name IS the table name.
export const syncFeedTables = [
  'memories',
  'catalog_scraps',
  'catalog_ingredients',
  'catalog_ingredient_sources',
  'catalog_ingredient_refs',
  'catalog_ingredient_relations',
  'catalog_tags',
  'catalog_ingredient_media',
];

export const syncFeedSequenceName = (table) => `${table}_sync_feed_seq`;

export const syncFeedDdl = [
  `CREATE TABLE IF NOT EXISTS sync_feed (
      stream TEXT NOT NULL,
      row_sequence BIGINT NOT NULL,
      position BIGINT NOT NULL,
      PRIMARY KEY (stream, row_sequence)
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_feed_position ON sync_feed (stream, position)`,
  ...syncFeedTables.map((t) =>
    `CREATE SEQUENCE IF NOT EXISTS ${syncFeedSequenceName(t)} START WITH ${SYNC_FEED_POSITION_BASE} MINVALUE ${SYNC_FEED_POSITION_BASE}`),
  `CREATE OR REPLACE FUNCTION sync_feed_capture()
     RETURNS TRIGGER AS $$
     BEGIN
       PERFORM pg_advisory_xact_lock(${SYNC_FEED_LOCK_KEY});
       IF TG_OP <> 'INSERT' THEN
         DELETE FROM sync_feed WHERE stream = TG_TABLE_NAME AND row_sequence = OLD.sync_sequence;
       END IF;
       IF TG_OP <> 'DELETE' THEN
         INSERT INTO sync_feed (stream, row_sequence, position)
         VALUES (TG_TABLE_NAME, NEW.sync_sequence, nextval(format('%I', TG_TABLE_NAME || '_sync_feed_seq')::regclass))
         ON CONFLICT (stream, row_sequence) DO UPDATE SET position = EXCLUDED.position;
       END IF;
       RETURN NULL;
     END;
     $$ LANGUAGE plpgsql`,
];

// Two deferred constraint triggers per table: INSERT/DELETE unconditionally,
// UPDATE only when the row's `sync_sequence` moved (the BEFORE UPDATE triggers
// skip the bump for access-stat and no-op writes, and so does the feed).
// Constraint triggers have no CREATE OR REPLACE, hence DROP + CREATE.
export function buildSyncFeedTriggers() {
  const stmts = [];
  for (const t of syncFeedTables) {
    stmts.push(`DROP TRIGGER IF EXISTS trg_${t}_sync_feed ON ${t}`);
    stmts.push(
      `CREATE CONSTRAINT TRIGGER trg_${t}_sync_feed AFTER INSERT OR DELETE ON ${t} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_feed_capture()`,
    );
    stmts.push(`DROP TRIGGER IF EXISTS trg_${t}_sync_feed_update ON ${t}`);
    stmts.push(
      `CREATE CONSTRAINT TRIGGER trg_${t}_sync_feed_update AFTER UPDATE ON ${t} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.sync_sequence IS DISTINCT FROM NEW.sync_sequence) EXECUTE FUNCTION sync_feed_capture()`,
    );
  }
  return stmts;
}
