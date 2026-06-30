/**
 * Seed the `pipeline-editorial-appearance-continuity` stage into existing installs (#1467).
 *
 * Mirrors `117-editorial-eyeline-match-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new appearance-continuity stage
 * unseeded and the `visual.appearance-continuity` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-appearance-continuity');
