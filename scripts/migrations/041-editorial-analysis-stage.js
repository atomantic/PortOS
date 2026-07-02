/**
 * Seed the `pipeline-editorial-analysis` stage into existing installs.
 *
 * Mirrors `020-comic-cover-concepts-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new Editorial Roadmap analysis
 * stage unseeded and `buildPrompt('pipeline-editorial-analysis')` would throw
 * "Stage not found" the first time a user runs the analysis.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-analysis');
