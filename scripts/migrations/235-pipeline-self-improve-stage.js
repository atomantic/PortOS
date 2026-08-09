/**
 * Seed the Series Autopilot self-improvement diagnosis stage into existing installs.
 *
 * Mirrors `230-editorial-interiority-register-stage.js`: copies the `.md`
 * template from `data.reference/prompts/stages/` and merges its stage-config
 * entry into `data/prompts/stage-config.json`. Boot runs migrations
 * (server/index.js) but NOT `setup-data.js`, so an upgrade that pulls +
 * `pm2 restart`s (rather than running `update.sh`) would otherwise leave the
 * stage unseeded — and an autopilot run with self-improvement enabled would
 * throw "Stage not found" the first time it reached its post-mortem.
 *
 * Customization-safe + idempotent per `_seedStageHelpers.js` — the template is
 * copied only when missing and the config entry merged only when absent.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-self-improve');
