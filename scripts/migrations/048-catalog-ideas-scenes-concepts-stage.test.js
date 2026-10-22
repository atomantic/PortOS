import { describe } from 'vitest';

import migration from './048-catalog-ideas-scenes-concepts-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 048 — seed catalog ingest light-shape stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['catalog-ideas-scenes-concepts'], prefix: 'migration-048-' });
});
