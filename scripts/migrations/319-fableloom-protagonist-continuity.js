/** Upgrade FableLoom prompts with canonical protagonist and off-screen scene rules. */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  // 18a442 is the shipped FableLoom audience/camera-cut template. The outline
  // and outline-review hashes also cover the templates seeded by migrations
  // 317/318 before the protagonist-presence additions in this migration.
  'fableloom-weave-episode.md': ['18a442e39b973e4074a0d595928a665d'],
  'fableloom-outline-episode.md': ['3f5144103b2ab6203fa071ff5026251b'],
  'fableloom-review-episode-outline.md': ['96d631104155ff11be08bcc5144cca1c'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': '94f22c0807924dadf151341c30720c71',
  'fableloom-outline-episode.md': '76f5211b851de7a0a23d9c11c5969b25',
  'fableloom-review-episode-outline.md': '3e548d8de54dd23312a6f1024910fedc',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom protagonist identity, wardrobe, and off-screen presence',
  customizedHint: (filename) =>
    `   Merge the canonical protagonist wardrobe and off-screen communicator rules from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };
