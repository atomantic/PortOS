/**
 * Teach the Writers Room CD-bridge prompt to emit `continueFromPrior` (#14255).
 *
 * Bridged scenes start from their own plate unless the proposal scene sets
 * `continueFromPrior: true` (#14245), but the stage prompt never asked for the
 * field, so every bridged scene started fresh. Hash replacement upgrades an
 * uncustomized install and leaves a customized template alone.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'writers-room-cd-bridge.md': ['0d744b22b9f9bf5f42978a762a7cf8f8'],
};

export const NEW_SHIPPED_MD5 = {
  'writers-room-cd-bridge.md': '96c00e68d908bc4aea449cc7b041abec',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Writers Room CD-bridge continueFromPrior prompt',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the optional\n` +
    '   `continueFromPrior` scene field. Without it, bridged scenes never\n' +
    '   chain from the prior shot.',
});

export { applyMigration };
export default { up };
