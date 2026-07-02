/**
 * Seed the `pipeline-pov-rewrite` + `pipeline-pov-analysis` stages into existing
 * installs (#1290 — "Rewrite a story in another character's POV + analyze").
 *
 * Mirrors `093-reverse-outline-stage.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges the matching stage-config entry
 * into `data/prompts/stage-config.json`. Boot runs migrations (server/index.js)
 * but NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new POV stages unseeded and
 * `buildPrompt('pipeline-pov-rewrite')` would throw "Stage not found" the first
 * time a user runs a perspective rewrite.
 *
 * Two stages ship together (rewrite + analysis). Each stage-config entry — and
 * its per-stage `returnsJson` flag — is copied verbatim from the shipped sample
 * by `makeSeedMigrations`; the migration never inspects or branches on it, so the
 * shared multi-stage helper is fully equivalent to the prior hand-rolled loop.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-pov-rewrite',
  'pipeline-pov-analysis',
]);
