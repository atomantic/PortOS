/**
 * Seed the `pipeline-editorial-character-consistency` stage into existing installs (#1582).
 *
 * Mirrors `129-editorial-timeline-contradiction-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new character-consistency stage
 * unseeded and the `character.consistency` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-character-consistency');
