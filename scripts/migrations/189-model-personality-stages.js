/**
 * Seed the model-personality stage prompts into existing installs (#2610).
 *
 * The LLM personality self-profile test (Digital Twin → Personality tab) needs
 * two new stage templates: the blind introspective self-evaluation and the
 * twin-alignment scorer. Boot runs migrations (server/index.js) but NOT
 * `setup-data.js`, so an upgrade that pulls + `pm2 restart`s would otherwise
 * leave the stages unseeded and POST /api/model-personality/run would throw
 * "Stage not found". Copies the `.md` templates from
 * `data.reference/prompts/stages/` and merges the stage-config entries when
 * absent (never clobbering a customized file/entry).
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'model-personality-profile',
  'model-personality-alignment-scorer'
]);
