/**
 * Make the pipeline arc + season + verify + resolve prompts Vonnegut-shape
 * aware. Adds `{{{shapeGuidance}}}` (the rendered curve + per-position
 * guidance) and, where applicable, `{{shapePosition}}` / `{{volumeShapePosition}}`
 * (the per-volume placement on the picked curve) to:
 *
 *   pipeline-arc-overview        — propose-or-honor block + `shape` in JSON output
 *   pipeline-season-episodes     — per-season curve placement, episode pacing rule
 *   pipeline-arc-verify          — new "story-shape adherence" check
 *   pipeline-volume-verify       — per-volume placement + volume-internal adherence check
 *   pipeline-arc-resolve         — preserve picked shape during auto-resolve
 *
 * `pipeline-arc-resolve.md` was never previously in data.reference/ (it shipped
 * in `27ef3c27` but only landed in `data/`). `createIfMissing: true` keeps
 * the migration self-contained for that case; for the other files the branch
 * never fires because they already shipped in data.reference/.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': [
    '6a3ecab43d1f46b7ef9aab6c69ea0326', // pre-005 (original)
    'd34d72b8e49ba303d38607845dd87f1c', // post-005 / pre-019 — the hash this migration originally produced
    '0a1f6ffa6908522e3690c5e9e53a6ee0', // post-019 / pre-165 (foreshadowing ledger)
    '612f8b04950e2ff26dd350dd76a062fe', // post-166 / pre-173 (MICE thread nesting)
  ],
  'pipeline-arc-verify.md': [
    '52e31abc93e3105176236fcaa5d1575a', // pre-005 (original)
    'ff56d8387162017e08d5d0491060ddd6', // post-005 / pre-019 — the hash this migration originally produced
    '83347e7d923580a3062033ab39b3c14b', // post-250 / pre-261 — arc spine checkpoint before exhaustive verification
    '68f6956d7e09ebdb3870d8726b1b2a7a', // post-261 / pre-263 — before the world category canon block
  ],
  'pipeline-volume-verify.md': [
    'c6ea28e972ad6e229bafb2d602b4dda3', // pre-005 (original)
    '03f3c874cb80e1c98abcf03168fa7a92', // post-005 / pre-019 — the hash this migration originally produced
  ],
  'pipeline-season-episodes.md': [
    'c4928e2a5f833358116b29d2d669888d', // pre-005 (original)
    '50c68a29c3ebc275db3095d06bd87100', // post-005 / pre-172 (structure rules)
  ],
  'pipeline-arc-resolve.md': [
    'cc27b4da1d1a13c35e35d1c2d6183815', // post-123 / pre-245 — the episodes[] channel, before edits had to name a finding
    '87bc5c01f1a8a97b681727a38b05edc6', // pre-005 (original)
    'a8677bbe1eb38f871fb152a5b0fec7c6', // post-005 / pre-019 — the hash this migration originally produced
    '8e348f3d1894382889f9f0ee7d5c6792', // post-019 / pre-023
    '5b340885c6e8f8afc63424d6b5bc7eb7', // post-023 / pre-123 (episode-synopsis anchor)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':    '901557b9f146a2d279ce2e81bda24d73', // post-250 arc spine checkpoint
  'pipeline-arc-verify.md':      '090920d816beef8dfc12ee6152511456', // post-276 distinct climax
  'pipeline-volume-verify.md':   '6f9b4ba4d9dd9a51a1032c7f0ca90405', // post-274 planning economy
  'pipeline-season-episodes.md': 'b3fc07d785599b5a4859af8bed3c1d4e', // post-276 distinct climax
  'pipeline-arc-resolve.md':     '5fb659e459a296b7d378d7711f4b78cd', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'shape-aware prompt',
  createIfMissing: true,
  customizedHint: (filename) =>
    `   To apply the Vonnegut shape variables manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the {{{shapeGuidance}}} block (and {{shapePosition}} / {{volumeShapePosition}} where applicable).`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Shape-aware features will work for un-customized prompts; the customized\n` +
    `   ones will continue using their existing templates (without the\n` +
    `   {{{shapeGuidance}}} block) until you merge manually.`,
});

export { applyMigration };
export default { up };
