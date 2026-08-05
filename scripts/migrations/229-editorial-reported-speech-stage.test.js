import { describe } from 'vitest';

import migration from './229-editorial-reported-speech-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The reported-speech editorial check's stage (#3592). The drift catch is the
// point: if the reference template or its stage-config entry ever stops
// shipping, the `dialogue.reported-speech` check would throw "Stage not found"
// at runtime on a fresh install with nothing failing here first.
describe('migration 229 — seed the reported-speech editorial stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-editorial-reported-speech'],
    prefix: 'migration-229-',
  });
});
