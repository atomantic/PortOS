/**
 * Backfill durable ids on `stages.storyboards.scenes[]` (and each scene's `shots[]`) for
 * pipeline issues already in Postgres (#3413), so id resolution is live before each issue's
 * next save (writes resolve BY id, not array index).
 *
 * The stamp comes from the SAME `ensureStoryboardIds` the sanitizer uses and is deterministic
 * (`scene-01`, `shot-02`, collisions escaped with `-2`) so federated peers converge instead of
 * churning conflicts. `updated_at` is NOT bumped: this is a derived normalization and bumping
 * the LWW clock would out-race real remote edits. Idempotent; tombstoned issues are included.
 */

import { toPgJson } from '../../lib/pgJson.js';
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
      [toPgJson(stamped), row.id],
    );
    touched += 1;
  }
  console.log(`🎬 storyboard scene ids: stamped ${touched} of ${rows.length} issue${rows.length === 1 ? '' : 's'} with storyboard scenes`);
}
