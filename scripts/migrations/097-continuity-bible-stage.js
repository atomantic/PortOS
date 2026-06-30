/**
 * Seed the `pipeline-continuity-bible` stage into existing installs (#1305).
 *
 * Mirrors `093-reverse-outline-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new Continuity Bible stage
 * unseeded and `buildPrompt('pipeline-continuity-bible')` would throw "Stage not
 * found" the first time a user generates a continuity bible.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-continuity-bible');
