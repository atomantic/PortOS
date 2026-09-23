/** Retire public AA/SWE score rows and offer GPT-6 Sol/Luna on Codex providers. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../server/lib/fileCore.js';
import { modelComparisonCatalogSchema } from '../../server/lib/validation.js';
import { makeAdditiveProviderInsertMigration } from './_lib.js';

const offerGpt6Models = makeAdditiveProviderInsertMigration({
  label: 'GPT-6 Sol/Luna',
  targets: ['codex', 'codex-tui'].flatMap(id => [
    { id, retired: 'gpt-5.6-luna', current: 'gpt-6-sol' },
    { id, retired: 'gpt-6-sol', current: 'gpt-6-luna' },
  ]),
});

const isRetiredScore = row => /^(?:Artificial Analysis Intelligence Index|SWE-bench\b)/i.test(row?.benchmark || '')
  || /^(?:aa-v\d|swebench-)/i.test(row?.id || '');

export default {
  async up({ rootDir }) {
    const providerResult = await offerGpt6Models.up({ rootDir });
    const catalogPath = join(rootDir, 'data', 'model-comparison.json');
    const raw = await readFile(catalogPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { providerResult, removed: 0 };

    const catalog = modelComparisonCatalogSchema.parse(JSON.parse(raw));
    const observations = catalog.observations.filter(row => !isRetiredScore(row));
    const removed = catalog.observations.length - observations.length;
    if (removed) {
      const result = modelComparisonCatalogSchema.parse({ ...catalog, observations });
      await atomicWrite(catalogPath, result);
    }
    return { providerResult, removed };
  },
};
