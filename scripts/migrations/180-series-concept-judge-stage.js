/**
 * Seed the `pipeline-series-concept-judge` stage into existing installs
 * (CWQE Phase 15, #2180).
 *
 * The forced-pick ranker that autonomous multi-concept series ideation uses to
 * judge-pick the winning concept. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than running
 * `update.sh`) would otherwise leave this new stage unseeded and
 * `judgePickConcept` would fail to resolve the stage — falling back to the first
 * candidate every time instead of actually judging. Copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry when
 * absent (never clobbering a customized file/entry).
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-series-concept-judge');
