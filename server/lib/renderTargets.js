/**
 * Render-target alphabet (#3231): the creative surfaces that enqueue renders, keyed into `settings.renderDefaults`.
 *
 * Render-target alphabet (#3231): `RENDER_TARGET`/`RENDER_TARGETS` name every creative surface that enqueues image/video renders (universe-bible, sprite-reference, music-video, …), the keys into `settings.renderDefaults` where the user pins an install-wide default backend + model per surface
 * ("Universe Bible on Codex; Music Video on Agy") without touching the global `settings.imageGen.mode`, plus the `RENDER_TARGET_BACKEND_AUTO` sentinel. A dependency-free leaf so `lib/settingsValidation.js`, the Settings UI and every surface resolver derive from ONE alphabet; resolved by `services/imageGen/cloudProviderConfig.js#resolveRenderTargetConfig`.
 * Adding a surface = one entry here + a `resolveRenderTargetConfig(settings, RENDER_TARGET.X, …)` call at its enqueue site; `server/test/guards/modules/imageGenRenderTargets.test.js` fails any surface reaching for resolveCloudProviderConfig directly.
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

// The Settings → Image Gen → Defaults rows (re-exported by `client/src/lib/imageGenModes.js`): the surfaces whose default backend + model are pinnable via settings.renderDefaults. Only targets whose resolver is LIVE are listed — a pin nobody's resolver reads would be a control that silently does nothing.
// `renderTargets.test.js` fails a target that is neither listed nor in RENDER_TARGETS_WITHOUT_SETTINGS_ROW. Labels are the Settings-UI display names. `video: true` marks the targets whose VIDEO lane also consults `renderDefaults[target].videoMode` (#3231 Phase 4): music-video (scene clips + new-project backend seeding) and creative-agent (commission video steps). Video pins are backend-only — grok video has no model knob and local video models are picked on the surface itself, so no video-model control is offered anywhere.
export const RENDER_TARGET_OPTIONS = Object.freeze([
  { id: RENDER_TARGET.UNIVERSE_BIBLE, label: 'Universe Bible & canon renders' },
  { id: RENDER_TARGET.UNIVERSE_CHARACTER_SHEET, label: 'Universe character sheets' },
  { id: RENDER_TARGET.SERIES_FIRST_PASS, label: 'Series first-pass portraits & frames' },
  { id: RENDER_TARGET.SPRITE_REFERENCE, label: 'Sprite references & anchors' },
  { id: RENDER_TARGET.PIPELINE_VISUAL, label: 'Pipeline visuals (storyboards, comics, covers)' },
  { id: RENDER_TARGET.MUSIC_VIDEO, label: 'Music Video scene frames & clips', video: true },
  { id: RENDER_TARGET.LORA_DATASET, label: 'LoRA training datasets', retired: true },
  { id: RENDER_TARGET.CREATIVE_AGENT, label: 'Creative agent renders', video: true },
  { id: RENDER_TARGET.DECK, label: 'Deck card renders (playing cards & tarot)' },
]);

// Targets the Settings UI deliberately does NOT list. FableLoom production exposes per-run controls instead of a persistent Settings pin; its target exists so the service still goes through the shared resolver guard.
export const RENDER_TARGETS_WITHOUT_SETTINGS_ROW = Object.freeze([RENDER_TARGET.FABLELOOM_PRODUCTION]);

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
