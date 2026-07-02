/**
 * Seed the `pipeline-editorial-opening-start` stage into existing installs (#1300).
 *
 * Mirrors `101-editorial-dead-metaphor-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new opening-start stage unseeded
 * and the `opening.wrong-start` editorial check would throw "Stage not found" the
 * first time it runs. (The deterministic sibling `prose.italic-thoughts` needs no
 * stage.)
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-opening-start');
