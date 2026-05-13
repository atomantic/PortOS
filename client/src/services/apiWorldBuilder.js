import { request } from './apiCore.js';

export const WORLD_CATEGORIES = ['landscapes', 'environments', 'characters', 'structures', 'vehicles'];
export const WORLD_CATEGORY_KEY_MAX = 64;
export const COMPOSITE_PROMPT_MAX = 4000;
// Mirror of the bible-field caps in server/services/worldBuilder.js — used by
// the World Builder + Pipeline forms for maxLength enforcement on inputs.
export const WORLD_LOGLINE_MAX = 500;
export const WORLD_PREMISE_MAX = 4000;
export const WORLD_STYLE_NOTES_MAX = 4000;
// Mirror of INFLUENCE_ENTRY_MAX + INFLUENCES_PER_LIST_MAX in
// server/services/worldBuilder.js — used by the chip editor for maxLength
// enforcement and to bound paste-floods of refs.
export const WORLD_INFLUENCE_ENTRY_MAX = 120;
export const WORLD_INFLUENCES_PER_LIST_MAX = 30;

export const listWorlds = () => request('/world-builder');
export const getWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`);

export const createWorld = (data) => request('/world-builder', {
  method: 'POST',
  body: JSON.stringify(data),
});

export const updateWorld = (id, patch) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});

export const deleteWorld = (id) => request(`/world-builder/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

export const expandWorld = ({
  starterPrompt, influences,
  preservedVariations, preservedCompositeSheets,
  logline, premise, styleNotes, stylePrompt, negativePrompt,
  locked,
  providerId, model,
} = {}) => request('/world-builder/expand', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, influences,
    preservedVariations, preservedCompositeSheets,
    logline, premise, styleNotes, stylePrompt, negativePrompt,
    locked,
    providerId, model,
  }),
});

export const refineWorldPrompts = ({
  starterPrompt, stylePrompt, negativePrompt,
  logline, premise, styleNotes,
  influences,
  // Post-Expand structure — when provided, the server sees the full world and
  // may edit/replace/add categories + composites alongside the bible refine.
  // Omit (or pass empty/falsy) to get the bible-only behavior.
  categories, compositeSheets,
  locked,
  feedback, providerId, model,
} = {}) => request('/world-builder/refine-prompts', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, stylePrompt, negativePrompt,
    logline, premise, styleNotes,
    influences,
    ...(categories && Object.keys(categories).length ? { categories } : {}),
    ...(Array.isArray(compositeSheets) && compositeSheets.length ? { compositeSheets } : {}),
    locked,
    feedback, providerId, model,
  }),
});

// Mirror of LOCKABLE_FIELDS in server/services/worldBuilder.js — the lock UI
// iterates this so a new lockable field only needs adding in two places.
export const WORLD_LOCKABLE_FIELDS = [
  'starterPrompt',
  'stylePrompt',
  'negativePrompt',
  'logline',
  'premise',
  'styleNotes',
  'influencesEmbrace',
  'influencesAvoid',
];

// Mirror of `normalizeLabelKey` in server/services/worldBuilder.js — used for
// case-insensitive identity matching between original and refined items.
export const normalizeLabelKey = (label) =>
  typeof label === 'string' ? label.trim().toLowerCase() : '';

// Coerce whatever shape the server / draft / patch hands us into a strict
// `{ embrace: [], avoid: [] }` so consumers never have to guard undefined.
// Fast-path: if the input is already shape-correct, return it unchanged so
// downstream React refs stay stable (avoids per-render object churn that
// would invalidate memoized children).
export const ensureInfluences = (raw) => {
  if (raw && Array.isArray(raw.embrace) && Array.isArray(raw.avoid)) return raw;
  return {
    embrace: Array.isArray(raw?.embrace) ? raw.embrace : [],
    avoid: Array.isArray(raw?.avoid) ? raw.avoid : [],
  };
};

// Lockable lock-map keys that target one of the two influence sub-lists
// (embrace + avoid). Use this instead of `.startsWith('influences')` so a
// future LOCKABLE_FIELDS entry like `influencesPriority` doesn't get silently
// swept into per-list handling.
export const WORLD_INFLUENCE_LOCK_FIELDS = ['influencesEmbrace', 'influencesAvoid'];
export const isInfluenceLockField = (key) => WORLD_INFLUENCE_LOCK_FIELDS.includes(key);

// Build a refined influences object that honors per-list locks. Locked lists
// take their value from `fallback` (the user's current draft / originals);
// unlocked lists take from `fresh` (the LLM output), falling back to
// `fallback` only when the LLM omitted that list (key absent). An explicit
// `[]` is applied so the user can intentionally clear an unlocked list.
// Mirrors the server-side mergeInfluencesWithLocks in worldBuilder.js.
export const mergeInfluencesWithLocks = (locked, fresh, fallback) => {
  const freshSafe = ensureInfluences(fresh);
  const fallbackSafe = ensureInfluences(fallback);
  const freshHasEmbrace = Array.isArray(fresh?.embrace);
  const freshHasAvoid = Array.isArray(fresh?.avoid);
  return {
    embrace: locked?.influencesEmbrace
      ? fallbackSafe.embrace
      : (freshHasEmbrace ? freshSafe.embrace : fallbackSafe.embrace),
    avoid: locked?.influencesAvoid
      ? fallbackSafe.avoid
      : (freshHasAvoid ? freshSafe.avoid : fallbackSafe.avoid),
  };
};

export const renderWorld = (id, options) => request(`/world-builder/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  body: JSON.stringify(options || {}),
});

export const listWorldRuns = (id) => request(`/world-builder/${encodeURIComponent(id)}/runs`);
