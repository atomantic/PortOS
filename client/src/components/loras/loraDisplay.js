import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from '../../lib/runnerFamilies';

export const RUNNER_LABEL = {
  [RUNNER_FAMILIES.MFLUX]: 'Flux 1',
  [RUNNER_FAMILIES.FLUX2]: 'Flux 2',
  [RUNNER_FAMILIES.Z_IMAGE]: 'Z-Image',
  [RUNNER_FAMILIES.ERNIE]: 'ERNIE',
  [RUNNER_FAMILIES.HIDREAM]: 'HiDream',
  [RUNNER_FAMILIES.QWEN]: 'Qwen',
  [VIDEO_LORA_FAMILIES.LTX_VIDEO]: 'LTX-Video',
  [VIDEO_LORA_FAMILIES.MINIMAX_H3]: 'MiniMax H3',
};
export const RUNNER_BADGE_CLASS = {
  [RUNNER_FAMILIES.MFLUX]: 'bg-port-accent/20 text-port-accent border-port-accent/30',
  [RUNNER_FAMILIES.FLUX2]: 'bg-purple-600/20 text-purple-300 border-purple-500/30',
  [RUNNER_FAMILIES.Z_IMAGE]: 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30',
  [RUNNER_FAMILIES.ERNIE]: 'bg-amber-600/20 text-amber-300 border-amber-500/30',
  [RUNNER_FAMILIES.HIDREAM]: 'bg-rose-600/20 text-rose-300 border-rose-500/30',
  [RUNNER_FAMILIES.QWEN]: 'bg-sky-600/20 text-sky-300 border-sky-500/30',
  [VIDEO_LORA_FAMILIES.LTX_VIDEO]: 'bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-500/30',
  [VIDEO_LORA_FAMILIES.MINIMAX_H3]: 'bg-teal-600/20 text-teal-300 border-teal-500/30',
};

// Stable identity for a suggestion's specific model+version — used for React
// keys, install-in-flight tracking, and "Load more" dedup. Curated cards pass
// a family-specific versionId that differs from the card's primary, so the key
// takes the two ids explicitly rather than a whole card.
export const suggestionKey = (modelId, versionId) => `${modelId}-${versionId}`;
export const cardKey = (card) => suggestionKey(card.modelId, card.versionId);
export const hfCardKey = (card) => `${card.repo}:${card.file || ''}`;
export const installedHfKey = (lora) => `${lora.huggingface?.repo || ''}:${lora.huggingface?.file || ''}`;

// Integer download percent (0..100) from an SSE progress frame, or null when
// the frame carries no numeric ratio (server sent no Content-Length → the UI
// shows an indeterminate bar). Shared by the HF install form button, the
// progress bar, and the curated video quick-install button.
export const pctOf = (progress) => (progress && typeof progress.progress === 'number' ? Math.round(progress.progress * 100) : null);
