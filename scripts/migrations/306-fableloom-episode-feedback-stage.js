/**
 * Seed the FableLoom episode-feedback stage into existing installs.
 *
 * Boot runs migrations (`server/index.js`) but not `setup-data.js`, so an
 * upgraded install needs the new template and stage-config entry before the
 * episode feedback action can run. The shared seed helper copies only missing
 * files and merges only missing config entries, preserving local edits.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('fableloom-feedback-episode');
