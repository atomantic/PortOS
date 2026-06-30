/**
 * Sub-classify `dialogue.on-the-nose` editorial findings (#1626).
 *
 * The original on-the-nose stage prompt flagged subtext-free dialogue but never
 * said *why* a line read on-the-nose — "on-the-nose" alone is too broad for a
 * writer to act on. This migration rewrites the stage prompt to classify each
 * finding into one of three subtypes — `exposition` (info-dump / maid-and-butler),
 * `emotion-tell` (a character naming their own feeling outright), and
 * `relationship-report` (a line describing a bond instead of dramatizing it) —
 * and to emit that label as a `subtype` field on every finding. The runner
 * validates the label against its allow-list and surfaces it in the finding's
 * triage/comment badge.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old on-the-nose template until this migration rewrites it. Migration
 * 112 seeds the file but never tracks its hash, so this is the first hash-driven
 * update for it — no earlier migration's MD5 tables need resyncing.
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the original #1307 on-the-nose body (seeded by
// migration 112).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-on-the-nose.md': ['48182b49149e6b5829fbed71b3ffc242'],
};

// Post-change shipped hash (subtype taxonomy + `subtype` output field). This
// file's only prior migration (112) is a seed that tracks no hash, so there are
// no earlier MD5 tables to mirror into.
export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-on-the-nose.md': 'e5786fb019e5bf19c7aa6ed0c8b35cda',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'editorial on-the-nose subtype',
  customizedHint: (filename) =>
    `   To classify findings manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "## Subtype" section plus the "subtype":\n` +
    `   "exposition|emotion-tell|relationship-report" field to the output contract.`,
  skipFooter: (count) =>
    `⚠️  ${count} on-the-nose prompt(s) could not be auto-updated because\n` +
    `   they were customized. The check still runs, but its findings will keep\n` +
    `   showing a flat "on-the-nose" label until you add the exposition /\n` +
    `   emotion-tell / relationship-report subtype classification.\n` +
    `   See data.reference/prompts/stages/pipeline-editorial-on-the-nose.md.`,
});

export { applyMigration };
export default { up };
