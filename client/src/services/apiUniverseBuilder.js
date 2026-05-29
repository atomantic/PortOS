import { request } from './apiCore.js';

export const WORLD_CATEGORIES = ['landscapes', 'environments', 'structures', 'vehicles'];
export const WORLD_CATEGORY_KEY_MAX = 64;
export const COMPOSITE_PROMPT_MAX = 4000;
// Mirror of the bible-field caps in server/services/universeBuilder.js — used by
// the Universe Builder + Pipeline forms for maxLength enforcement on inputs.
export const WORLD_LOGLINE_MAX = 500;
export const WORLD_PREMISE_MAX = 4000;
export const WORLD_STYLE_NOTES_MAX = 4000;
// Mirror of INFLUENCE_ENTRY_MAX + INFLUENCES_PER_LIST_MAX in
// server/services/universeBuilder.js — used by the chip editor for maxLength
// enforcement and to bound paste-floods of refs.
export const WORLD_INFLUENCE_ENTRY_MAX = 120;
export const WORLD_INFLUENCES_PER_LIST_MAX = 30;

// `options` lets a caller that owns its own error toast pass `{ silent: true }`
// so request() doesn't also toast — see CLAUDE.md "Custom catch ⇒ silent: true".
export const listUniverses = (options = {}) => request('/universe-builder', options);
export const getUniverse = (id, options = {}) => request(`/universe-builder/${encodeURIComponent(id)}`, options);

export const createUniverse = (data) => request('/universe-builder', {
  method: 'POST',
  body: JSON.stringify(data),
});

export const updateUniverse = (id, patch, options = {}) => request(`/universe-builder/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
  ...options,
});

// `options` lets callers that own their own error toast (a custom `.catch`)
// pass `{ silent: true }` so the request() helper doesn't also toast — see
// CLAUDE.md "Custom catch ⇒ silent: true". Mirrors updateUniverse's signature.
export const deleteUniverse = (id, options = {}) => request(`/universe-builder/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  ...options,
});

export const expandUniverse = ({
  starterPrompt, influences,
  preservedVariations, preservedCompositeSheets,
  logline, premise, styleNotes,
  locked,
  providerId, model,
} = {}) => request('/universe-builder/expand', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, influences,
    preservedVariations, preservedCompositeSheets,
    logline, premise, styleNotes,
    locked,
    providerId, model,
  }),
});

// Caller should dedupe the returned variations against its local list before
// appending — the local list may have changed during the request.
export const generateCategoryVariations = ({
  category, count, existingLabels,
  influences,
  logline, premise, styleNotes,
  providerId, model,
} = {}, options = {}) => request('/universe-builder/generate-variations', {
  method: 'POST',
  body: JSON.stringify({
    category, count, existingLabels,
    influences,
    logline, premise, styleNotes,
    providerId, model,
  }),
  ...options,
});

export const refineWorldPrompts = ({
  starterPrompt,
  logline, premise, styleNotes,
  influences,
  // Post-Expand structure — when provided, the server sees the full world and
  // may edit/replace/add categories + composites alongside the bible refine.
  // Omit (or pass empty/falsy) to get the bible-only behavior.
  categories, compositeSheets,
  locked,
  feedback, providerId, model,
} = {}) => request('/universe-builder/refine-prompts', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt,
    logline, premise, styleNotes,
    influences,
    ...(categories && Object.keys(categories).length ? { categories } : {}),
    ...(Array.isArray(compositeSheets) && compositeSheets.length ? { compositeSheets } : {}),
    locked,
    feedback, providerId, model,
  }),
});

// Mirror of LOCKABLE_FIELDS in server/services/universeBuilder.js — the lock UI
// iterates this so a new lockable field only needs adding in two places.
export const WORLD_LOCKABLE_FIELDS = [
  'starterPrompt',
  'logline',
  'premise',
  'styleNotes',
  'influencesEmbrace',
  'influencesAvoid',
];

// Mirror of `normalizeLabelKey` in server/services/universeBuilder.js — used for
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
// Mirrors the server-side mergeInfluencesWithLocks in universeBuilder.js.
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

export const renderWorld = (id, options) => request(`/universe-builder/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  body: JSON.stringify(options || {}),
});

export const listWorldRuns = (id) => request(`/universe-builder/${encodeURIComponent(id)}/runs`);

// ---- Canon (Phase A) ----

// Extract characters/settings/objects from a prose corpus into the universe's
// canon arrays. The corpus is usually an issue's prose stage output but can
// be anything text-shaped.
export const extractUniverseCanon = (universeId, { corpus, kinds, parallel, providerOverride } = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/extract-canon`, {
    method: 'POST',
    body: JSON.stringify({ corpus, kinds, parallel, providerOverride }),
  });

