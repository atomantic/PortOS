/**
 * Seed the `manuscript-reformat` stage into existing installs.
 *
 * Mirrors `041-editorial-analysis-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new manuscript "Reformat (AI)"
 * stage unseeded and `buildPrompt('manuscript-reformat')` would throw "Stage
 * not found" the first time a user clicks Reformat (AI).
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('manuscript-reformat');
