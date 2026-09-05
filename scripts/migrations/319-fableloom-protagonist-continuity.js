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
  'fableloom-weave-episode.md': 'abea2442af2be2039b70deee4919c00e',
  'fableloom-outline-episode.md': '2ff6fb72777ff0c6fc70f3afd0ddfd53',
  'fableloom-review-episode-outline.md': '0f549ed25dea8566ce2d3c515968783b',
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
