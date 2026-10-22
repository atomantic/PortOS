import { describe } from 'vitest';

import migration from './136-editorial-comic-prose-sync-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 136 — seed editorial-comic-prose-sync stage', () => {
  runSeedStageMigrationTests({ migration, stages: ['pipeline-editorial-comic-prose-sync'], prefix: 'migration-136-' });
});
