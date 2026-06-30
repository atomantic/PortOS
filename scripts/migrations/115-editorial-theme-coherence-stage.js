/**
 * Seed the `pipeline-editorial-theme-coherence` stage into existing installs (#1317).
 *
 * Mirrors `111-editorial-plot-structure-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new theme-coherence stage
 * unseeded and the `theme.coherence` editorial check would throw "Stage not
 * found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-theme-coherence');
