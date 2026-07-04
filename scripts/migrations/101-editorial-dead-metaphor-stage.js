/**
 * Seed the `pipeline-editorial-dead-metaphor` stage into existing installs (#1308).
 *
 * Mirrors `099-editorial-interiority-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new dead-metaphor stage unseeded
 * and the `prose.dead-metaphor` editorial check would throw "Stage not found" the
 * first time it runs. (The deterministic siblings need no stage.)
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-dead-metaphor');
