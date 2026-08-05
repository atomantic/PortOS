/**
 * Seed the summary-vs-scene editorial-check stage into existing installs (#3591).
 *
 * Mirrors `142-editorial-interiority-balance-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the stage unseeded and the
 * `narration.summary-not-scene` editorial check would throw "Stage not found"
 * the first time it runs.
 *
 * Customization-safe + idempotent per `_seedStageHelpers.js` — the template is
 * copied only when missing and the config entry merged only when absent.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-editorial-summary-not-scene');
