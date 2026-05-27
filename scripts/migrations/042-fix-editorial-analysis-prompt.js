/**
 * Fix the `pipeline-editorial-analysis` stage prompt's output-contract example.
 *
 * The JSON example shipped by migration 041 used a pipe-separated enum literal
 * for `arcDirection` (`"rising|falling|flat|complex"`) and asked for a ≤160-char
 * excerpt. LLMs reproduce pipe-separated enum strings verbatim, and the
 * sanitizer (`ARC_DIRECTIONS.includes(raw.arcDirection) ? raw.arcDirection :
 * 'flat'`) then silently falls through to `'flat'` — corrupting every
 * character's arc direction and degrading protagonist / supporting-arc
 * detection (both gate on `arcDirection !== 'flat'`). The example now uses a
 * single concrete value (`"rising"`), relying on the task-section bullet to
 * enumerate the allowed values. The excerpt cap is also aligned to the
 * sanitizer's actual `EXCERPT_MAX` (200).
 *
 * Migration 041 only SEEDS the prompt when missing, so an install that already
 * ran 041 (a machine that tracked unreleased main) keeps the buggy copy. This
 * hash-driven replace bumps that copy to the corrected sample; it is a no-op
 * on fresh installs (041 seeds the corrected sample directly) and on
 * customized copies (matches neither hash → skipped).
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-editorial-analysis.md': [
    '14d9879697c66d51830cc798040d5369', // pre-042 (pipe-separated arcDirection enum + ≤160 excerpt)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-editorial-analysis.md': 'daeb02bd54b0c099b21af659c6298cfe', // post-042 (single arcDirection example, ≤200 excerpt)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'editorial-analysis prompt',
  customizedHint: (filename) =>
    `   To fix the arcDirection example manually, edit:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and replace the JSON example's "arcDirection": "rising|falling|flat|complex"\n` +
    `   with a single value like "arcDirection": "rising".`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Until fixed, the editorial analysis may report every character's arc as\n` +
    `   "flat" (the LLM echoes the pipe-separated enum literal verbatim).\n` +
    `   See data.reference/prompts/stages/pipeline-editorial-analysis.md.`,
});

export { applyMigration };
export default { up };
