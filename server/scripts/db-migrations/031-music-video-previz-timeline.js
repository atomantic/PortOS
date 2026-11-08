/**
 * Convert stored music video previz data to the timeline/vehicle shape (see
 * scripts/migrations/459-music-video-previz-timeline.js). Idempotent: rows already
 * in the new shape are left alone.
 */
import { migrateMusicVideoPreviz } from '../../../scripts/migrations/459-music-video-previz-timeline.js';

export async function up(client) {
  const table = await client.query("SELECT to_regclass('public.music_video_projects') AS name");
  if (!table.rows[0]?.name) return;
  const { rows } = await client.query("SELECT id, data FROM music_video_projects WHERE data->'previz' ? 'night' OR data->>'previz' LIKE '%\"bike\"%'");
  for (const { id, data } of rows) {
    const next = migrateMusicVideoPreviz(data);
    if (next === data) continue;
    await client.query('UPDATE music_video_projects SET data = jsonb_set(jsonb_set(data, \'{previz}\', $2::jsonb), \'{concept}\', $3::jsonb) WHERE id = $1',
      [id, JSON.stringify(next.previz), JSON.stringify(next.concept ?? data.concept ?? {})]);
  }
}
