/** Offer GPT-6 Sol/Luna; retain public evidence now used by the PortOS composite. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelComparisonCatalogSchema } from '../../server/lib/validation.js';
import { makeAdditiveProviderInsertMigration } from './_lib.js';

const offerGpt6Models = makeAdditiveProviderInsertMigration({
  label: 'GPT-6 Sol/Luna',
  targets: ['codex', 'codex-tui'].flatMap(id => [
    { id, retired: 'gpt-5.6-luna', current: 'gpt-6-sol' },
    { id, retired: 'gpt-6-sol', current: 'gpt-6-luna' },
  ]),
});

export default {
  async up({ rootDir }) {
    const providerResult = await offerGpt6Models.up({ rootDir });
    const catalogPath = join(rootDir, 'data', 'model-comparison.json');
    const raw = await readFile(catalogPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { providerResult, removed: 0 };

    // Earlier releases removed AA/SWE rows here. That retirement is superseded:
    // upgrades crossing this migration must preserve researched public evidence.
    // Already-migrated installs recover shipped evidence through the read merge.
    modelComparisonCatalogSchema.parse(JSON.parse(raw));
    return { providerResult, removed: 0 };
  },
};
