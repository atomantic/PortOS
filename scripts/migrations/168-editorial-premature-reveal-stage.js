/**
 * Seed the premature-reveal editorial-check stage into existing installs
 * (#2178 — CWQE Phase 13).
 *
 * Mirrors `143-editorial-object-weight-proportionality-stage.js`: copies the
 * `.md` template from `data.reference/prompts/stages/` and merges its
 * stage-config entry into `data/prompts/stage-config.json`. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that
 * pulls + `pm2 restart`s (rather than running `update.sh`) would otherwise
 * leave the stage unseeded and the `continuity.premature-reveal` editorial
 * check would throw "Stage not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-premature-reveal');
