/** Pin legacy intent without deleting assets, changing tools or enabling providers. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { musicVideoMediaMode } from '../../server/lib/musicVideoMediaPolicy.js';
import { writeJsonAtomic } from './_lib.js';

export const migrateMediaMode = (record) => Object.hasOwn(record, 'mediaMode') ? record : { ...record, mediaMode: musicVideoMediaMode(record) };

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'music-video-projects.json');
    const raw = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (raw) {
      const records = JSON.parse(raw);
      if (!Array.isArray(records)) throw new Error('Music Video project file must contain an array');
      await writeJsonAtomic(file, records.map(migrateMediaMode));
    }
    const { query } = await import('../../server/lib/db.js');
    const table = await query("SELECT to_regclass('public.music_video_projects') AS name");
    if (table.rows[0]?.name) {
      const { rows } = await query("SELECT id, data FROM music_video_projects WHERE NOT data ? 'mediaMode'");
      for (const { id, data } of rows) {
        await query(`UPDATE music_video_projects SET data = jsonb_set(data, '{mediaMode}', to_jsonb($2::text))
          WHERE id = $1 AND NOT data ? 'mediaMode'`, [id, migrateMediaMode(data).mediaMode]);
      }
    }
    return { success: true };
  },
};
