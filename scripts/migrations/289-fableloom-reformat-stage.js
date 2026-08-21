/**
 * Seed the FableLoom reformat stage into existing installs.
 *
 * Boot runs migrations (server/index.js) but NOT `setup-data.js`, so an
 * upgrade that pulls + `pm2 restart`s would leave the new stage unseeded and
 * "rewrite this story as a teleplay" would throw "Stage not found" the first
 * time it runs.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations(['fableloom-reformat-scenes']);
