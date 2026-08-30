/**
 * Upgrade FableLoom generation/editing prompts to one renderable camera cut
 * per node and add the shared camera-movement vocabulary. The weave template's
 * current hash is resynced to the latest continuity contract; its former
 * current hash is retained as an accepted intermediate for replayed ledgers.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-weave-episode.md': [
    '1b27f5b0073a304c21079aa6e2c71447',
    '18a442e39b973e4074a0d595928a665d', // post-311 / pre-319
  ],
  'fableloom-branch-node.md': ['6279b1c9912c300363a727245d22fe84'],
  'fableloom-feedback-episode.md': ['43d1525fcedce99b933ae5b003516a36'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': 'b4d363db94fd8a9928fa977745c76ff9', // post-321 outline expansion contract
  'fableloom-branch-node.md': '39a208c8cc593d0531af50760e3cf0da',
  'fableloom-feedback-episode.md': '1aaa6f17acad6a3215e48dcce14e8670',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom camera cuts and interactive playback',
  customizedHint: (filename) =>
    `   Merge the one-camera-cut and playback-mode contracts plus {{cameraMovementCatalog}} from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };
