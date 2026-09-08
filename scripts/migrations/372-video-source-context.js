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
  "cd-treatment.md": "16c5ce4a199d8efbf80016424315beb6",
  "cd-plan.md": "8dac4102dbbaee05f2f23f37c7e80782"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'resolved Video source context',
  customizedHint: filename => '   Merge the resolved Video sources section and sourceContextRevision output field from data.reference/prompts/stages/' + filename + ' into your customized prompt.',
});
export { applyMigration };
export default { up };
