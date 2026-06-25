/**
 * Broaden the `prose.telling-emotion` editorial check beyond named emotions (#1590).
 *
 * The original telling-emotion stage prompt only flagged named-emotion
 * statements ("she was sad", "he felt nervous"). That misses the rest of the
 * show-vs-tell family: agency-removing constructions ("the story unfolded",
 * "tension filled the room"), reported-sensation filtering ("she saw the anger
 * in his face" vs "his jaw clenched"), and asserted/unearned knowledge
 * ("somehow she knew"). This migration rewrites the stage prompt to cover all
 * four, and adds a coordination note so the LLM defers purely mechanical filter
 * words to the deterministic `prose.filter-words` check rather than
 * double-flagging them.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old telling-emotion template until this migration rewrites it.
 * Migration 110 seeds the file but never tracks its hash, so this is the first
 * hash-driven update for it — no earlier migration's MD5 tables need resyncing.
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the original #1306 telling-emotion body (seeded by
// migration 110).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-telling-emotion.md': ['2c5c33709732fe7ffa319d32b8755354'],
};

// Post-change shipped hash (agency-removal + reported-sensation filtering +
// asserted-knowledge coverage). This file's only prior migration (110) is a
// seed that tracks no hash, so there are no earlier MD5 tables to mirror into.
export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-telling-emotion.md': '871f7e8bea2a2d95f28875ab45a318e2',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'editorial telling-emotion broaden',
  customizedHint: (filename) =>
    `   To broaden it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the agency-removal, reported-sensation-filtering, and\n` +
    `   asserted-knowledge categories (plus the prose.filter-words coordination\n` +
    `   note) to the "Flag a passage when..." list.`,
  skipFooter: (count) =>
    `⚠️  ${count} telling-emotion prompt(s) could not be auto-updated because\n` +
    `   they were customized. The check still runs, but will keep flagging only\n` +
    `   named emotions until you broaden it to cover agency-removal, reported\n` +
    `   sensation, and asserted knowledge.\n` +
    `   See data.reference/prompts/stages/pipeline-editorial-telling-emotion.md.`,
});

export { applyMigration };
export default { up };
