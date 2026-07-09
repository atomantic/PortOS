/**
 * Seed the `pipeline-series-voice-discover` prompt stage into existing installs
 * (#2179, CWQE Phase 14 — voice discovery).
 *
 * Mirrors 048-catalog-ideas-scenes-concepts-stage.js — copies the `.md`
 * template from `data.reference/prompts/stages/` and merges the stage-config
 * entry into `data/prompts/stage-config.json`. Boot runs migrations
 * (server/index.js) BEFORE the AI toolkit reads stage-config.json, but does NOT
 * run `setup-data.js`. Without this migration, an upgrade that pulls main and
 * `pm2 restart`s (rather than running `update.sh`) leaves the new stage
 * unregistered — the "Discover voice" action would throw "Stage
 * pipeline-series-voice-discover not found" the first time the user clicks it.
 *
 * Customization-safe + idempotent: the template is copied only when missing and
 * the config entry merged only when absent.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-series-voice-discover');
