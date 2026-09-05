import { describe } from 'vitest';
import migration from './351-fableloom-timed-shots.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';
describe('timed shot stages', () => { runSeedStageMigrationTests({ migration, stages: ['fableloom-plan-shots', 'fableloom-review-shots'], prefix: 'migration-351-' }); });
