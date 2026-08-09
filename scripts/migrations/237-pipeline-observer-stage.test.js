import { describe } from 'vitest';

import migration from './237-pipeline-observer-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The autopilot observing-orchestrator stage. The drift catch is the point: if
// the reference template or its stage-config entry ever stops shipping, an
// observer-enabled run would throw "Stage not found" the first time a step's
// telemetry triggered a pass — with nothing failing here first.
describe('migration 237 — seed the pipeline observing-orchestrator stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-observer'],
    prefix: 'migration-237-',
  });
});
