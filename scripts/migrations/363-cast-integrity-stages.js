/**
 * Seed the cast-integrity review + character-augment stages into existing
 * installs (#6415).
 *
 * Boot runs migrations (`server/index.js`) but not `setup-data.js`, so an
 * install that upgrades by pulling and restarting would otherwise reach the new
 * Review Cast / Augment buttons with no template and no stage-config entry, and
 * `runStagedLLM` would throw "Stage not found" on the first click.
 *
 * The shared seed helper copies only missing files and merges only missing
 * config entries, so a user who has already customized either template keeps
 * their version.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'universe-cast-integrity-review',
  'universe-character-augment',
]);
