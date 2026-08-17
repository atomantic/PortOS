/**
 * Teach the arc auto-resolve prompt to accept a "do not author these" list.
 *
 * When the autopilot's arc-verify gate reverts a resolve round for growing the
 * blocking-finding count, it now re-runs the resolver from the restored state
 * with the rejected attempt's own findings attached. Without this section the
 * retry renders the identical prompt and can regress identically.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['96f73a7e90526d65ef2bb100fb1cd4bf'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve corrective-pass avoid list',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the {{#hasAvoid}} section that names the problems a discarded earlier attempt introduced.`,
});

export { applyMigration };
export default { up };
