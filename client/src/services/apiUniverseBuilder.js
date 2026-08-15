import { request } from './apiCore.js';

export const WORLD_CATEGORIES = ['landscapes', 'environments', 'structures', 'vehicles'];
export const WORLD_CATEGORY_KEY_MAX = 64;
export const COMPOSITE_PROMPT_MAX = 4000;
// Mirror of the bible-field caps in server/services/universeBuilder.js — used by
// the Universe Builder + Pipeline forms for maxLength enforcement on inputs.
export const WORLD_LOGLINE_MAX = 500;
export const WORLD_PREMISE_MAX = 20000;
export const WORLD_STYLE_NOTES_MAX = 4000;
// Mirror of INFLUENCE_ENTRY_MAX + INFLUENCES_PER_LIST_MAX in
// server/services/universeBuilder.js — used by the chip editor for maxLength
// enforcement and to bound paste-floods of refs.
export const WORLD_INFLUENCE_ENTRY_MAX = 120;
export const WORLD_INFLUENCES_PER_LIST_MAX = 30;
export const WORLD_STYLE_REFERENCES_MAX = 20;

// `options` lets a caller that owns its own error toast pass `{ silent: true }`
// so request() doesn't also toast — see CLAUDE.md "Custom catch ⇒ silent: true".
export const listUniverses = (options = {}) => request('/universe-builder', options);
export const getUniverse = (id, options = {}) => request(`/universe-builder/${encodeURIComponent(id)}`, options);

// `[{ id, name, influences: { embrace[], avoid[] } }]` for every live universe
// that has style tokens. Use this instead of `listUniverses()` whenever a
// surface only needs to layer a universe's look onto a prompt — the full list
// ships every canon bible and category.
export const listUniverseStyles = (options = {}) => request('/universe-builder/styles', options);

