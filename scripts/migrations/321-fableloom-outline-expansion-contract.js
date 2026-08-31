/** Upgrade FableLoom episode weaving to preserve validated outline keys and transitions. */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-weave-episode.md': ['e0f8d864caa8746912b56cd567f1c09d'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': 'abea2442af2be2039b70deee4919c00e',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom validated outline expansion contract',
  customizedHint: (filename) =>
    `   Merge the exact outline-key and transition-preservation rules from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };
