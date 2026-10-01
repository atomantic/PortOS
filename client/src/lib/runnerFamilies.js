export {
  RUNNER_FAMILIES,
  VIDEO_LORA_FAMILIES,
  isVideoLoraFamily,
  MINIMAX_H3_REF2VA_RUNTIME,
  MINIMAX_H3_RUNTIMES,
  isMiniMaxH3Runtime,
  LTX2_FAMILY_RUNTIMES,
  isLtx2FamilyRuntime,
  AUDIO_TO_VIDEO_RUNTIMES,
  isAudioToVideoRuntime,
  loraFamilyOf,
  isMlxVideoLtxLoraCapable,
  videoLoraFamily,
  flux2VariantFromModel,
  composeCompatKey,
  loraCompatKey,
  usesDiffusersRunner,
} from '../../../server/lib/runners.js';

// Unknown sizes retain the picker's legacy coarse-family match; known FLUX.2
// sizes must agree so Test and the picker cannot select different adapters.
export const loraCompatKeysMatch = (loraKey, modelKey) => {
  const familyOf = (key) => typeof key === 'string' && key.startsWith('flux2') ? 'flux2' : key;
  return !loraKey || loraKey === modelKey
    || loraKey === familyOf(modelKey) || modelKey === familyOf(loraKey);
};
