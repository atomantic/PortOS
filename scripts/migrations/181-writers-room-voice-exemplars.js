/**
 * CWQE Phase 14 — Writers Room voice exemplars (#2179 parity slice).
 *
 * `writers-room-continue.md` gained a conditional "Voice (the tuning fork)"
 * block (`{{#voiceGuide}} … {{voiceGuide}} … {{/voiceGuide}}`) that injects a
 * work's voice exemplar / anti-exemplar passages into the live-continuation
 * prompt — the same "the tuning fork" anchoring the series style guide already
 * ships to prose/revision prompts. Absent exemplars render nothing (the section
 * is gated), so works without a configured voice carry no per-call overhead.
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old `writers-room-continue.md` until this migration
 * rewrites it. The template already has a migration lineage (065 seed / 166
 * craft-anti-patterns) — per the drift-cross-sync convention, migration 166 is
 * resynced in this same change: its previous current hash
 * (`67663696…`) moved into its `ACCEPTED_OLD_MD5` and its `NEW_SHIPPED_MD5`
 * bumped to the post-181 hash, so 166's "NEW matches live data.reference"
 * drift-catch test stays green. The drift baseline in `setup-data-drift.test.js`
 * was updated to match the merged sweep.
 *
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
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
