/**
 * Seed the `pipeline-comic-page-refine-render` stage into existing installs.
 *
 * Mirrors `091-seed-image-prompt-stages.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`.
 *
 * Why this exists: the prompt ships in `data.reference/` and is wired to the
 * comic-page "Refine" action (`refineComicPageRender` in
 * `server/services/pipeline/visualStages.js`, issue #1534). Boot runs migrations
 * (server/index.js) but NOT `setup-data.js`, so an install that upgrades by
 * pulling + `pm2 restart` (rather than running `update.sh`) would never receive
 * it — `buildPrompt('pipeline-comic-page-refine-render')` then throws "Stage not
 * found" the first time the user clicks "Refine".
 *
 * First-shipment seed: copy only when the file is missing (never clobber a
 * customized install) and merge the stage-config key only when absent. No MD5
 * hashing — there is no prior shipped-via-migration baseline to upgrade from.
 * NOTE: a FUTURE edit to the `.md` must add `ACCEPTED_OLD_MD5` / `NEW_SHIPPED_MD5`
 * exports (see migration 003) so `setup-data.js`'s `buildPromptDriftTables`
 * sweep can auto-update other installs.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-comic-page-refine-render');
