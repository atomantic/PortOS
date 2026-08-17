/**
 * Let arc verification repair the per-character arcs it judges.
 *
 * The verifier reads `series.characterArcs`, but the resolver's output contract
 * previously exposed only the series arc, volumes, and episode synopses. A
 * finding against a provisional transition was therefore impossible to close;
 * repeated rounds rewrote neighboring records and regressed instead. The new
 * contract emits finding-keyed, ID-preserving sparse character-arc patches.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['0611db539437083621e19bb88b005e8d'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve sparse character-arc repairs',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the finding-keyed characterArcs[] patch contract.`,
});

export { applyMigration };
export default { up };
