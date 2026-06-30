/**
 * Seed the `pipeline-script-verify` stage into existing installs.
 *
 * Mirrors `088-series-generate-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new comic-script verify stage
 * unseeded and Series Autopilot's `verifyComicScript` would throw
 * "Stage not found" the first time the script gate runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-script-verify');
