/**
 * Seed the two scene-grounding editorial-check stages into existing installs
 * (#1309).
 *
 * Mirrors `094-object-attachment-check-stages.js`: seeds BOTH new stages in one
 * pass — copies each `.md` template from `data.reference/prompts/stages/` and
 * merges its stage-config entry into `data/prompts/stage-config.json`. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that pulls
 * + `pm2 restart`s (rather than running `update.sh`) would otherwise leave these
 * stages unseeded and the `sensory.balance` / `scene.white-room` editorial checks
 * would throw "Stage not found" the first time they run.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-editorial-sensory-balance',
  'pipeline-editorial-white-room',
]);
