/**
 * Layered-template addition controls, sparse normalization and per-shot inheritance.
 */

/** Built-in layered-template additions, separate from chosen shot effects and film looks.
 * `default` preserves legacy rendering when older saved records omit `templateEffects`. */
export const TEMPLATE_EFFECT_CONTROLS = Object.freeze([
  { id: 'beatReaction', label: 'Beat reaction', default: 1 },
  { id: 'stillMotion', label: 'Still zoom and pan', default: 1 },
  { id: 'footagePush', label: 'Footage push', default: 1 },
  { id: 'grain', label: 'Template grain', default: 0.09 },
  { id: 'vignette', label: 'Template vignette', default: 0.5 },
  // A person holding the camera (lib/handheldCamera.js): unsteady hands, and walking. Off unless asked for.
  { id: 'handheld', label: 'Handheld shake', default: 0 },
  { id: 'handheldSteps', label: 'Handheld footsteps', default: 0 },
]);

/** Restrained template-addition defaults stamped onto newly created music videos so
 * built-in beat/push/grain/vignette overlays stay out of generated footage's way. */
export const DEFAULT_NEW_PROJECT_TEMPLATE_EFFECTS = Object.freeze({
  beatReaction: 0,
  stillMotion: 0.4,
  footagePush: 0,
  grain: 0.05,
  vignette: 0.16,
});

/** A sparse record: omitted/null fields inherit; a numeric zero explicitly turns an addition off. */
export function normalizeTemplateEffects(value) {
  if (!value || typeof value !== 'object') return null;
  const entries = TEMPLATE_EFFECT_CONTROLS.filter(({ id }) => Number.isFinite(value[id]))
    .map(({ id }) => [id, Math.max(0, Math.min(1, value[id]))]);
  return entries.length ? Object.fromEntries(entries) : null;
}

export function templateEffects(project, scene) {
  return Object.fromEntries(TEMPLATE_EFFECT_CONTROLS.map(({ id, default: fallback }) => [id,
    Math.max(0, Math.min(1, scene?.templateEffects?.[id] ?? project?.templateEffects?.[id] ?? fallback)),
  ]));
}

/** Older native playback responses have no drawing data; keep their visible beat reactions on the worker. */
export function hasTemplateBeatReaction(project) {
  const analysis = project.audioAnalysis;
  if (!(analysis?.beats?.length || analysis?.downbeats?.length)) return false;
  if (!analysis?.features?.envelopes?.rms?.some(level => level > 0)) return false;
  return (project.scenes || []).some(scene => templateEffects(project, scene).beatReaction > 0);
}
