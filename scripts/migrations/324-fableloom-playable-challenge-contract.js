/** Upgrade FableLoom prompts with durable challenge-to-scene mapping. */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-generate-series-plan.md': ['2591cf4ca6cc160765f029fcc497dc35'],
  'fableloom-outline-episode.md': ['513b2b5b8fa98766852cdde7b87198c9'],
  'fableloom-weave-episode.md': ['b4d363db94fd8a9928fa977745c76ff9'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-generate-series-plan.md': 'ab912a52879d8ce78e9998dec19ddaa8',
  'fableloom-outline-episode.md': '76f5211b851de7a0a23d9c11c5969b25',
  'fableloom-weave-episode.md': '94f22c0807924dadf151341c30720c71',
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
