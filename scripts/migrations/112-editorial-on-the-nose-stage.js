/**
 * Seed the `pipeline-editorial-on-the-nose` stage into existing installs (#1307).
 *
 * Mirrors `110-editorial-telling-emotion-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new on-the-nose stage unseeded
 * and the `dialogue.on-the-nose` editorial check would throw "Stage not found"
 * the first time it runs. The deterministic dialogue siblings
 * (dialogue.said-bookisms, dialogue.attribution-clarity) need no stage.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-on-the-nose');
