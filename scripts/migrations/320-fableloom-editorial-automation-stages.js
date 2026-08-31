/** Seed the FableLoom editorial remediation and playthrough-review stages. */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'fableloom-editorial-remediate',
  'fableloom-review-playthroughs',
]);
