import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {"pipeline-arc-resolve.md": ["3f5ef41212890889811e4509a131c4e9"], "pipeline-arc-verify.md": ["4b60a322e35b536405d0fbf543580562"]};
export const NEW_SHIPPED_MD5 = {"pipeline-arc-resolve.md": "56926d795bd31f7e05e6bbbc646ecf9f", "pipeline-arc-verify.md": "f09e81655ec897c74a2fae68ad31b9c4"};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Arc spine existing issue references',
  customizedHint: () => '   Merge the arcSpineHasEpisodePlans / spineEpisodePlansJson read-only reference block from the shipped arc verify and resolve templates.',
});
export { applyMigration };
export default { up };
