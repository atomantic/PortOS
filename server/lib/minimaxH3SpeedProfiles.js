import { isDeepStrictEqual } from 'node:util';
import contract from './minimaxH3Lightx2v.json' with { type: 'json' };

export const MINIMAX_H3_LIGHTX2V_PROFILE = Object.freeze(contract);
export const isMiniMaxH3SpeedProfile = (profile) => profile?.type === contract.type;
export const isMiniMaxH3SpeedProfileRequest = (id) => id === contract.id;
export const isPinnedMiniMaxH3SpeedProfile = (model, profile) => (
  Object.entries(contract.model).every(([key, value]) => model?.[key] === value)
  && isDeepStrictEqual(profile, contract)
);

// A distilled adapter and its schedule are one contract. Refusing a mismatch
// preserves user intent; falling back here would spend a queue slot on stock.
export function miniMaxH3SpeedProfileDeclineReason({ model, profileId, mode = 'text', width, height,
  steps, guidanceScale, chunks, lastImagePath, keyframes, extendFromVideoPath, audioFilePath }) {
  if (!isMiniMaxH3SpeedProfileRequest(profileId)) return null;
  const fail = (code, message) => ({ code: `MINIMAX_H3_SPEED_${code}`, message });
  const offered = model?.speedProfiles?.find((p) => p?.id === profileId);
  if (!isPinnedMiniMaxH3SpeedProfile(model, offered)) {
    return fail('MODEL_UNSUPPORTED', 'LightX2V v1.3 requires the shipped MiniMax H3 CUDA model and its pinned revision. Select that model; MLX and custom checkpoints are not supported by this profile.');
  }
  if (!contract.modes.includes(mode || 'text') || Number(chunks || 1) > 1
    || lastImagePath || keyframes?.length || extendFromVideoPath || audioFilePath) {
    return fail('MODE_UNSUPPORTED', 'LightX2V v1.3 supports single-clip text or first-image generation only. FFLF, continuation, reference/audio conditioning and chains require the stock sampler.');
  }
  if ((width != null || height != null)
    && !contract.canvases.some(([w, h]) => Number(width) === w && Number(height) === h)) {
    return fail('CANVAS_UNSUPPORTED', 'LightX2V v1.3 is supported at 1344×768 only. Select that canvas or the stock sampler.');
  }
  if ((steps != null && steps !== '' && Number(steps) !== contract.steps)
    || (guidanceScale != null && guidanceScale !== '' && Number(guidanceScale) !== contract.guidance)) {
    return fail('SAMPLER_CONFLICT', 'LightX2V v1.3 sets five sigma points (four denoising updates) and no CFG. Clear the steps/CFG overrides or select the stock sampler.');
  }
  return null;
}
