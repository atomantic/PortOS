import { describe } from 'vitest';

import migration from './129-editorial-timeline-contradiction-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 129 — seed editorial-timeline-contradiction stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-timeline-contradiction'], prefix: 'migration-129-' });
});
