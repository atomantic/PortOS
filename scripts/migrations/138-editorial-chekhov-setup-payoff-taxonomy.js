/**
 * Refine the `chekhov.setups-payoffs` editorial check into a four-way taxonomy
 * (#1595).
 *
 * The original Chekhov stage prompt detected only two failure modes — "fired,
 * never planted" and "planted, never fired". This rewrite classifies every
 * setup↔payoff thread as paired / false-setup / orphaned-payoff / **distant**,
 * adding the previously-missing distant-payoff case: an element that IS both
 * planted and paid off, but whose payoff lands so many issues after the setup
 * (the configurable `distantGap`) that the reader may no longer recall the plant.
 * The `{{#distantGap}}` section renders only when the check's distant-payoff gap
 * is enabled (>= 1), so an install that sets it to 0 keeps the false-setup /
 * orphaned-payoff behavior unchanged.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old Chekhov template until this migration rewrites it. Migration 100
 * seeds the file but never tracks its hash, so this is the first hash-driven
 * update for it — no earlier migration's MD5 tables need resyncing.
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the original #1299 Chekhov body (seeded by migration
// 100), which flagged only fired-never-planted / planted-never-fired.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-chekhov.md': ['bfacbf343ba2b9a3f6037bb45b94e1bb'],
};

// Post-change shipped hash (paired / false-setup / orphaned-payoff / distant
// taxonomy + the distantGap-gated distant-payoff rule). Migration 100 is a seed
// that tracks no hash, so there are no earlier MD5 tables to mirror into.
export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-chekhov.md': '1f8a1696b5e4f476051dc5b2e5737db9',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'editorial chekhov setup/payoff taxonomy',
  customizedHint: (filename) =>
    `   To refine it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the four-way classification (paired / false-setup /\n` +
    `   orphaned-payoff / distant) plus the {{#distantGap}} distant-payoff rule.`,
  skipFooter: (count) =>
    `⚠️  ${count} Chekhov prompt(s) could not be auto-updated because they were\n` +
    `   customized. The check still runs, but will keep flagging only false setups\n` +
    `   and orphaned payoffs — it will not surface distant payoffs (a setup paid\n` +
    `   off so many issues later the reader may have forgotten it).\n` +
    `   See data.reference/prompts/stages/pipeline-editorial-chekhov.md.`,
});

export { applyMigration };
export default { up };
