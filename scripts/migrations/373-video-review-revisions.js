import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {
  'cd-treatment.md': ['4da071646deff0001473502a7c4b5252'],
  'cd-plan.md': ['02354df62fe776704669d3ff06f346e4'],
  'cd-evaluate.md': ['c986613edbb595cece674403db0f069d'],
};
export const NEW_SHIPPED_MD5 = {
  'cd-treatment.md': '16c5ce4a199d8efbf80016424315beb6',
  'cd-plan.md': '8dac4102dbbaee05f2f23f37c7e80782',
  'cd-evaluate.md': 'a86de29e186581d3508662569c8acbf6',
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Video review revision guards',
  customizedHint: filename => `   Merge the Video revision fields from data.reference/prompts/stages/${filename} into your customized prompt.`,
});
export { applyMigration };
export default { up };
