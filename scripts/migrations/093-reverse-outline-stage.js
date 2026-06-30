/**
 * Seed the `pipeline-reverse-outline` stage into existing installs (#1286).
 *
 * Mirrors `092-editorial-info-dumping-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new Reverse Outline stage
 * unseeded and `buildPrompt('pipeline-reverse-outline')` would throw "Stage not
 * found" the first time a user generates a reverse outline.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-reverse-outline');
