/** Add opt-in aliases to existing config without reading any private records. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, safeJSONParse } from '../../server/lib/fileUtils.js';
import { migrateEidoverseWorldState } from '../../server/lib/eidoverseWorldDesign.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'eidoverse', 'portos-world.json');
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0, reason: 'no-state' };
    const state = safeJSONParse(raw, null, { logError: false });
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { updated: 0, reason: 'invalid-json' };
    }
    const migration = migrateEidoverseWorldState(state);
    if (!migration.compatible) return { updated: 0, reason: migration.report.reason };
    if (JSON.stringify(state) === JSON.stringify(migration.state)) return { updated: 0, reason: 'already-applied' };
    await atomicWrite(path, migration.state);
    return { updated: 1 };
  },
};
