/**
 * Add `{{worldCanonText}}` context block to the four arc/volume prompt
 * templates that receive linked-world context so the LLM sees named
 * universe canon (characters/places/objects) alongside the existing
 * exploratory `worldCategoriesText`.
 *
 * Updates (per ACCEPTED_OLD_MD5 below):
 *   - data/prompts/stages/pipeline-arc-overview.md
 *   - data/prompts/stages/pipeline-arc-verify.md
 *   - data/prompts/stages/pipeline-arc-resolve.md
 *   - data/prompts/stages/pipeline-volume-verify.md
 *
 * Why:
 *   Phase A retired the default `characters` category; characters now live in
 *   `universe.characters[]` (canon). Without this template change, arc-level
 *   prompts that grounded continuity findings in entity names lost the
 *   character roster entirely. arcPlanner exposes `worldCanonText` to every
 *   arc context now, but a context field without a template reference is
 *   silently ignored — so every prompt that gets the field must render it.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 *
 * NOTE on NEW_SHIPPED_MD5 — later migrations that further evolve any of these
 * files (e.g. migration 023 amended `pipeline-arc-resolve.md`) must do TWO
 * things:
 *   1. Bump the corresponding entry in `NEW_SHIPPED_MD5` here so fresh
 *      installs (whose `data/` was seeded from the latest sample) report
 *      `alreadyCurrent` instead of a misleading "customized" warning, and so
 *      the drift-catch test stays in lock-step with the live sample.
 *   2. Append the OLD `NEW_SHIPPED_MD5` value (the hash this migration
 *      originally produced) to `ACCEPTED_OLD_MD5` above so a re-run after a
 *      `data/migrations.applied.json` reset still cleanly advances an
 *      install at the intermediate state.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': [
    'd34d72b8e49ba303d38607845dd87f1c', // current (pre-Phase B) shipped
    '6a3ecab43d1f46b7ef9aab6c69ea0326', // pre-005 (shape-aware), still in setup-data.js OLD list
    '0a1f6ffa6908522e3690c5e9e53a6ee0', // post-019 / pre-165 (foreshadowing ledger)
    '612f8b04950e2ff26dd350dd76a062fe', // post-166 / pre-173 (MICE thread nesting)
  ],
  'pipeline-arc-verify.md': [
    'ff56d8387162017e08d5d0491060ddd6', // current (pre-Phase B) shipped
    '52e31abc93e3105176236fcaa5d1575a', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-arc-resolve.md': [
    '5b340885c6e8f8afc63424d6b5bc7eb7', // post-023 / pre-123 — episode-synopsis anchor, before the episodes[] channel
    '8e348f3d1894382889f9f0ee7d5c6792', // post-019 / pre-023 — the hash this migration originally produced; included so a re-run after a `data/migrations.applied.json` reset can cleanly advance an install at the intermediate state to the post-123 live sample
    'a8677bbe1eb38f871fb152a5b0fec7c6', // pre-019 (pre-Phase B) shipped
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
  'pipeline-volume-verify.md': [
    '03f3c874cb80e1c98abcf03168fa7a92', // current (pre-Phase B) shipped
    'c6ea28e972ad6e229bafb2d602b4dda3', // pre-005 (shape-aware), still in setup-data.js OLD list
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':   '74d6c26548660d85fc345b2099c63b6c', // post-173 (MICE thread nesting)
  'pipeline-arc-verify.md':     '36aa70cdfc25d7549573a4d556e7702c', // post-019
  'pipeline-arc-resolve.md':    'cc27b4da1d1a13c35e35d1c2d6183815', // post-123 (episodes[] correction channel)
  'pipeline-volume-verify.md':  '49458d36700cb94e34806d536ffe2940', // post-019
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-prompt canon-context',
  customizedHint: (filename) =>
    `   To pick up {{worldCanonText}} manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the new "World canon" block in the same position as in the sample template.`,
  skipFooter: (count) =>
    `⚠️  ${count} arc/volume prompt(s) could not be auto-updated because they were customized.\n` +
    `   The {{worldCanonText}} block will not render character names in arc-overview/\n` +
    `   arc-verify/arc-resolve/volume-verify until the files are merged manually. See\n` +
    `   data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
