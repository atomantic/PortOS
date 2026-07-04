/**
 * Seed the interiority-balance editorial-check stage into existing installs
 * (#1623).
 *
 * Mirrors `107-editorial-sensory-grounding-stages.js` (single stage instead of
 * two): copies the `.md` template from `data.reference/prompts/stages/` and
 * merges its stage-config entry into `data/prompts/stage-config.json`. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that pulls
 * + `pm2 restart`s (rather than running `update.sh`) would otherwise leave the
 * stage unseeded and the `scene.interiority-balance` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-interiority-balance');
