/**
 * Seed the `pipeline-editorial-secondary-arc` stage into existing installs (#1585).
 *
 * Mirrors `132-editorial-reaction-proportionality-stage.js`: copies the `.md`
 * template from `data.reference/prompts/stages/` and merges the stage-config entry
 * into `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new secondary-arc stage unseeded
 * and the `character.secondary-arc` editorial check would throw "Stage not found"
 * the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-secondary-arc');
