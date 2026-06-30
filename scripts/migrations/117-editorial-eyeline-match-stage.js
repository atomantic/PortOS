/**
 * Seed the `pipeline-editorial-eyeline-match` stage into existing installs (#1466).
 *
 * Mirrors `116-editorial-unmodeled-names-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new eyeline-match stage unseeded
 * and the `visual.eyeline-match` editorial check would throw "Stage not found"
 * the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-eyeline-match');
