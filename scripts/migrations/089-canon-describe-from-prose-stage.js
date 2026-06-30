/**
 * Seed the `pipeline-canon-describe-from-prose` stage into existing installs.
 *
 * Mirrors `088-series-generate-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new "Describe from prose"
 * Nouns-stage action unseeded and `buildPrompt('pipeline-canon-describe-from-prose')`
 * would throw "Stage not found" the first time a user clicks it.
 *
 * FIRST-SHIPMENT SEED ONLY — no MD5 hashing: it copies the template only when
 * missing and never overwrites an install's existing prompt. A FUTURE migration
 * that AMENDS this prompt must follow migration 003's hash-driven pattern
 * (normalize line endings, ship OLD + NEW shipped hashes) instead.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-canon-describe-from-prose');
