/**
 * Seed the `pipeline-editorial-head-hopping` stage into existing installs (#1311).
 *
 * Mirrors `110-editorial-telling-emotion-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new head-hopping stage unseeded
 * and the `pov.head-hopping` editorial check would throw "Stage not found" the
 * first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-head-hopping');
