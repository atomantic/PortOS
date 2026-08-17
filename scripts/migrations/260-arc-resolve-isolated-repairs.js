/**
 * Teach the arc-resolve prompt the bounded single-finding repair contract.
 *
 * When the arc gate's whole-set passes regress twice it falls back to resolving
 * one finding at a time. Isolating the finding never isolated the EDIT: every
 * entry in a single-finding response trivially names that finding, so the
 * resolver could still rewrite the arc and several volumes and grow the blocking
 * set exactly like the pass it was escalated from. The server now discards a
 * candidate that spans records or fields; this prompt section tells the model
 * the contract up front so the attempt has a chance of closing its finding.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['ebd85d3a0b5949f16877c25ca498cce9'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve isolated one-patch repairs',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the {{#isolatedRepair}} section.`,
});

export { applyMigration };
export default { up };
