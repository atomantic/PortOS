/**
 * Upgrade FableLoom prompts with audience-role and communication-channel rules.
 * The weave template is resynced to the latest continuity contract; its former
 * current hash remains accepted as an intermediate replay state.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-weave-episode.md': [
    '4c9454d1537c4ebb3becbfa04fae3ed8',
    '18a442e39b973e4074a0d595928a665d', // post-311 / pre-319
  ],
  'fableloom-branch-node.md': ['c14e2b9c435e43a8c3b134a62cd66d08'],
  'fableloom-feedback-episode.md': ['d09bb405478d24c294b0c658ef365cd1'],
  'fableloom-review.md': ['2802f269f246e00ec5a8937637d42de6'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': 'b4d363db94fd8a9928fa977745c76ff9', // post-321 outline expansion contract
  'fableloom-branch-node.md': '39a208c8cc593d0531af50760e3cf0da',
  'fableloom-feedback-episode.md': '1aaa6f17acad6a3215e48dcce14e8670',
  'fableloom-review.md': 'c26a641f6d0530caef7d1186c3b09937',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom audience participation and communication channels',
  customizedHint: (filename) =>
    `   Merge the helper/protagonist audience contract and per-scene connection rules from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };
