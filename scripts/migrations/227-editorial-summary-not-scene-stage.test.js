import { describe } from 'vitest';

import migration from './227-editorial-summary-not-scene-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The summary-vs-scene editorial check's stage (#3591). The drift catch is the
// point: if the reference template or its stage-config entry ever stops
// shipping, the `narration.summary-not-scene` check would throw "Stage not
// found" at runtime on a fresh install with nothing failing here first.
describe('migration 227 — seed the summary-not-scene editorial stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-editorial-summary-not-scene'],
    prefix: 'migration-227-',
  });
});
