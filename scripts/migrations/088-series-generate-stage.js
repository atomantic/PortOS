/**
 * Seed the `pipeline-series-generate` stage into existing installs.
 *
 * Mirrors `087-manuscript-reformat-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new "Generate with AI" series
 * stage unseeded and `buildPrompt('pipeline-series-generate')` would throw
 * "Stage not found" the first time a user clicks Generate with AI.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-series-generate');
