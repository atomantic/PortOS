/**
 * Keep the arc auto-resolve prompt at the altitude the verifier judged.
 *
 * The pre-episode arc-spine checkpoint verifies an episode-empty plan, but the
 * resolver was handed the full episode lineup and answered spine findings with
 * episode-synopsis rewrites the gate never evaluated — a round that could not
 * close what it was given and got reverted for growing the blocker count. This
 * adds the `{{#arcSpineOnly}}` section that scopes those rounds to arc/volume
 * edits; the server discards any `episodes[]` they return regardless.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['0787128babf3c4c50e2f2cdb60214030'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '3f5ef41212890889811e4509a131c4e9', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve spine-scoped rounds',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the {{#arcSpineOnly}} section that scopes the pre-episode round to arc + volume edits.`,
});

export { applyMigration };
export default { up };
