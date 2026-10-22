import { describe } from 'vitest';

import migration from './150-seed-comic-page-refine-render-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 100 — seed comic-page refine-render stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-comic-page-refine-render'], prefix: 'migration-150-' });
});
