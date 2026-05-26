// Writers Room per-scene image-gen defaults + style discriminators.
//
// Mirror of server/lib/writersRoomStylePresets.js — kept in sync manually
// since client and server are separate bundles. Curated preset ids come from
// the /api/image-gen/style-presets endpoint at runtime; only the two
// special discriminators live here.

import { IMAGE_GEN_MODE } from './imageGenBackends';

export const STYLE_ID = Object.freeze({ NONE: 'none', CUSTOM: 'custom' });
export const EMPTY_IMAGE_STYLE = Object.freeze({ presetId: STYLE_ID.NONE, prompt: '', negativePrompt: '' });

// Defaults for the per-scene image gen pipe. Klein-4B is the fastest FLUX.2
// variant on Apple Silicon, and 768×512 is a 3:2 aspect that suits scene work.
// steps + seed are stored as strings (or empty) so the form inputs can bind
// directly. Empty string = "use model default" for steps, "random per render"
// for seed. Parsed to numbers at the generateImage boundary in SceneCard.
export const WR_IMAGE_DEFAULTS = Object.freeze({
  modelId: 'flux2-klein-4b',
  mode: IMAGE_GEN_MODE.LOCAL,
  width: 768,
  height: 512,
  steps: '',
  seed: '',
});

// Resolve the per-scene render config. When the user hasn't pinned a Writers
// Room mode, prefer Codex if enabled — cloud models render storyboard scenes
// more reliably than local diffusion when both are available. If the stored
// mode points at a backend that's no longer available (codex disabled, local
// pythonPath cleared), fall back to the first available backend so the form
// always reflects something that will actually run.
export function readWrImageSettings(settings, availableBackends = null) {
  const stored = settings?.writersRoom?.imageGen || {};
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const defaultMode = codexEnabled ? IMAGE_GEN_MODE.CODEX : WR_IMAGE_DEFAULTS.mode;
  let mode = stored.mode || defaultMode;
  if (Array.isArray(availableBackends) && availableBackends.length > 0
      && !availableBackends.some((b) => b.id === mode)) {
    mode = availableBackends[0].id;
  }
  return {
    modelId: stored.modelId || WR_IMAGE_DEFAULTS.modelId,
    mode,
    width: Number.isFinite(stored.width) ? stored.width : WR_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : WR_IMAGE_DEFAULTS.height,
    steps: stored.steps != null && stored.steps !== '' ? String(stored.steps) : '',
    seed: stored.seed != null && stored.seed !== '' ? String(stored.seed) : '',
  };
}
