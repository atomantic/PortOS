import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = { 'pipeline-arc-resolve.md': ['122950b9f5ce84708ac1510ef13b1bce'] };
export const NEW_SHIPPED_MD5 = { 'pipeline-arc-resolve.md': '56926d795bd31f7e05e6bbbc646ecf9f' };
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Arc episode metadata repair',
  customizedHint: () => '   Merge the sparse episode role and length repair contract from data.reference/prompts/stages/pipeline-arc-resolve.md into your customized prompt.',
});
export { applyMigration };
export default { up };
