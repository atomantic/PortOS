/**
 * Backfill the `imageStrength` surfacing block in cd-evaluate.md for
 * pre-existing installs.
 *
 * The Creative Director evaluator template gained a two-line block in
 * `data.sample/prompts/stages/cd-evaluate.md` that surfaces the per-scene
 * `imageStrength` knob (and a sentence in the retry-branch instructions
 * documenting how to adjust it). `setup-data.js` only copies prompt files
 * that don't yet exist in `data/`, so installs created before that change
 * never received the new block. Three regression tests in
 * `creativeDirectorPrompts.test.js` fail until the local copy catches up.
 *
 * This migration surgically inserts the two missing pieces ONLY when the
 * surrounding anchor text matches the pre-update content exactly — so a
 * user who has hand-edited the template won't have their work clobbered.
 * If anchors don't match, the migration logs a notice and exits cleanly;
 * the user can either merge the change in by hand or accept that the
 * three CD-evaluator tests stay red on their machine.
 *
 * Idempotent — re-runs are a no-op once the block is present.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const TEMPLATE_REL_PATH = 'data/prompts/stages/cd-evaluate.md';

// Insertion 1: scene-context block. Anchors are the two existing lines that
// bracket the insertion point. Both must match verbatim or we skip.
const ANCHOR_BEFORE_BLOCK = '- Strategy: {{scene.strategy}}\n';
const ANCHOR_AFTER_BLOCK  = '- Retry count: {{scene.retryCount}} (max 3)\n';
const NEW_BLOCK_LINES =
  '{{#scene.hasImageStrength}}- Image strength: {{scene.imageStrength}} (0–1; higher = stick closer to source image){{/scene.hasImageStrength}}\n' +
  '{{^scene.hasImageStrength}}- Image strength: default (continuation: 0.85; otherwise renderer default){{/scene.hasImageStrength}}\n';

// Insertion 2: extend the retry-branch instructions with the imageStrength
// knob guidance. The pre-update sentence is the full anchor; replace it
// with the post-update sentence (which is a strict superset).
const RETRY_OLD = '**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation.';
const RETRY_NEW = '**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation. You may also adjust `imageStrength` (0.0–1.0) on i2v scenes — drop it (e.g. 0.85 → 0.6) when the seed image is dominating and the prompt isn\'t expressed; raise it (e.g. → 0.95) when continuation drifted too far from the prior scene. Omit `imageStrength` from the PATCH to leave it unchanged.';

export default {
  async up({ rootDir }) {
    const templatePath = join(rootDir, TEMPLATE_REL_PATH);
    const original = await readFile(templatePath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (original == null) {
      console.log(`📄 ${TEMPLATE_REL_PATH} not present — skipping (fresh install will copy from data.sample)`);
      return;
    }

    let next = original;
    let changed = false;

    // Insertion 1: scene-context imageStrength lines.
    const alreadyHasBlock = next.includes('{{#scene.hasImageStrength}}');
    if (!alreadyHasBlock) {
      const anchorPair = ANCHOR_BEFORE_BLOCK + ANCHOR_AFTER_BLOCK;
      if (next.includes(anchorPair)) {
        next = next.replace(anchorPair, ANCHOR_BEFORE_BLOCK + NEW_BLOCK_LINES + ANCHOR_AFTER_BLOCK);
        changed = true;
      } else {
        console.log(`⚠️ ${TEMPLATE_REL_PATH}: scene-context anchors don't match the pre-update template — skipping the imageStrength block insertion. Hand-merge from data.sample/ if needed.`);
      }
    }

    // Insertion 2: retry-branch sentence extension.
    const alreadyHasRetryGuidance = next.includes('adjust `imageStrength`');
    if (!alreadyHasRetryGuidance) {
      if (next.includes(RETRY_OLD)) {
        next = next.replace(RETRY_OLD, RETRY_NEW);
        changed = true;
      } else {
        console.log(`⚠️ ${TEMPLATE_REL_PATH}: retry-branch sentence doesn't match the pre-update template — skipping the imageStrength guidance extension. Hand-merge from data.sample/ if needed.`);
      }
    }

    if (changed) {
      await writeFile(templatePath, next);
      console.log(`📝 ${TEMPLATE_REL_PATH}: backfilled imageStrength surfacing`);
    } else {
      console.log(`✅ ${TEMPLATE_REL_PATH}: already up-to-date, no changes needed`);
    }
  },
};
