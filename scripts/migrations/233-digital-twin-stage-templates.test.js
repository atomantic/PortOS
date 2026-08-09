import { describe } from 'vitest';

import migration from './233-digital-twin-stage-templates.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The ten Digital Twin stages that shipped a config entry with no template
// (#3644). The drift catch is the point: if any of these reference templates or
// their stage-config entries ever stops shipping, the matching soul/twin AI pass
// silently reverts to its `.catch(() => null)` fallback with nothing failing here
// first — which is exactly how they went unnoticed in the first place.
describe('migration 233 — seed the Digital Twin stage templates', () => {
  runSeedStageMigrationTests({
    migration,
    // Restated by hand on purpose — the helper's first case compares this list
    // against `migration.stages`, which is vacuous if it is derived from it.
    stages: [
      'soul-contradiction-detector',
      'soul-enrichment',
      'soul-enrichment-process',
      'soul-test-generator',
      'soul-test-scorer',
      'soul-writing-analyzer',
      'twin-confidence-analyzer',
      'twin-import-analyzer',
      'twin-interview-analyze',
      'twin-trait-extractor',
    ],
    prefix: 'migration-233-',
  });
});
