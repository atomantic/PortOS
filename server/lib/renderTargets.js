/**
 * Render-target alphabet (#3231 Phase 2).
 *
 * A render target names one creative surface that enqueues image (or video)
 * renders — the key into `settings.renderDefaults`, where the user pins an
 * install-wide default backend + model per surface ("Universe Bible renders
 * on Codex; Music Video renders on Agy") without touching the global
 * `settings.imageGen.mode`.
 *
 * Deliberately a dependency-free leaf so `lib/validation.js`, the Settings
 * UI, and every surface resolver derive from ONE enumerable alphabet instead
 * of hand-copying strings. Adding a surface = one entry here + a
 * `resolveRenderTargetConfig(settings, RENDER_TARGET.X, …)` call at the
 * surface's enqueue site (see imageGen/cloudProviderConfig.js) — the guard
 * test in services/imageGen/renderTargets.guard.test.js fails any surface
 * that reaches for resolveCloudProviderConfig directly.
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
});

export const RENDER_TARGETS = Object.freeze(Object.values(RENDER_TARGET));

// The "no pin — fall through to the install default" sentinel, matching the
// creative-commission `RENDER_BACKEND_AUTO` convention (an absent/null entry
// means the same thing; the explicit value exists so a UI select can round-trip
// the choice).
export const RENDER_TARGET_BACKEND_AUTO = 'auto';

// Max length for a persisted per-record model-id pin — matches the
// creative-commission `COMMISSION_RENDER_MODEL_MAX` convention.
export const RECORD_RENDER_MODEL_MAX = 64;

// The ONE normalization rule for render-pin values, shared by the per-record
// pin below and the settings-registry reader (renderTargetDefaults in
// imageGen/cloudProviderConfig.js): trim; the `'auto'` sentinel and blank
// strings collapse to null ("no pin — fall through").
export const normalizeRenderPinValue = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== RENDER_TARGET_BACKEND_AUTO ? s : null;
};

/**
 * Normalize a record's persisted render pin (#3231 Phase 3 — the flat
 * `imageMode` / `imageModelId` field pair on universe / series / sprite
 * records, following the creative-commission shape). The `'auto'` sentinel,
 * blank strings, and absent fields all collapse to null ("no pin"), so
 * callers can hand the result straight to `resolveRenderTargetConfig`'s
 * `recordMode` / `recordModel` options without re-checking sentinels. The
 * model id is capped here so every record kind persists the same bounded
 * shape.
 */
export function recordRenderPin(record) {
  const modelId = normalizeRenderPinValue(record?.imageModelId);
  return {
    mode: normalizeRenderPinValue(record?.imageMode),
    modelId: modelId ? modelId.slice(0, RECORD_RENDER_MODEL_MAX) : null,
  };
}

/**
 * The persist-only-when-set spread for a record sanitizer (#3231 Phase 3) —
 * returns `{ imageMode?, imageModelId? }` with each key present only when a
 * real pin exists, so existing records keep their on-disk shape byte-stable.
 */
export function persistedRenderPinFields(raw) {
  const pin = recordRenderPin(raw);
  return {
    ...(pin.mode ? { imageMode: pin.mode } : {}),
    ...(pin.modelId ? { imageModelId: pin.modelId } : {}),
  };
}
