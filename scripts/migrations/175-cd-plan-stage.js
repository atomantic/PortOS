/**
 * Seed the `cd-plan` prompt stage into existing installs (#2184, CDO Phase 2 —
 * production plans).
 *
 * Mirrors 174-series-voice-discover-stage.js — copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) BEFORE
 * the AI toolkit reads stage-config.json, but does NOT run `setup-data.js`.
 * Without this migration, an upgrade that pulls main and `pm2 restart`s (rather
 * than running `update.sh`) leaves the new stage unregistered — the planner agent
 * (`enqueuePlanTask`) would throw "Stage cd-plan not found" the first time a
 * directive-driven project starts.
 *
 * Customization-safe + idempotent: the template is copied only when missing and
 * the config entry merged only when absent.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('cd-plan');
