/**
 * Seed the `pipeline-editorial-world-unforeshadowed-solution` stage into existing
 * installs (#2175).
 *
 * Mirrors `130-editorial-character-consistency-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than running
 * `update.sh`) would otherwise leave the new stage unseeded and the
 * `world.unforeshadowed-solution` editorial check would throw "Stage not found" the
 * first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-world-unforeshadowed-solution');
