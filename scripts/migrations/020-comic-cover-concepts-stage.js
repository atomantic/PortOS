/**
 * Seed the `pipeline-comic-cover-concepts` stage into existing installs.
 *
 * Mirrors `017-volume-cover-concepts-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry
 * into `data/prompts/stage-config.json` so upgrades that skip re-running
 * `setup-data.js` still get the new per-issue cover-concept LLM step.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-comic-cover-concepts');
