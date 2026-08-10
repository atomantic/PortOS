/**
 * Update the `pipeline-arc-resolve` stage prompt to emit finding-keyed, sparse
 * patches instead of a full arc/volume rewrite (#3724).
 *
 * The resolve pass used to be an unconditional broad rewrite: `seasons[]` had
 * to be "the FULL list of volumes you want the series to have after the
 * resolve", and nothing tied a proposed edit to the finding it was supposed to
 * close. A round handed ONE blocking finding could legitimately rewrite every
 * volume, and each untargeted rewrite was a fresh chance to author the
 * contradiction the next verify files as a NEW blocker — the shape behind the
 * 1 → 3 → 5 non-convergence on 2026-08-09.
 *
 * The new prompt stamps each finding with a stable `findingId` (`f1`…`fN`),
 * requires every entry in `arc` / `seasons[]` / `episodes[]` to name the
 * findings it closes via `resolves[]`, and turns `seasons[]` into a SPARSE
 * patch list — a volume the resolver leaves out is untouched rather than
 * deleted. `resolveVerifyIssues` drops any edit that names no input finding.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': [
    'cc27b4da1d1a13c35e35d1c2d6183815', // pre-245 (post-123 episodes[] channel)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '8bb134554c122d1583c479ab3010e53d', // post-245 (finding-keyed sparse patches)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve stage prompt',
  customizedHint: (filename) =>
    `   To key resolve edits to findings manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge instruction 9 + the resolves[] fields in the output contract.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Arc auto-resolve will keep working, but until you merge the resolves[]\n` +
    `   contract its edits stay unkeyed — every round can still rewrite volumes\n` +
    `   no finding asked it to touch.`,
});

export { applyMigration };
export default { up };
