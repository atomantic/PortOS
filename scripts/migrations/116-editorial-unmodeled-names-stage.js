/**
 * Seed the `pipeline-editorial-unmodeled-names` stage into existing installs (#1412).
 *
 * Mirrors `115-editorial-theme-coherence-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new unmodeled-names stage
 * unseeded and the `roster.unmodeled-names` editorial check would throw "Stage
 * not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-unmodeled-names');
