import { makePromptReplaceMigration } from './_lib.js';
export const ACCEPTED_OLD_MD5 = {
  "pipeline-manuscript-completeness.md": [
    "fd26f928c33803c12878a1bfb8561ece"
  ],
  "pipeline-judge-foundation.md": [
    "75714f0e41c77ff5c8b9623cb4fb0a25"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "pipeline-manuscript-completeness.md": "a08a7aaea9b57dcf12311505150672cd",
  "pipeline-judge-foundation.md": "d4abf4ddafbf84a2903e6d70d14adea1"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5, label: 'Pilot developmental review',
  customizedHint: filename => `   Merge the opening-contract guidance from data.reference/prompts/stages/${filename} into your customized prompt.`,
});
export { applyMigration };
export default { up };
