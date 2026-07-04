/**
 * Seed the `pipeline-volume-cover-concepts` stage into existing installs.
 *
 * Commit d802eb18 ("feat(pipeline): issue back covers + volume covers +
 * trade-paperback PDF") shipped the per-season cover-concept LLM step
 * (`arcPlanner.generateVolumeCoverConcepts` → `runStagedLLM('pipeline-volume-cover-concepts', …)`)
 * and added `data.reference/prompts/stages/pipeline-volume-cover-concepts.md`
 * but forgot two things existing installs need:
 *
 *   1. A `stage-config.json` entry — `setup-data.js` only merges
 *      `JSON_MERGE_TARGETS` on fresh setup, so existing installs that
 *      upgrade-and-restart never get the new entry and `prompts.getStage()`
 *      throws "Stage pipeline-volume-cover-concepts not found".
 *   2. The `.md` template — `ensureSampleContent` copies *missing* prompt
 *      files on next run so a fresh install gets it, but an upgrade that
 *      skips re-running setup-data leaves it absent.
 *
 * This migration fixes both for existing installs. Modeled on the same
 * idempotent pattern as `015-importer-stage-prompts.js`.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-volume-cover-concepts');
