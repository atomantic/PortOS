import { describe } from 'vitest';

import migration from './094-object-attachment-check-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The two object-attachment editorial-check stages (#1288) backing the
// `objects.unmotivated-interaction` / `objects.backstory-consistency` checks.
describe('migration 094 — seed object-attachment check stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-editorial-object-motivation', 'pipeline-editorial-object-backstory'],
    prefix: 'migration-094-',
  });
});
