import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {
  "pipeline-arc-overview.md": [
    "5ed760caaf3cf88916ec28b220e2f590"
  ],
  "pipeline-season-episodes.md": [
    "7c24df53c097c2525a52bfb766239647"
  ],
  "pipeline-arc-verify.md": [
    "f09e81655ec897c74a2fae68ad31b9c4"
  ],
  "pipeline-volume-verify.md": [
    "9c0839d7fe1760c0891464afd4a3b8fd"
  ],
  "pipeline-arc-resolve.md": [
    "56926d795bd31f7e05e6bbbc646ecf9f"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "pipeline-arc-overview.md": "901557b9f146a2d279ce2e81bda24d73",
  "pipeline-season-episodes.md": "b3fc07d785599b5a4859af8bed3c1d4e",
  "pipeline-arc-verify.md": "090920d816beef8dfc12ee6152511456",
  "pipeline-volume-verify.md": "6f9b4ba4d9dd9a51a1032c7f0ca90405",
  "pipeline-arc-resolve.md": "5fb659e459a296b7d378d7711f4b78cd"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Pipeline series design',
  customizedHint: filename => `   Merge the series-design guidance from data.reference/prompts/stages/${filename} into your customized prompt.`,
});
export { applyMigration };
export default { up };
