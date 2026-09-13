/** Teach existing installs to establish character stakes before mystery mechanics. */
import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  "fableloom-outline-episode.md": [
    "820b8c157c1977b34eb317e44236519e"
  ],
  "fableloom-review-episode-outline.md": [
    "8154b4c289b10268df8fd3c625bcdac2"
  ]
};
export const NEW_SHIPPED_MD5 = {
  "fableloom-outline-episode.md": "76f5211b851de7a0a23d9c11c5969b25",
  "fableloom-review-episode-outline.md": "3e548d8de54dd23312a6f1024910fedc"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'FableLoom opening comprehension',
  customizedHint: (filename) => `   Merge opening comprehension guidance from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
