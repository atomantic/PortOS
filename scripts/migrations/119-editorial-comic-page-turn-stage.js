/**
 * Seed the `pipeline-editorial-comic-page-turn` stage into existing installs (#1314).
 *
 * Mirrors `113-editorial-voice-distinctiveness-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than running
 * `update.sh`) would otherwise leave the new comic-page-turn stage unseeded and the
 * `comic.page-turn-beats` editorial check would throw "Stage not found" the first
 * time it runs.
 *
 * First-shipment seed (no MD5 bookkeeping). Any FUTURE edit to this `.md` MUST add
 * an `ACCEPTED_OLD_MD5`/`NEW_SHIPPED_MD5` pair (migration 003 pattern) so
 * `setup-data.js#buildPromptDriftTables` can auto-upgrade other installs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-comic-page-turn');
