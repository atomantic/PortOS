/**
 * Keep arc verification and repair at episode-planning altitude.
 *
 * Continuity repair used the 200k generic stage-input ceiling even though
 * episode generation capped a synopsis at 4k. Repeated verifier rounds could
 * therefore grow a concise drafting seed into a procedural near-manuscript,
 * while the judges had no explicit dramatic-economy or synopsis-size check.
 * Publish the new shared budget and the goal/obstacle/choice/consequence,
 * metadata-fit, and premise-engine checks to customized installs.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['aa2e463ebe0857859d79aa0c6ccb0256'],
  'pipeline-arc-verify.md': ['9f32e91bd33b97d30e1cbb2e697f4fc3'],
  'pipeline-volume-verify.md': ['49458d36700cb94e34806d536ffe2940'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
  'pipeline-arc-verify.md': '90712f66ec68061ebed2147044e5baee',
  'pipeline-volume-verify.md': '3e8a8f00d5faaee9d8e08a49d801b812',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pipeline planning economy',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the planning-altitude,\n` +
    `   dramatic-economy, metadata-fit, and premise-engine rules.`,
});

export { applyMigration };
export default { up };
