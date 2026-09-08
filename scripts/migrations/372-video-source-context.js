/** Upgrade shipped creative planning prompts with resolved standalone Video source context. */
import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {
  "cd-treatment.md": [
    "1de973575a772db0544bbeda2ba5df77"
  ],
  "cd-plan.md": [
    "41a61590896d1327df2c6915557361de"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "cd-treatment.md": "4da071646deff0001473502a7c4b5252",
  "cd-plan.md": "02354df62fe776704669d3ff06f346e4"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'resolved Video source context',
  customizedHint: filename => '   Merge the resolved Video sources section and sourceContextRevision output field from data.reference/prompts/stages/' + filename + ' into your customized prompt.',
});
export { applyMigration };
export default { up };
