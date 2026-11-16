/**
 * Render-target alphabet (#3231): the creative surfaces that enqueue renders, keyed into `settings.renderDefaults`.
 *
 * Render-target alphabet (#3231): `RENDER_TARGET`/`RENDER_TARGETS` name every creative surface that enqueues image/video renders (universe-bible, sprite-reference, music-video, …), the keys into `settings.renderDefaults` where the user pins an install-wide default backend + model per surface
 * ("Universe Bible on Codex; Music Video on Agy") without touching the global `settings.imageGen.mode`, plus the `RENDER_TARGET_BACKEND_AUTO` sentinel. A dependency-free leaf so `lib/validation.js`, the Settings UI and every surface resolver derive from ONE alphabet; resolved by `services/imageGen/cloudProviderConfig.js#resolveRenderTargetConfig`.
 * Adding a surface = one entry here + a `resolveRenderTargetConfig(settings, RENDER_TARGET.X, …)` call at its enqueue site; `services/imageGen/renderTargets.guard.test.js` fails any surface reaching for resolveCloudProviderConfig directly.
 */

export const RENDER_TARGET = Object.freeze({
  UNIVERSE_BIBLE: 'universe-bible',
  UNIVERSE_CHARACTER_SHEET: 'universe-character-sheet',
  SERIES_FIRST_PASS: 'series-first-pass',
  SPRITE_REFERENCE: 'sprite-reference',
  PIPELINE_VISUAL: 'pipeline-visual',
  MUSIC_VIDEO: 'music-video',
  LORA_DATASET: 'lora-dataset',
  CREATIVE_AGENT: 'creative-agent',
  FABLELOOM_PRODUCTION: 'fableloom-production',
  DECK: 'deck',
});

export const RENDER_TARGETS = Object.freeze(Object.values(RENDER_TARGET));

// The "no pin, fall through to the install default" sentinel (creative-commission `RENDER_BACKEND_AUTO` convention); an absent/null entry means the same, the explicit value lets a UI select round-trip it.
export const RENDER_TARGET_BACKEND_AUTO = 'auto';

// Max length for a persisted per-record model-id pin (creative-commission `COMMISSION_RENDER_MODEL_MAX` convention).
export const RECORD_RENDER_MODEL_MAX = 64;

// The ONE normalization rule for render-pin values, shared by the per-record pin and the settings-registry reader (renderTargetDefaults in imageGen/cloudProviderConfig.js): trim; `'auto'` and blank collapse to null ("no pin").
export const normalizeRenderPinValue = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== RENDER_TARGET_BACKEND_AUTO ? s : null;
};

/** Normalize a record's persisted render pin (#3231 Phase 3: the flat `imageMode` / `imageModelId` pair on universe / series / sprite records, the creative-commission shape): `'auto'`, blanks and absent fields collapse to null so callers hand the result to `resolveRenderTargetConfig`'s `recordMode` / `recordModel` without re-checking sentinels; the model id is capped so every record kind persists one bounded shape. */
export function recordRenderPin(record) {
  const modelId = normalizeRenderPinValue(record?.imageModelId);
  return {
    mode: normalizeRenderPinValue(record?.imageMode),
    modelId: modelId ? modelId.slice(0, RECORD_RENDER_MODEL_MAX) : null,
  };
}

/** The persist-only-when-set spread for a record sanitizer (#3231 Phase 3): `{ imageMode?, imageModelId? }` with each key present only for a real pin, so existing records stay byte-stable on disk. */
export function persistedRenderPinFields(raw) {
  const pin = recordRenderPin(raw);
  return {
    ...(pin.mode ? { imageMode: pin.mode } : {}),
    ...(pin.modelId ? { imageModelId: pin.modelId } : {}),
  };
}
