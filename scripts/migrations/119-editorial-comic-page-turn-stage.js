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
 * First-shipment seed (no MD5 bookkeeping). A later edit to this `.md` needs no migration:
 * `node scripts/regen-shipped-prompt-hashes.js` retires the old hash and the
 * runner's reconcile step upgrades untouched installs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-comic-page-turn');
