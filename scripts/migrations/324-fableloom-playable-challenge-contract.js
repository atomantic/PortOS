/** Upgrade FableLoom prompts with durable challenge-to-scene mapping. */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-generate-series-plan.md': ['2591cf4ca6cc160765f029fcc497dc35'],
  'fableloom-outline-episode.md': ['513b2b5b8fa98766852cdde7b87198c9'],
  'fableloom-weave-episode.md': ['b4d363db94fd8a9928fa977745c76ff9'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-generate-series-plan.md': '27336d8c64e6193aecd1ba697f52315e',
  'fableloom-outline-episode.md': '820b8c157c1977b34eb317e44236519e',
  'fableloom-weave-episode.md': 'abea2442af2be2039b70deee4919c00e',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom playable challenge phase mapping',
  customizedHint: (filename) =>
    `   Merge the durable plot-point kind and challenge-phase rules from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };
