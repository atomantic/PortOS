/**
 * Seed the `pipeline-editorial-telling-emotion` stage into existing installs (#1306).
 *
 * Mirrors `109-editorial-arc-transitions-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new telling-emotion stage
 * unseeded and the `prose.telling-emotion` editorial check would throw
 * "Stage not found" the first time it runs. The deterministic copy-edit siblings
 * (prose.filter-words, prose.crutch-words, prose.adverbs, prose.passive-voice,
 * prose.repeated-gestures, prose.word-echoes, prose.sentence-rhythm) need no stage.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-telling-emotion');
