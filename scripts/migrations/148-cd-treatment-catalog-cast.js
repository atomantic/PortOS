/**
 * Backfill the catalog-cast surfacing in cd-treatment.md for pre-existing
 * installs (#1808).
 *
 * The Creative Director treatment template gained a `## Cast & ingredients`
 * block (rendered from the project's `cast` array, seeded via the Catalog
 * "Remix into → Creative Director" handoff) plus an optional per-scene `cast`
 * field in the JSON output contract. `setup-data.js` only copies prompt files
 * that don't yet exist in `data/`, so installs created before this change never
 * received the new blocks — the cast-threading regression tests in
 * `creativeDirectorPrompts.test.js` fail until the local copy catches up.
 *
 * This migration surgically inserts the two missing pieces ONLY when the
 * surrounding anchor text matches the pre-update content exactly — so a user
 * who has hand-edited the template won't have their work clobbered. If anchors
 * don't match, it logs a notice and exits cleanly; the user can hand-merge from
 * data.reference/ or accept the cast tests staying red on their machine.
 *
 * Idempotent — re-runs are a no-op once `{{#hasCast}}` is present.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const TEMPLATE_REL_PATH = 'data/prompts/stages/cd-treatment.md';

// Insertion 1: the `## Cast & ingredients` section, dropped between the style
// spec block and the user-story branch. The anchor pair brackets the insertion
// point; the last `{{/project.styleSpec}}` (the one followed by a blank line +
// the user-story section) is what makes the pair unique on that line.
const ANCHOR_STYLE_END = '{{/project.styleSpec}}\n\n';
const ANCHOR_USER_STORY = '{{#project.userStory}}';
const CAST_SECTION =
  '{{#hasCast}}\n' +
  '## Cast & ingredients\n' +
  '\n' +
  'The user seeded this project with the following catalog ingredients (characters, places, objects, scenes). Treat them as canon — feature them, keep them visually consistent across scenes, and don\'t contradict their descriptions. For any scene that features specific members, list them in that scene\'s optional `cast` array (by `ingredientId` + `name` + `role`) so the render stays on-model.\n' +
  '\n' +
  '{{#project.cast}}\n' +
  '- **{{name}}** ({{type}} · {{role}}, id `{{ingredientId}}`){{#summary}}: {{summary}}{{/summary}}\n' +
  '{{/project.cast}}\n' +
  '{{/hasCast}}\n' +
  '\n';

// Insertion 2: the optional per-scene `cast` field in the JSON output contract.
// Anchor the scene-1 example's imageStrength line + the object close; append a
// gated `cast` array after `imageStrength`.
const SCENE_OLD = '      "imageStrength": null\n    },';
const SCENE_NEW =
  '      "imageStrength": null{{#hasCast}},\n' +
  '      "cast": [{ "ingredientId": "<id from the Cast list above>", "name": "<member name>", "role": "<cast|location|prop>" }]{{/hasCast}}\n' +
  '    },';

export default {
  async up({ rootDir }) {
    const templatePath = join(rootDir, TEMPLATE_REL_PATH);
    const original = await readFile(templatePath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (original == null) {
      console.log(`📄 ${TEMPLATE_REL_PATH} not present — skipping (fresh install will copy from data.reference)`);
      return;
    }

    let next = original;
    let changed = false;

    // Insertion 1: the Cast section.
    if (!next.includes('{{#hasCast}}')) {
      const anchorPair = ANCHOR_STYLE_END + ANCHOR_USER_STORY;
      if (next.includes(anchorPair)) {
        next = next.replace(anchorPair, ANCHOR_STYLE_END + CAST_SECTION + ANCHOR_USER_STORY);
        changed = true;
      } else {
        console.log(`⚠️ ${TEMPLATE_REL_PATH}: style-spec/user-story anchors don't match the pre-update template — skipping the Cast block insertion. Hand-merge from data.reference/ if needed.`);
      }
    }

    // Insertion 2: the per-scene cast JSON field.
    if (!next.includes('"cast": [{ "ingredientId"')) {
      if (next.includes(SCENE_OLD)) {
        next = next.replace(SCENE_OLD, SCENE_NEW);
        changed = true;
      } else {
        console.log(`⚠️ ${TEMPLATE_REL_PATH}: scene JSON example anchor doesn't match the pre-update template — skipping the per-scene cast insertion. Hand-merge from data.reference/ if needed.`);
      }
    }

    if (changed) {
      await writeFile(templatePath, next);
      console.log(`📝 ${TEMPLATE_REL_PATH}: backfilled catalog-cast surfacing (#1808)`);
    } else {
      console.log(`✅ ${TEMPLATE_REL_PATH}: already up-to-date, no changes needed`);
    }
  },
};
