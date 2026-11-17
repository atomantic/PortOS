/**
 * CWQE Phase 14: Writers Room voice exemplars (#2179 parity slice).
 *
 * `writers-room-continue.md` gained a conditional "Voice (the tuning fork)" block (`{{#voiceGuide}} … {{voiceGuide}} … {{/voiceGuide}}`) injecting a work's voice exemplar / anti-exemplar passages into the live-continuation prompt, as the series style guide already does for prose/revision prompts; absent exemplars render nothing, so works without a configured voice carry no per-call overhead.
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing installs keep the old template until this rewrites it. Per the drift-cross-sync convention migration 166 (the template's earlier lineage, 065 seed) is resynced in this change: its previous current hash (`67663696…`) moved into its `ACCEPTED_OLD_MD5` and its `NEW_SHIPPED_MD5` bumped to the post-181 hash, and the drift baseline in `setup-data-drift.test.js` was updated to match.
 * Customization-safe: only copies hashing to the prior shipped version are auto-updated; customized prompts are left intact and warned about. Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (the current shipped body before #2179 — post-166).
export const ACCEPTED_OLD_MD5 = {
  'writers-room-continue.md': ['67663696c97ebaeb23de25f7410cfdd4'],
};

// Post-change shipped hash (voice-guide block added).
export const NEW_SHIPPED_MD5 = {
  'writers-room-continue.md': '458dc5ff4732befc1fb90890bdc885c2',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'writers-room voice exemplars',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "Voice (the tuning fork)" block (the\n` +
    `   {{#voiceGuide}} / {{voiceGuide}} / {{/voiceGuide}} section).`,
  skipFooter: (count) =>
    `⚠️  ${count} live-continuation prompt(s) could not be auto-updated because\n` +
    `   they were customized. Live suggestions still work, but they will miss\n` +
    `   the work's voice exemplars (the tuning fork) until you merge the\n` +
    `   {{#voiceGuide}} block from data.reference/prompts/stages/writers-room-continue.md.`,
});

export { applyMigration };
export default { up };
