/**
 * Seed the four reader-panel persona stages into existing installs (#2170 —
 * CWQE Phase 6, "reader panel personas + disagreement mining").
 *
 * Mirrors `095-pov-rewrite-stages.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges the matching stage-config entry
 * into `data/prompts/stage-config.json`. Boot runs migrations (server/index.js)
 * but NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new persona stages unseeded and
 * convening the reader panel would throw "Stage not found" on the first run.
 *
 * Four persona stages ship together (Editor / Genre Reader / Writer / First
 * Reader). Each stage-config entry — and its `returnsJson` flag — is copied
 * verbatim from the shipped sample by `makeSeedMigrations`; the migration never
 * inspects or branches on it, so the shared multi-stage helper is equivalent to a
 * hand-rolled per-stage loop.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-panel-editor',
  'pipeline-panel-genre-reader',
  'pipeline-panel-writer',
  'pipeline-panel-first-reader',
]);
