/**
 * Seed the `catalog-ideas-scenes-concepts` prompt stage into existing installs.
 *
 * Mirrors 043-story-builder-prompts.js — copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js)
 * BEFORE the AI toolkit reads stage-config.json, but does NOT run
 * `setup-data.js`. Without this migration, an upgrade that pulls main and
 * `pm2 restart`s (rather than running `update.sh`) leaves the new stage
 * unregistered — catalog ingest's light pass would throw "Stage
 * catalog-ideas-scenes-concepts not found" while the three bible passes
 * succeed, leaving the Ingest UI with a red failed row and no idea / scene /
 * concept candidates to review.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('catalog-ideas-scenes-concepts');
