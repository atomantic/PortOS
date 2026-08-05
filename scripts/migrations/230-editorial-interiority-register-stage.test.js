import { describe } from 'vitest';

import migration from './230-editorial-interiority-register-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The interiority-register editorial check's stage (#3593). The drift catch is
// the point: if the reference template or its stage-config entry ever stops
// shipping, the `interiority.register` check would throw "Stage not found" at
// runtime on a fresh install with nothing failing here first.
describe('migration 230 — seed the interiority-register editorial stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-editorial-interiority-register'],
    prefix: 'migration-230-',
  });
});
