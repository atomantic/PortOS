/**
 * Seed the `pipeline-comic-panel-image-prompt` and
 * `pipeline-storyboard-image-prompt` stages into existing installs.
 *
 * Mirrors `090-script-verify-stage.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`.
 *
 * Why this exists: both prompts ship in `data.reference/` and are wired to the
 * comic-panel / storyboard "AI: refine" buttons (`refineComicPanelPrompt` /
 * `refineStoryboardScenePrompt` in `server/services/pipeline/visualStages.js`),
 * but they were added before this migration without a seed step. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an install that
 * upgrades by pulling + `pm2 restart` (rather than running `update.sh`) never
 * received them — `buildPrompt('pipeline-comic-panel-image-prompt')` then throws
 * "Stage not found" the first time the user clicks "AI: refine".
 *
 * First-shipment seed: copy only when the file is missing (never clobber a
 * customized install) and merge each stage-config key only when absent. No MD5
 * hashing — there is no prior shipped-via-migration baseline to upgrade from.
 * NOTE: a FUTURE edit to either `.md` must add `ACCEPTED_OLD_MD5` /
 * `NEW_SHIPPED_MD5` exports (see migration 003) so `setup-data.js`'s
 * `buildPromptDriftTables` sweep can auto-update other installs.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-comic-panel-image-prompt',
  'pipeline-storyboard-image-prompt',
]);