export const refineUniverseCharacter = (universeId, entryId, { providerId, model } = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/refine`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
  });

// One LLM call fills BLANK extended character fields (pronouns / age / stats /
// motivations / colorPalette / expressions / hand gestures / ...). No-clobber
// on populated fields. Locked characters return `{ locked: true }` instead of
// a 4xx — the UI surfaces this as a "Locked" badge.
export const expandUniverseCharacter = (universeId, entryId, { providerId, model } = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/expand`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
  });

// Catalog of every registered reference-sheet variant. The panel iterates
// this on mount to render one row per variant. New variants light up
// automatically once they're registered in the server-side SHEET_VARIANTS.
export const fetchReferenceSheetVariants = (options = {}) =>
  request('/universe-builder/reference-sheet-variants', options);

// Kick off a character reference sheet render. `variant` selects which
// registered style to render (defaults server-side to 'standard'); the server
// stamps the resulting filename into the matching pointer slot
// (`referenceSheetImageRef` for legacy 'standard', `referenceSheets[<id>]`
// for everything else). Returns `{ jobId, generationId, variant, ... }`.
export const renderCharacterReferenceSheet = (universeId, entryId, {
  variant, overridePrompt, overrideNegativePrompt, modelId,
} = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/render-reference-sheet`, {
    method: 'POST',
    body: JSON.stringify({ variant, overridePrompt, overrideNegativePrompt, modelId }),
  });

// Delete the character's reference sheet of the given variant. Variant
// defaults server-side to 'standard'. Returns `{ filename, fileDeleted, cleared }`.
export const deleteCharacterReferenceSheet = (universeId, entryId, { variant, ...requestOpts } = {}) => {
  const qs = variant ? `?variant=${encodeURIComponent(variant)}` : '';
  return request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/reference-sheet${qs}`, {
    method: 'DELETE',
    ...requestOpts,
  });
};

// Cast-wide differentiate — single LLM call rewrites every character so the
// whole cast has no visually-colliding pairs.
export const differentiateUniverseCast = (universeId, { providerId, model } = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/differentiate-cast`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
  });

// Cross-reference: where each canon entry appears across the universe's
// linked series. Returns `{ characters: { [entryId]: [{seriesId, seriesName,
// issueIds, issueCount}] }, settings: ..., objects: ..., seriesCount,
// issueCount }`. Read-only aggregation.
export const getUniverseCanonUsage = (universeId) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon-usage`);

// Thin lookup: every series that links to this universe as `[{ id, name }]`.
// Use this when only the seriesId → seriesName mapping is needed — the full
// /canon-usage endpoint also runs prose-matching scans across every issue.
export const getUniverseSeriesNames = (universeId) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/series-names`);

// Toggle the `locked` flag on a single canon entry. Locked entries are
// protected from AI rewrite paths (refine returns 409; differentiate skips
// them at apply time; re-extract appends evidence only). `kind` must be
// 'character' | 'setting' | 'object' (the singular BIBLE_KIND values).
export const setUniverseCanonLock = (universeId, kind, entryId, locked) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/${encodeURIComponent(entryId)}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked }),
  });

// Bulk lock/unlock every canon entry of a single kind. Returns
// `{ universe, kind, locked, changed, total }`.
export const setUniverseCanonLockAll = (universeId, kind, locked) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/lock-all`, {
    method: 'PATCH',
    body: JSON.stringify({ locked }),
  });

// Bulk lock/unlock variations across one bucket (`category`) or every bucket
// (`category: null`). Pass `includeSheets: true` to also flip composite
// sheets in the same call.
export const setUniverseVariationsLockAll = (universeId, { locked, category = null, includeSheets = false } = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/variations/lock-all`, {
    method: 'PATCH',
    body: JSON.stringify({ locked, category, includeSheets }),
  });

// Promote a category variation into a full canon entry. `targetKind` is
// required only when the source bucket's `kind` is 'other' (otherwise the
// server derives it from the bucket). Pass `{ silent: true }` in `options`
// when the caller owns its own error toast (per CLAUDE.md).
export const promoteVariationToCanon = (universeId, {
  category, label, targetKind, providerId, model,
} = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/promote-variation`, {
    method: 'POST',
    body: JSON.stringify({ category, label, targetKind, providerId, model }),
    ...options,
  });

// Bulk-classify every `kind: 'other'` bucket on a universe. Server returns
// `{ universe, results: [{ sourceKey, kind, suggestedKey? }], llm, runId }`.
// Pass `{ silent: true }` when the caller owns its own error toast.
export const autoSortBuckets = (universeId, { providerId, model } = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/auto-sort`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
    ...options,
  });
