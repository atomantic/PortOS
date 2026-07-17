import { describe } from 'vitest';

import migration from './182-seed-cwqe-quality-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The six Creative Writing Quality Engine judge/revision stages (v2.27.0).
describe('migration 182 — seed CWQE quality stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: [
      'pipeline-judge-issue',
      'pipeline-judge-foundation',
      'pipeline-judge-compare',
      'pipeline-editorial-adversarial-cuts',
      'writers-room-cuts',
      'writers-room-revise',
    ],
    prefix: 'migration-182-',
  });
});
