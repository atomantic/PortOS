/** Upgrade app audit overrides in place. Task schedules fold on read under the schedule write queue. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { foldAppAuditOverrides } from '../../server/lib/auditScheduleCompatibility.js';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'apps.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    const data = JSON.parse(raw);
    const changed = Object.values(data.apps || {}).map(foldAppAuditOverrides).some(Boolean);
    if (changed) await writeJsonAtomic(path, data);
  },
};
