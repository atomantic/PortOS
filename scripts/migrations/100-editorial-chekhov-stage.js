/**
 * Seed the `pipeline-editorial-chekhov` stage into existing installs (#1299).
 *
 * Mirrors `099-editorial-interiority-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new Chekhov-setup/payoff stage
 * unseeded and the `chekhov.setups-payoffs` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-chekhov');
