import { describe } from 'vitest';
import migration from './403-catalog-extract-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('catalog graph extraction stage migration', () => {
  runSeedStageMigrationTests({ migration, stages: ['catalog-extract'], prefix: 'catalog-extract-stage-' });
});
