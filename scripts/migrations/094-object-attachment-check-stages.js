/**
 * Seed the two object-attachment editorial-check stages into existing installs
 * (#1288).
 *
 * Mirrors `092-editorial-info-dumping-stage.js`, but seeds BOTH new stages in
 * one pass: copies each `.md` template from `data.reference/prompts/stages/`
 * and merges its stage-config entry into `data/prompts/stage-config.json`. Boot
 * runs migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that
 * pulls + `pm2 restart`s (rather than running `update.sh`) would otherwise leave
 * these stages unseeded and the `objects.unmotivated-interaction` /
 * `objects.backstory-consistency` editorial checks would throw "Stage not found"
 * the first time they run.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-editorial-object-motivation',
  'pipeline-editorial-object-backstory',
]);
