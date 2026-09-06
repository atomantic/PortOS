/** Add shipped Zen evidence without replacing an install's researched observations. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileCore.js';
import { modelComparisonImportSchema } from '../../server/lib/validation.js';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/model-comparison.json');
    const raw = await readFile(path, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (raw === null) return { added: 0 };
    const current = modelComparisonImportSchema.parse(JSON.parse(raw));
    const seed = modelComparisonImportSchema.parse(JSON.parse(await readFile(join(rootDir, 'data.reference/model-comparison.json'), 'utf8')));
    const ids = new Set(current.observations.map(row => row.id));
    const additions = seed.observations.filter(row => row.id.startsWith('zen-free-2026-09-') && !ids.has(row.id));
    if (!additions.length) return { added: 0 };
    const result = modelComparisonImportSchema.parse({ ...current, observations: [...current.observations, ...additions] });
    await atomicWrite(path, result);
    return { added: additions.length };
  },
};
