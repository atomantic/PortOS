/**
 * 029 — re-key live-synced Spotify plays to whole-second dedupe keys (#15309).
 *
 * Live sync used to key on the Web API's millisecond `played_at`, while the history
 * export only has whole seconds, so imported and live copies of one play never
 * collided. Live keys are now floored to the second; this collapses the pairs that
 * already exist. The imported row wins (richer metadata): a live row whose floored
 * key is already taken is deleted, otherwise it is re-keyed. Idempotent — only keys
 * with non-zero milliseconds match.
 */
const LIVE_MS_KEY = '^spotify:(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})\\.(?!000Z)\\d{3}Z:(.+)$';
const FLOORED = "regexp_replace(dedupe_key, $1, 'spotify:\\1.000Z:\\2')";

export async function up(client) {
  // Drop live rows whose floored key already exists (imported play, or an earlier
  // live row of the same second — keep the lowest id so re-keying can't collide).
  const del = await client.query(
    `DELETE FROM human_activity_events l
      WHERE l.source = 'spotify' AND l.dedupe_key ~ $1
        AND EXISTS (
          SELECT 1 FROM human_activity_events k
           WHERE k.source = 'spotify' AND k.id <> l.id
             AND (k.dedupe_key = ${FLOORED.replace('dedupe_key', 'l.dedupe_key')}
                  OR (k.dedupe_key ~ $1 AND k.id < l.id
                      AND ${FLOORED.replace('dedupe_key', 'k.dedupe_key')} = ${FLOORED.replace('dedupe_key', 'l.dedupe_key')})))`,
    [LIVE_MS_KEY],
  );
  const upd = await client.query(
    `UPDATE human_activity_events SET dedupe_key = ${FLOORED}
      WHERE source = 'spotify' AND dedupe_key ~ $1`,
    [LIVE_MS_KEY],
  );
  if (del.rowCount + upd.rowCount > 0) {
    console.log(`🗓️  Migration 029: collapsed ${del.rowCount} duplicate and re-keyed ${upd.rowCount} live Spotify play(s)`);
  }
}
