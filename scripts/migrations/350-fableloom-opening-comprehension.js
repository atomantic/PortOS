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
  "fableloom-outline-episode.md": "2ff6fb72777ff0c6fc70f3afd0ddfd53",
  "fableloom-review-episode-outline.md": "0f549ed25dea8566ce2d3c515968783b"
};
const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5, current: NEW_SHIPPED_MD5,
  label: 'FableLoom opening comprehension',
  customizedHint: (filename) => `   Merge opening comprehension guidance from data.reference/prompts/stages/${filename}.`,
});
export { applyMigration };
export default { up };
