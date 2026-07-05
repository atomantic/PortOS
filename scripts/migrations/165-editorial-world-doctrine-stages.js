/**
 * Seed the worldbuilding-doctrine editorial stages into existing installs (#2175):
 *   - pipeline-editorial-world-unforeshadowed-solution
 *   - pipeline-editorial-world-cost-free-power
 *
 * Mirrors the multi-stage seed precedent (091/094/095/107): copies each `.md`
 * template from `data.reference/prompts/stages/` when missing and merges its
 * stage-config entry when absent, in a single migration slot. Boot runs migrations
 * (server/index.js) but NOT `setup-data.js`, so an upgrade that pulls + `pm2
 * restart`s (rather than running `update.sh`) would otherwise leave these stages
 * unseeded and the `world.unforeshadowed-solution` / `world.cost-free-power`
 * editorial checks would throw "Stage not found" the first time they run.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-editorial-world-unforeshadowed-solution',
  'pipeline-editorial-world-cost-free-power',
]);
