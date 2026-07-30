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
});

export const RENDER_TARGETS = Object.freeze(Object.values(RENDER_TARGET));

// The "no pin — fall through to the install default" sentinel, matching the
// creative-commission `RENDER_BACKEND_AUTO` convention (an absent/null entry
// means the same thing; the explicit value exists so a UI select can round-trip
// the choice).
export const RENDER_TARGET_BACKEND_AUTO = 'auto';
