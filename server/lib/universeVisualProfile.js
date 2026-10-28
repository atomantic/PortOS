import { FILM_LOOK_CONTROLS, filmLookPreset, normalizeFilmLook } from './filmLook.js';

export const VISUAL_PROFILE_TEXT_MAX = 2000;
export const PHOTOGRAPHY_FIELDS = Object.freeze([
  { id: 'lighting', label: 'Lighting' },
  { id: 'optics', label: 'Camera and optics' },
  { id: 'materials', label: 'Skin and materials' },
]);

/** Canonical optional record; null means explicitly disabled, absent inherits. */
export function normalizeUniverseVisualProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) return null;
  const generation = input.generation || {};
  const finishing = input.finishing || {};
  const texts = [...PHOTOGRAPHY_FIELDS.map(f => f.id), 'avoid'];
  if (texts.some(key => generation[key] !== undefined && (typeof generation[key] !== 'string' || generation[key].length > VISUAL_PROFILE_TEXT_MAX))) return null;
  if (!['off', 'preview', 'save'].includes(finishing.mode ?? 'off')) return null;
  const look = normalizeFilmLook(finishing.look);
  if (finishing.look != null && !look) return null;
  const amount = key => finishing[key] === undefined ? 1 : finishing[key];
  if (['colorAmount', 'textureAmount'].some(key => !Number.isFinite(amount(key)) || amount(key) < 0 || amount(key) > 1)) return null;
  return {
    version: 1,
    generation: { enabled: generation.enabled === true, ...Object.fromEntries(texts.map(key => [key, generation[key] || ''])) },
    finishing: { mode: finishing.mode || 'off', look, colorAmount: amount('colorAmount'), textureAmount: amount('textureAmount') },
  };
}

export function naturalUniverseVisualProfile() {
  return normalizeUniverseVisualProfile({ version: 1,
    generation: {
      enabled: true,
      lighting: 'Motivated available light from windows, sky and practical fixtures; directional falloff, unfilled shadow depth and restrained specular highlights. Preserve believable exposure and mixed color temperatures when motivated.',
      optics: 'Observed 35mm photography with natural perspective and readable optical detail. Very subtle lens diffusion; no deliberate missed focus. Generate a clean ungraded image without baked grain, scratches or light leaks.',
      materials: 'Natural skin texture, fine hair, asymmetry and age-specific detail; lived-in clothing and physically plausible materials. Candid human behavior and understated photographic color.',
      avoid: 'studio beauty lighting, pervasive fill light, unmotivated rim lights, glossy advertising treatment, beauty retouching, waxy skin, synthetic HDR clarity, excessive sharpening',
    },
    finishing: { mode: 'preview', look: filmLookPreset('natural-35mm'), colorAmount: 1, textureAmount: 1 },
  });
}

/** True when the profile adds photography direction to image prompts (a photoreal universe). */
export function isPhotographicVisualProfile(input) {
  return normalizeUniverseVisualProfile(input)?.generation.enabled === true;
}

export function visualProfileAdditions(input) {
  const profile = normalizeUniverseVisualProfile(input);
  if (!profile?.generation.enabled) return [];
  return PHOTOGRAPHY_FIELDS.filter(field => profile.generation[field.id]).map(field => ({
    id: `universe-photography-${field.id}`, label: `Universe photography · ${field.label}`, text: profile.generation[field.id],
  }));
}

export function visualProfileLook(input) {
  const profile = normalizeUniverseVisualProfile(input);
  if (!profile || profile.finishing.mode === 'off' || !profile.finishing.look) return null;
  const values = { ...profile.finishing.look };
  for (const control of FILM_LOOK_CONTROLS) {
    if (!control.type && !control.modifier) values[control.id] *= profile.finishing[control.group === 'color' ? 'colorAmount' : 'textureAmount'];
  }
  return normalizeFilmLook(values);
}

export function resolveUniverseVisualProfile(universe, override, series = null) {
  if (override === undefined && series?.stylePromptOverrideMode === 'override' && series.stylePromptOverride?.trim()) return null;
  return normalizeUniverseVisualProfile(override === undefined ? universe?.visualProfile : override);
}
