import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = { 'pipeline-arc-resolve.md': ['638b988c84b3e5599f7a2ce09fa149ce'] };
export const NEW_SHIPPED_MD5 = { 'pipeline-arc-resolve.md': '56926d795bd31f7e05e6bbbc646ecf9f' };
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Arc countdown repair',
  customizedHint: () => '   Merge the countdown metadata and sparse reminder-ID repair contract from data.reference/prompts/stages/pipeline-arc-resolve.md into your customized prompt.',
});
export { applyMigration };
export default { up };