export const createUniverse = (data, options = {}) => request('/universe-builder', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
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

// Add / remove ONE art style reference — deltas, not a wholesale array replace
// (see `addStyleReference` in server/services/universeBuilder/crud.js for why).
// Both resolve with the full updated universe. `adopt` is
// `{ styleNotes, influences }` when the user chose "Adopt style + add"; the
// server writes it in the same queued write as the reference.
export const addUniverseStyleReference = (id, { reference, adopt } = {}, options = {}) => request(
  `/universe-builder/${encodeURIComponent(id)}/style-references`,
  { method: 'POST', body: JSON.stringify({ reference, ...(adopt ? { adopt } : {}) }), ...options },
);

export const removeUniverseStyleReference = (id, referenceId, options = {}) => request(
  `/universe-builder/${encodeURIComponent(id)}/style-references/${encodeURIComponent(referenceId)}`,
  { method: 'DELETE', ...options },
);

// Adopt a proposed style guide with no reference record attached (#4188
// Phase 4 — mood-board synthesis). Server-side queued write; locks are
// re-checked against the freshest persisted record. Resolves with the full
// updated universe.
export const adoptUniverseStyleGuide = (id, { styleNotes, influences } = {}, options = {}) => request(
  `/universe-builder/${encodeURIComponent(id)}/adopt-style`,
  { method: 'POST', body: JSON.stringify({ styleNotes, influences }), ...options },
);

export const expandUniverse = ({
  starterPrompt, influences,
  preservedVariations, preservedCompositeSheets,
  logline, premise, styleNotes,
  locked,
  providerId, model,
} = {}, options = {}) => request('/universe-builder/expand', {
  method: 'POST',
  body: JSON.stringify({
    starterPrompt, influences,
    preservedVariations, preservedCompositeSheets,
    logline, premise, styleNotes,
    locked,
    providerId, model,
  }),
  ...options,
});

// Vision-to-prose: turn reference image(s) into an image-gen-ready prose
// description for a canon entry. `images` is `[{ source: 'upload'|'gallery',
// filename }]` — uploads were POSTed via uploadScreenshot(); gallery items are
// generated-gallery filenames. Multiple images → the model returns the
// description common to all of them. `providerId`/`model` pick the
// (API/vision-capable) provider on demand. Resolves to `{ description, llm }`.
export const describeEntityFromImages = ({
  kind, name, context, images, providerId, model,
} = {}, options = {}) => request('/universe-builder/describe-from-images', {
  method: 'POST',
  body: JSON.stringify({ kind, name, context, images, providerId, model }),
  ...options,
});

// Analyze one peer-syncable gallery image as a universe-bible art reference.
// Returns a proposed reference plus a before/after style-guidance diff; this
// endpoint is review-only and does not mutate the universe.
export const analyzeUniverseStyleReference = ({
  image, title, prompt, styleNotes, influences, locked, providerId, model,
} = {}, options = {}) => request('/universe-builder/analyze-style-reference', {
  method: 'POST',
  body: JSON.stringify({
    image, title, prompt, styleNotes, influences, locked, providerId, model,
  }),
  ...options,
});

// Vision-driven structured expand (characters only): a vision model reads
// reference image(s) and PROPOSES values for the character's still-blank
// structured fields. Review-only — resolves to `{ fields, updatedFields, llm }`
// (or `{ locked: true }`); the caller applies the kept/edited values via the
// normal entry patch. `images` shape matches describeEntityFromImages.
export const expandEntityFromImages = (universeId, entryId, {
  name, context, images, providerId, model,
} = {}, options = {}) => request(
  `/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/expand-from-images`,
  {
    method: 'POST',
    body: JSON.stringify({ name, context, images, providerId, model }),
    ...options,
  },
);

// Corrective vision analysis for ONE canon entry: given the entry's current
// descriptor text as context, a vision model proposes a CORRECTED
// replacement (unlike expandEntityFromImages, which only fills still-blank
// fields). Review-only — resolves to `{ descField, currentDescription,
// proposedDescription, llm, imageFilename }` (or `{ locked: true, entryName }`);
// `applyCanonImageCorrection` persists the reviewed text and pins the image.
export const correctEntityFromImage = (universeId, kind, entryId, {
  image, name, context, providerId, model,
} = {}, options = {}) => request(
  `/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/${encodeURIComponent(entryId)}/correct-from-image`,
  {
    method: 'POST',
    body: JSON.stringify({ image, name, context, providerId, model }),
    ...options,
  },
);

// Persist a reviewed corrective-image analysis: overwrites the entry's
// descriptor field with `description` AND pins `imageFilename` as the
// entry's `primaryImageRef` in one atomic write.
export const applyCanonImageCorrection = (universeId, kind, entryId, {
  description, imageFilename,
} = {}, options = {}) => request(
  `/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/${encodeURIComponent(entryId)}/apply-image-correction`,
  {
    method: 'POST',
    body: JSON.stringify({ description, imageFilename }),
    ...options,
  },
);

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
  // Optional gallery filename used as a visual style reference. When present the
  // server forces a vision-capable API provider.
  image,
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
    ...(image ? { image } : {}),
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

export const renderWorld = (id, options, reqOptions = {}) => request(`/universe-builder/${encodeURIComponent(id)}/render`, {
  method: 'POST',
  body: JSON.stringify(options || {}),
  ...reqOptions,
});

export const listWorldRuns = (id) => request(`/universe-builder/${encodeURIComponent(id)}/runs`);

// ---- Canon (Phase A) ----

// Extract characters/settings/objects from a prose corpus into the universe's
// canon arrays. The corpus is usually an issue's prose stage output but can
// be anything text-shaped.
export const extractUniverseCanon = (universeId, { corpus, kinds, parallel, providerOverride } = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/extract-canon`, {
    method: 'POST',
    body: JSON.stringify({ corpus, kinds, parallel, providerOverride }),
    ...options,
  });

export const refineUniverseCharacter = (universeId, entryId, { providerId, model } = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/refine`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
    ...options,
  });

// One LLM call fills BLANK extended character fields (pronouns / age / stats /
// motivations / colorPalette / expressions / hand gestures / ...). No-clobber
// on populated fields. Locked characters return `{ locked: true }` instead of
// a 4xx — the UI surfaces this as a "Locked" badge.
export const expandUniverseCharacter = (universeId, entryId, { providerId, model } = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/expand`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
    ...options,
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
} = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/${encodeURIComponent(entryId)}/render-reference-sheet`, {
    method: 'POST',
    body: JSON.stringify({ variant, overridePrompt, overrideNegativePrompt, modelId }),
    ...options,
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
export const differentiateUniverseCast = (universeId, { providerId, model } = {}, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/characters/differentiate-cast`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
    ...options,
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
// 'character' | 'place' | 'object' (the singular BIBLE_KIND values).
export const setUniverseCanonLock = (universeId, kind, entryId, locked, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/${encodeURIComponent(entryId)}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ locked }),
    ...options,
  });

// Remove one canon entry from its universe bucket. Returns
// `{ universe, entry }`. Scoped to the canon array ONLY — the entry's rendered
// images / reference sheets stay in the gallery and the shared Catalog
// ingredient it may point at is left untouched.
export const removeUniverseCanonEntry = (universeId, kind, entryId, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    ...options,
  });

// Bulk lock/unlock every canon entry of a single kind. Returns
// `{ universe, kind, locked, changed, total }`.
export const setUniverseCanonLockAll = (universeId, kind, locked, options = {}) =>
  request(`/universe-builder/${encodeURIComponent(universeId)}/canon/${encodeURIComponent(kind)}/lock-all`, {
    method: 'PATCH',
    body: JSON.stringify({ locked }),
    ...options,
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
