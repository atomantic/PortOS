/**
 * Seed the `pipeline-editorial-comic-prose-sync` stage into existing installs (#1589).
 *
 * Mirrors `134-editorial-voice-consistency-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than running
 * `update.sh`) would otherwise leave the new comic-prose-sync stage unseeded and the
 * `comic.prose-sync` editorial check would throw "Stage not found" the first time it
 * runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-comic-prose-sync');
