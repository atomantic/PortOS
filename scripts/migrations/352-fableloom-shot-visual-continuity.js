/** Upgrade shot direction and review before image-to-video production. */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "fableloom-plan-shots.md": [
    "4cf0fb96d4e9a17a8ae8285ec134f37f"
  ],
  "fableloom-review-shots.md": [
    "699ba1189f67338728b74834269759a9"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "fableloom-plan-shots.md": "9b1cd4b406ee327d6dc3fcbd57b48483",
  "fableloom-review-shots.md": "8cf5fe685cc5f75537caddea1d272a00"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'FableLoom shot visual continuity',
  customizedHint: (filename) => `   Merge shot continuity and no-subtitle direction from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
