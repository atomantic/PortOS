/**
 * Mirror of `server/lib/runners.js`, including the shared LTX + MiniMax H3 Ref2VA audio-to-video
 * runtime predicate.
 *
 * `loraCompatKeysMatch` keeps image Test handoffs and the adapter picker on the same size/family
 * compatibility rule.
 */

export { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES, isVideoLoraFamily, isMiniMaxH3Runtime, isLtx2FamilyRuntime, isAudioToVideoRuntime, loraFamilyOf, isMlxVideoLtxLoraCapable, videoLoraFamily, loraCompatKey, usesDiffusersRunner } from '../../../server/lib/runners.js';

// Unknown sizes retain the picker's legacy coarse-family match; known FLUX.2
// sizes must agree so Test and the picker cannot select different adapters.
export const loraCompatKeysMatch = (loraKey, modelKey) => {
  const familyOf = (key) => typeof key === 'string' && key.startsWith('flux2') ? 'flux2' : key;
  return !loraKey || loraKey === modelKey
    || loraKey === familyOf(modelKey) || modelKey === familyOf(loraKey);
};
