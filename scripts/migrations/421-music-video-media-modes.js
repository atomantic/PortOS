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
    // Postgres rows are pinned by db-migration 015, which runs under the DB runner.
    return { success: true };
  },
};
