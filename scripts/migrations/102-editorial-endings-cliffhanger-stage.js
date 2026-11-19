/**
 * Seed the `pipeline-editorial-endings-cliffhanger` stage into existing installs (#1298).
 *
 * Mirrors `100-editorial-chekhov-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new chapter-ending cliffhanger
 * stage unseeded and the `endings.cliffhanger` editorial check would throw
 * "Stage not found" the first time it runs.
 *
 * First-shipment seed (no MD5 bookkeeping). A later edit to this `.md` needs no migration:
 * `node scripts/regen-shipped-prompt-hashes.js` retires the old hash and the
 * runner's reconcile step upgrades untouched installs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-endings-cliffhanger');
