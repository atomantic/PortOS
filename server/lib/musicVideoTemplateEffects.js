/** Built-in layered-template additions, separate from chosen shot effects and film looks. */
export const TEMPLATE_EFFECT_CONTROLS = Object.freeze([
  { id: 'beatReaction', label: 'Beat reaction', default: 1 },
  { id: 'stillMotion', label: 'Still zoom and pan', default: 1 },
  { id: 'footagePush', label: 'Footage push', default: 1 },
  { id: 'grain', label: 'Template grain', default: 0.09 },
  { id: 'vignette', label: 'Template vignette', default: 0.5 },
]);

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

/** The native player cannot draw beat pulses/glitch strips; use the document renderer when they can be visible. */
export function hasTemplateBeatReaction(project) {
  const analysis = project.audioAnalysis;
  if (!(analysis?.beats?.length || analysis?.downbeats?.length)) return false;
  if (!analysis?.features?.envelopes?.rms?.some(level => level > 0)) return false;
  return (project.scenes || []).some(scene => templateEffects(project, scene).beatReaction > 0);
}
