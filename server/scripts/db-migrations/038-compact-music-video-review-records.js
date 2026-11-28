/**
 * Apply the write-time review slimming (#16210, #18706) once to stored Music
 * Video projects. That clean-up only runs when a record is next saved, so a
 * project that is no longer edited keeps a full copy of the board approval in
 * every shot lock, and every project list read parses those copies. Only
 * `productionReview` is rewritten; approvals, scenes and both update
 * timestamps stay as stored, so the record does not look edited to sync.
 */
import { slimProjectReview } from '../../services/musicVideo/productionReviewRecords.js';
import { toPgJson } from '../../lib/pgJson.js';

export async function up(client) {
  const table = await client.query("SELECT to_regclass('public.music_video_projects') AS name");
  if (!table.rows[0]?.name) return;
  const { rows } = await client.query("SELECT id FROM music_video_projects WHERE jsonb_typeof(data->'productionReview') = 'object' ORDER BY id");
  let compacted = 0;
  // One record at a time: a single review can be tens of megabytes.
  for (const { id } of rows) {
    const { rows: [stored] } = await client.query(
      `SELECT data->'productionReview' AS "productionReview" FROM music_video_projects WHERE id = $1 FOR UPDATE`, [id]);
    if (!stored) continue;
    const slimmed = slimProjectReview(stored);
    if (slimmed === stored) continue;
    await client.query("UPDATE music_video_projects SET data = jsonb_set(data, '{productionReview}', $2::jsonb) WHERE id = $1",
      [id, toPgJson(slimmed.productionReview)]);
    compacted += 1;
  }
  if (compacted) console.log(`🎞️ Compacted the stored review records of ${compacted} Music Video project(s)`);
}
