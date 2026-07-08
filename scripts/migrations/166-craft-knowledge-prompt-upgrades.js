/**
 * CWQE Phase 8 — craft-knowledge prompt upgrades (#2172).
 *
 * Three shipped stage templates gained craft-corpus content:
 *
 *   - `pipeline-prose.md` + `writers-room-continue.md` now inject the new shared
 *     `{{> craft-anti-patterns }}` partial (24-rule anti-pattern list + Stability
 *     Trap countermeasures). The partial file itself is NEW, so setup-data.js
 *     copies it into existing installs' `data/prompts/_partials/` on the next
 *     boot (missing-file → copy) — no migration needed for the partial. But the
 *     two stage files ALREADY exist on existing installs, so setup-data.js's
 *     copy-missing pass never rewrites them: this migration adds the `{{>` line.
 *
 *   - `pipeline-arc-overview.md` now emits a `foreshadowing` ledger
 *     (plant → reinforce → payoff, plant-to-payoff distance ≥ 3 issues) persisted
 *     onto `series.arc.foreshadowing` and consumed by the `chekhov.setups-payoffs`
 *     editorial check.
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old templates until this migration rewrites them.
 * `writers-room-continue.md` is migration-tracked for the FIRST time here.
 * `pipeline-prose.md` and `pipeline-arc-overview.md` already have migration
 * lineages (003/027/054/127 and 005/019 respectively) — per the drift-cross-sync
 * convention, those earlier migrations were resynced in this same change: their
 * previous current hash moved into `ACCEPTED_OLD_MD5` and `NEW_SHIPPED_MD5` was
 * bumped to the post-166 hash so their drift-catch tests stay in lock-step with
 * the live sample. The drift baseline in `setup-data-drift.test.js` was updated
 * to match the merged sweep.
 *
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hashes (the current shipped bodies before #2172).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-prose.md': ['25e3d58c2741bd98acd5d08ba70d8a5e', '430d38ed2da59e0d4212e65edc499a74'],
  'writers-room-continue.md': [
    '93bfe80543ceca39842201a78b8393fa',
    '67663696c97ebaeb23de25f7410cfdd4', // post-166 / pre-181 (voice exemplars)
  ],
  'pipeline-arc-overview.md': [
    '0a1f6ffa6908522e3690c5e9e53a6ee0',
    '612f8b04950e2ff26dd350dd76a062fe', // post-166 / pre-173 (MICE thread nesting)
  ],
};

// Post-change shipped hashes (partial injected / foreshadowing ledger added).
// pipeline-prose.md's current hash is resynced to post-169 (cross-issue
// continuity, #2177) per the drift-cross-sync convention.
export const NEW_SHIPPED_MD5 = {
  'pipeline-prose.md': '4cb3ef48309f3673570cf80e4d544b54',
  'writers-room-continue.md': '458dc5ff4732befc1fb90890bdc885c2', // post-181 (voice exemplars)
  'pipeline-arc-overview.md': '74d6c26548660d85fc345b2099c63b6c', // post-173 (MICE thread nesting)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'craft-knowledge prompt upgrades',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    (filename === 'pipeline-arc-overview.md'
      ? `   and add the "Foreshadowing ledger" instruction + the "foreshadowing"\n` +
        `   output-contract array (plant → reinforce → payoff, distance ≥ 3 issues).`
      : `   and add the "{{> craft-anti-patterns }}" partial reference.`),
  skipFooter: (count) =>
    `⚠️  ${count} craft-knowledge prompt(s) could not be auto-updated because\n` +
    `   they were customized. Generation still works, but those prompts will\n` +
    `   miss the anti-pattern rules / Stability Trap countermeasures (prose,\n` +
    `   writers-room) or the foreshadowing ledger (arc overview) until you\n` +
    `   merge them from data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
