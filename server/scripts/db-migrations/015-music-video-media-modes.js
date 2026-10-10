/**
 * Pin legacy Music Video intent in Postgres (#10941). Moved out of file
 * migration 421, which opened its own pool and aborted the whole file-migration
 * run when PostgreSQL was offline. Idempotent: rows that already carry
 * `mediaMode` are untouched.
 */
import { migrateMediaMode } from '../../../scripts/migrations/421-music-video-media-modes.js';

export async function up(client) {
  const table = await client.query("SELECT to_regclass('public.music_video_projects') AS name");
  if (!table.rows[0]?.name) return;
  const { rows } = await client.query("SELECT id, data FROM music_video_projects WHERE NOT data ? 'mediaMode'");
  for (const { id, data } of rows) {
    await client.query(`UPDATE music_video_projects SET data = jsonb_set(data, '{mediaMode}', to_jsonb($2::text))
      WHERE id = $1 AND NOT data ? 'mediaMode'`, [id, migrateMediaMode(data).mediaMode]);
  }
}
