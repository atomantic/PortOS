/**
 * Backfill durable ids on `stages.storyboards.scenes[]` (and each scene's
 * `shots[]`) for pipeline issues already in Postgres (#3413).
 *
 * Storyboard scenes were addressed purely by array index — the render enqueue,
 * the stage write, and the completion hook all agreed on `scenes[i]`, so a
 * reorder or delete between a caller's read and its write silently retargeted
 * the render onto whatever scene occupied that slot. `sanitizeVisualStage` now
 * stamps a durable `id` on write, and every write path resolves BY id; this
 * migration stamps the records that are already stored so id resolution is
 * live immediately instead of only after each issue's next save.
 *
 * The stamp comes from the SAME `ensureStoryboardIds` the sanitizer uses, and
 * it is deterministic (`scene-01`, `shot-02`, collision-escaped with `-2`).
 * That matters for federation: every peer runs this over its own copy of a
 * shared issue, and a random id would make each peer stamp something different
 * and churn conflicts forever. Deterministic ids converge.
 *
 * `updated_at` is deliberately NOT bumped — this is a derived normalization,
 * not a user edit, and advancing the LWW clock would make every issue look
 * freshly edited to peers and out-race real remote edits.
 *
 * Idempotent: a scene that already carries an `id` is left untouched, so a
 * re-run writes nothing. Tombstoned issues are included — they can be restored,
 * and a restored issue should not be the one record still addressed by index.
 */

import { ensureStoryboardIds } from '../../lib/storyboardScenes.js';

export async function up(client) {
  const { rows } = await client.query(
    `SELECT id, data FROM pipeline_issues
     WHERE jsonb_typeof(data->'stages'->'storyboards'->'scenes') = 'array'
       AND jsonb_array_length(data->'stages'->'storyboards'->'scenes') > 0`,
  );
  let touched = 0;
  for (const row of rows) {
    const scenes = row.data?.stages?.storyboards?.scenes;
    if (!Array.isArray(scenes)) continue;
    const stamped = ensureStoryboardIds(scenes);
    if (stamped === scenes) continue;
    await client.query(
      `UPDATE pipeline_issues
       SET data = jsonb_set(data, '{stages,storyboards,scenes}', $1::jsonb, false)
       WHERE id = $2`,
      [JSON.stringify(stamped), row.id],
    );
    touched += 1;
  }
  console.log(`🎬 storyboard scene ids: stamped ${touched} of ${rows.length} issue${rows.length === 1 ? '' : 's'} with storyboard scenes`);
}
