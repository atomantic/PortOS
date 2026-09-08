/**
 * Upgrade shipped treatment prompts to the standalone Video script/timing contract.
 * Customized prompts are preserved; setup-data discovers this hash lineage.
 */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-treatment.md': ['d940eadfb406ce584f0e244032f33382'],
};
export const NEW_SHIPPED_MD5 = {
  'cd-treatment.md': '4da071646deff0001473502a7c4b5252',
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'standalone Video treatment contract',
  customizedHint: (filename) => '   Merge the standalone Video sections from data.reference/prompts/stages/' + filename + ' into your customized prompt.',
});
export { applyMigration };
export default { up };
