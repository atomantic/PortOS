import { describe } from 'vitest';

import migration from './140-editorial-pacing-escalation-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 140 — seed editorial-pacing-escalation-curve stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-pacing-escalation-curve'], prefix: 'migration-140-' });
});
