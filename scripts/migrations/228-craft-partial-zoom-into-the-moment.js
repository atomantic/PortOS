/**
 * Ship the "Zoom into the moment" construction section into the
 * `craft-anti-patterns` prompt PARTIAL (#3594).
 *
 * The partial is injected into BOTH drafting stages (`pipeline-prose.md` and
 * `writers-room-continue.md`) and until now was entirely negative — 11 "avoid X"
 * rules plus the Stability Trap countermeasures. One of those rules carries a
 * measurable target with no technique attached ("at least 70% in-scene, not
 * summary"), so a drafter told to dramatize more defaults to longer description.
 * The new section gives it the recipe: location, actions, thoughts, emotions,
 * dialogue.
 *
 * Why a migration: `scripts/setup-data.js` copies only *missing* prompt files,
 * and migration `183-seed-craft-anti-patterns-partial.js` copies the partial only
 * when absent (never clobbering a hand-edited one). So every existing install
 * already has the pre-change partial on disk and would never receive this edit.
 *
 * Customization-safe: only installs whose copy still hashes to the shipped
 * pre-change body are auto-updated; a hand-edited partial is left intact and
 * warned about (and surfaces in setup-data.js's drift warning via the
 * `ACCEPTED_OLD_MD5` / `NEW_SHIPPED_MD5` / `DRIFT_SUBDIRS` sweep). Idempotent.
 *
 * `DRIFT_SUBDIRS` is what routes this file to `prompts/_partials/` rather than
 * the default `prompts/stages/` — for the drift sweep AND for the replace pass
 * itself, which takes the same table via `subdirs`.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (the partial as seeded by migration 183 / #2172).
export const ACCEPTED_OLD_MD5 = {
  'craft-anti-patterns.md': ['bd0149bf1a5c721e65e053dad8e536d3'],
};

// Post-change shipped hash ("Zoom into the moment" section added).
export const NEW_SHIPPED_MD5 = {
  'craft-anti-patterns.md': 'f34e75f19ac4e41aa0533a0abcb38a2a',
};

// This file is a prompt fragment, not a stage prompt.
export const DRIFT_SUBDIRS = {
  'craft-anti-patterns.md': '_partials',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  subdirs: DRIFT_SUBDIRS,
  label: 'craft "Zoom into the moment" section',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/_partials/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/_partials/${filename}\n` +
    `   and add the "Zoom into the moment" section (the five construction\n` +
    `   elements: location, actions, thoughts, emotions, dialogue).`,
  skipFooter: (count) =>
    `⚠️  ${count} craft-anti-patterns partial(s) could not be auto-updated because\n` +
    `   they were customized. Drafting still works, but the prose and\n` +
    `   Writers-Room-continue stages will keep asking for 70% in-scene prose\n` +
    `   without teaching how to build a scene, until you merge the "Zoom into\n` +
    `   the moment" section from data.reference/prompts/_partials/craft-anti-patterns.md.`,
});

export { applyMigration };
export default { up };
