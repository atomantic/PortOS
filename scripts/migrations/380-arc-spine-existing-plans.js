import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {"pipeline-arc-resolve.md": ["3f5ef41212890889811e4509a131c4e9"], "pipeline-arc-verify.md": ["4b60a322e35b536405d0fbf543580562"]};
export const NEW_SHIPPED_MD5 = {"pipeline-arc-resolve.md": "5fb659e459a296b7d378d7711f4b78cd", "pipeline-arc-verify.md": "090920d816beef8dfc12ee6152511456"};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Arc spine existing issue references',
  customizedHint: () => '   Merge the arcSpineHasEpisodePlans / spineEpisodePlansJson read-only reference block from the shipped arc verify and resolve templates.',
});
export { applyMigration };
export default { up };
