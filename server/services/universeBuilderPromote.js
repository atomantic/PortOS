/**
 * Universe Builder — promote a {label, prompt} variation into a full canon
 * entry (Phase D). The LLM expands the variation into a per-kind canon
 * record; the canon append + variation removal land in one `updateUniverse`
 * patch so the transition is atomic.
 */

import {
  getUniverse,
  updateUniverse,
  normalizeCategoryKey,
  buildUniverseStyleContext,
} from './universeBuilder.js';
import {
  sanitizeBibleList,
  stripCanonControlFields,
  findBibleEntryByName,
  normalizeSlugline,
  BIBLE_FIELD,
  BIBLE_SOURCE,
  BIBLE_LIMITS,
} from '../lib/storyBible.js';
import { ServerError } from '../lib/errorHandler.js';
import { extractJson as extractJsonShared } from '../lib/jsonExtract.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';

// Inverse of BIBLE_FIELD: trunk-name (canon array key) → singular BIBLE_KIND.
// Derived from the source-of-truth map so the two can't drift. `other` is
// intentionally absent — callers must pass `targetKind` to promote out of an
// unsorted bucket.
export const KIND_TO_BIBLE = Object.freeze(
  Object.fromEntries(Object.entries(BIBLE_FIELD).map(([kind, field]) => [field, kind])),
);

// Exported for the route's Zod enum so the schema and the resolver share
// one source of truth.
export const VALID_TARGET_KINDS = Object.freeze(Object.keys(KIND_TO_BIBLE));

const isCharacterShape = (o) =>
  o && typeof o === 'object' && typeof o.name === 'string';
const isPlaceShape = (o) =>
  o && typeof o === 'object' && (typeof o.name === 'string' || typeof o.slugline === 'string');
const isObjectShape = isCharacterShape;

const SHAPE_PREDICATE = {
  characters: isCharacterShape,
  places: isPlaceShape,
  objects: isObjectShape,
};

const buildPromotePrompt = ({
  targetKind,
  variation,
  category,
  universe,
}) => {
  const styleSection = buildUniverseStyleContext(universe, {
    headerSuffix: 'keep the new canon entry consistent with this established setting',
  });

  // Per-kind output contract. The sanitizer drops unknown fields, so
  // listing the field whitelist here is the LLM's only contract.
  let outputContract;
  if (targetKind === 'characters') {
    outputContract = `Return a SINGLE JSON object describing one CHARACTER (do NOT wrap it in an array). Required fields:
- name: string (max ${BIBLE_LIMITS.NAME_MAX} chars). The human name; default the variation label when no clearer name is implied.
- physicalDescription: string (max ${BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX} chars). What they look like — face, build, age range, distinguishing marks, signature attire.
- personality: string (max ${BIBLE_LIMITS.PERSONALITY_MAX} chars). Disposition, voice, defining traits.
- background: string (max ${BIBLE_LIMITS.BACKGROUND_MAX} chars). Where they come from, role in the world.
- role: string (max ${BIBLE_LIMITS.ROLE_MAX} chars). Their function in the story (protagonist / mentor / faction lead / etc).
- prompt: string (max ${BIBLE_LIMITS.PROMPT_MAX} chars). Render-prompt fragment for reference images — comma-separated tokens; do NOT repeat universe style tokens (they're prepended at render time).
- tags: array of 1-3 short labels (e.g. "protagonist", "antagonist", "supporting").`;
  } else if (targetKind === 'places') {
    outputContract = `Return a SINGLE JSON object describing one PLACE. Required fields:
- name: string (max ${BIBLE_LIMITS.NAME_MAX} chars). Human label like "Foundry City". Default the variation label when no clearer name is implied.
- slugline: string (max ${BIBLE_LIMITS.SLUGLINE_MAX} chars). Screenplay-style location header like "EXT. FOUNDRY CITY — DAY". Leave empty string when no obvious slugline applies.
- description: string (max ${BIBLE_LIMITS.PLACE_DESCRIPTION_MAX} chars). What the place looks like + feels like.
- palette: string (max ${BIBLE_LIMITS.PALETTE_MAX} chars). Dominant colors.
- era: string (max ${BIBLE_LIMITS.ERA_MAX} chars). Time period / technology level.
- weather: string (max ${BIBLE_LIMITS.WEATHER_MAX} chars). Typical conditions.
- recurringDetails: string (max ${BIBLE_LIMITS.RECURRING_DETAILS_MAX} chars). Recognizable motifs that recur across scenes.
- prompt: string (max ${BIBLE_LIMITS.PROMPT_MAX} chars). Render-prompt fragment — comma-separated tokens; do NOT repeat universe style tokens.
- tags: array of 1-3 short labels.`;
  } else {
    outputContract = `Return a SINGLE JSON object describing one OBJECT / prop / vehicle / artifact. Required fields:
- name: string (max ${BIBLE_LIMITS.NAME_MAX} chars). Default the variation label when no clearer name is implied.
- description: string (max ${BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX} chars). What it looks like + what it does.
- significance: string (max ${BIBLE_LIMITS.SIGNIFICANCE_MAX} chars). Why it matters to the story.
- prompt: string (max ${BIBLE_LIMITS.PROMPT_MAX} chars). Render-prompt fragment — comma-separated tokens; do NOT repeat universe style tokens.
- tags: array of 1-3 short labels.`;
  }

  return `You are a story-bible drafter for a comic/TV production pipeline. The user is promoting an exploratory variation from the "${category}" bucket into a first-class canon entry of kind "${targetKind}". Expand the variation into a fully fleshed canon record consistent with the universe.
${styleSection}
# Source variation
LABEL: ${variation.label}
PROMPT: ${variation.prompt}

# Output contract
${outputContract}

# Rules
- Output JUST the JSON object. NO markdown, NO commentary, NO array wrapper.
- Use empty strings for optional fields you can't honestly infer — do NOT invent backstory or motifs unsupported by the source variation + universe context.
- Stay tonally consistent with the LOGLINE / STYLE NOTES / EMBRACE INFLUENCES above when present.`;
};

// Find a canon entry that collides with `label` (and, for places, the
// slugline derived from `label` or `secondarySlug`). Run pre-LLM against
// the prompt-building snapshot AND post-LLM against the latest persisted
// canon — keeps the duplicate-detection logic in one place.
const findCanonCollision = (canon, label, targetKind, secondarySlug = '') => {
  const direct = findBibleEntryByName(canon, label);
  if (direct) return direct;
  if (targetKind !== 'places') return null;
  const needleSlug = normalizeSlugline(label);
  const secondary = normalizeSlugline(secondarySlug);
  if (!needleSlug && !secondary) return null;
  return canon.find((e) => {
    if (!e || typeof e !== 'object') return false;
    const eSlug = normalizeSlugline(e.slugline);
    const eName = normalizeSlugline(e.name);
    if (needleSlug && (eSlug === needleSlug || eName === needleSlug)) return true;
    if (secondary && (eSlug === secondary || eName === secondary)) return true;
    return false;
  }) || null;
};

const extractEntryJson = (raw, kind) => {
  if (!raw || typeof raw !== 'string') throw new Error('Empty LLM response');
  const predicate = SHAPE_PREDICATE[kind] || isCharacterShape;
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: predicate,
  });
  if (value !== undefined) return value;
  throw new ServerError(
    'LLM returned invalid JSON for variation promotion. Try a different model or rerun.',
    {
      status: 502,
      code: 'LLM_INVALID_JSON',
      context: {
        details: {
          reason: lastError?.message || 'no JSON object found',
          preview: lastPreview || '',
        },
      },
    },
  );
};


/**
 * Promote one variation from `universe.categories[category].variations[]`
 * into the corresponding canon trunk.
 *
 * @param {string} universeId
 * @param {object} options
 * @param {string} options.category — bucket key (case-insensitive)
 * @param {string} options.label — variation label (case-insensitive); the
 *   first matching variation in the bucket is promoted.
 * @param {'characters'|'places'|'objects'} [options.targetKind] — required
 *   when the source category's `kind` is 'other'; ignored otherwise.
 * @param {string} [options.providerId]
 * @param {string} [options.model]
 */
export async function promoteVariationToCanon(universeId, options = {}) {
  const {
    category: rawCategory,
    label: rawLabel,
    targetKind: rawTargetKind,
    providerId,
    model,
  } = options;
  const categoryKey = normalizeCategoryKey(rawCategory);
  if (!categoryKey) {
    throw new ServerError('promoteVariationToCanon: category is required', {
      status: 400, code: 'UNIVERSE_PROMOTE_NO_CATEGORY',
    });
  }
  if (typeof rawLabel !== 'string' || !rawLabel.trim()) {
    throw new ServerError('promoteVariationToCanon: label is required', {
      status: 400, code: 'UNIVERSE_PROMOTE_NO_LABEL',
    });
  }
  const universe = await getUniverse(universeId);
  const bucket = universe.categories?.[categoryKey];
  if (!bucket) {
    throw new ServerError(`Category "${categoryKey}" not found on universe`, {
      status: 404, code: 'UNIVERSE_PROMOTE_NO_CATEGORY',
    });
  }
  // Resolve target trunk. `kind: 'other'` requires an explicit override —
  // we won't guess what trunk a custom bucket belongs in (the auto-sort UI
  // action will be the way to bulk-classify those).
  let targetKind = bucket.kind;
  if (targetKind === 'other' || !VALID_TARGET_KINDS.includes(targetKind)) {
    if (!VALID_TARGET_KINDS.includes(rawTargetKind)) {
      throw new ServerError(
        `Bucket "${categoryKey}" has kind "${bucket.kind || 'other'}" — pass targetKind (characters|places|objects) to promote variations from it`,
        { status: 400, code: 'UNIVERSE_PROMOTE_NO_TARGET_KIND' },
      );
    }
    targetKind = rawTargetKind;
  }
  const bibleKind = KIND_TO_BIBLE[targetKind];
  const bibleField = BIBLE_FIELD[bibleKind];

  const needle = rawLabel.trim().toLowerCase();
  const variations = Array.isArray(bucket.variations) ? bucket.variations : [];
  const sourceIdx = variations.findIndex((v) => typeof v?.label === 'string' && v.label.toLowerCase() === needle);
  if (sourceIdx < 0) {
    throw new ServerError(
      `Variation "${rawLabel}" not found in bucket "${categoryKey}"`,
      { status: 404, code: 'UNIVERSE_PROMOTE_VARIATION_NOT_FOUND' },
    );
  }
  const variation = variations[sourceIdx];

  // Refuse silent duplicate creation: if a canon entry with the variation's
  // label already exists, surface a 409 so the UI can suggest "open the
  // existing entry" or "rename then promote" rather than producing a second
  // record that the merge logic would silently swallow on next save. For
  // places (kind whose identity is slugline-keyed via MERGE_CONFIG), also
  // match the variation label against existing entries' `slugline` so a
  // dash-variant or slug-vs-name promotion doesn't slip past name-only
  // matching.
  const existingCanon = Array.isArray(universe[bibleField]) ? universe[bibleField] : [];
  const collision = findCanonCollision(existingCanon, variation.label, targetKind);
  if (collision) {
    throw new ServerError(
      `Canon ${targetKind} "${variation.label}" already exists — rename the variation or open the existing entry`,
      {
        status: 409,
        code: 'UNIVERSE_PROMOTE_DUPLICATE',
        context: { details: { existingId: collision.id } },
      },
    );
  }

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, {
    message: 'No AI provider available for variation promotion',
    code: 'UNIVERSE_PROMOTE_NO_PROVIDER',
  });

  const prompt = buildPromotePrompt({
    targetKind,
    variation,
    category: categoryKey,
    universe,
  });
  console.log(
    `✨ Universe Builder promote — universe=${universeId.slice(0, 8)} category=${categoryKey} label="${variation.label}" → ${targetKind} via ${provider.name}/${selectedModel || 'default'}`,
  );

  const { text: raw, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    prompt,
    source: 'universe-builder-promote-variation',
  });
  console.log(`✨ Universe Builder promote raw — runId=${runId} length=${raw?.length || 0}`);

  // extractEntryJson is shape-gated on the per-kind predicate, so `parsed`
  // is always an object that matches a canon-entry shape. Default name +
  // prompt back to the source variation when the LLM omitted them — keeps
  // the new entry anchored to what the user clicked promote on (rather
  // than letting an LLM hallucination silently replace the label).
  const parsed = extractEntryJson(raw, targetKind);
  const enriched = {
    ...stripCanonControlFields(parsed),
    name: (typeof parsed?.name === 'string' && parsed.name.trim()) ? parsed.name.trim() : variation.label,
    source: BIBLE_SOURCE.UNIVERSE_EXPAND,
    // Default-lock promoted canon entries. Promotion produces a named identity
    // the user picked deliberately; treat it as user-authoritative so AI
    // refine/differentiate paths skip it until the user explicitly unlocks.
    locked: true,
  };
  if (!enriched.prompt && typeof variation.prompt === 'string' && variation.prompt.trim()) {
    enriched.prompt = variation.prompt.trim();
  }
  const sanitizedList = sanitizeBibleList([enriched], bibleKind, { preserveTimestamps: false });
  const sanitized = sanitizedList[0] || null;
  if (!sanitized) {
    throw new ServerError(
      `Promoted entry failed sanitization — required fields missing for ${targetKind}`,
      { status: 502, code: 'UNIVERSE_PROMOTE_INVALID_ENTRY' },
    );
  }

  // Build the patch: append the new canon entry + drop the source variation
  // from its bucket. Both writes go through one updateUniverse so the
  // transition is atomic (success = entry in canon AND variation gone).
  //
  // The mutator runs INSIDE the file-level write queue so a concurrent edit
  // between the (pre-LLM) duplicate check and the persist can't slip a
  // colliding canon entry in, and the source variation is re-located by
  // label on the freshest persisted bucket — the original `sourceIdx` is
  // stale once the queue releases.
  const updated = await updateUniverse(universeId, async (latest) => {
    const latestBucket = latest.categories?.[categoryKey];
    if (!latestBucket) {
      throw new ServerError(
        `Category "${categoryKey}" was deleted while promoting — re-open the universe and try again`,
        { status: 409, code: 'UNIVERSE_PROMOTE_CATEGORY_GONE' },
      );
    }
    const latestVariations = Array.isArray(latestBucket.variations) ? latestBucket.variations : [];
    // Re-locate by label (case-insensitive). The pre-LLM `sourceIdx` is
    // stale — concurrent edits could have reordered or removed entries.
    const latestSourceIdx = latestVariations.findIndex(
      (v) => typeof v?.label === 'string' && v.label.toLowerCase() === needle,
    );
    if (latestSourceIdx < 0) {
      throw new ServerError(
        `Variation "${rawLabel}" was removed from bucket "${categoryKey}" during promotion`,
        { status: 409, code: 'UNIVERSE_PROMOTE_VARIATION_GONE' },
      );
    }
    // Re-check the duplicate-name collision against the LATEST canon — a
    // concurrent promote (or manual canon add) in another tab could have
    // landed an entry with the same name while the LLM was thinking. The
    // sanitized entry's slugline is included as a secondary key for the
    // places case, since the LLM might have emitted a clean slugline
    // that collides with an existing entry whose name doesn't match.
    const latestCanon = Array.isArray(latest[bibleField]) ? latest[bibleField] : [];
    const lateCollision = findCanonCollision(latestCanon, sanitized.name, targetKind, sanitized.slugline);
    if (lateCollision) {
      throw new ServerError(
        `Canon ${targetKind} "${sanitized.name}" already exists — rename the variation or open the existing entry`,
        {
          status: 409,
          code: 'UNIVERSE_PROMOTE_DUPLICATE',
          context: { details: { existingId: lateCollision.id } },
        },
      );
    }

    return {
      [bibleField]: [...latestCanon, sanitized],
      categories: {
        [categoryKey]: {
          kind: latestBucket.kind,
          variations: latestVariations.filter((_, i) => i !== latestSourceIdx),
        },
      },
    };
  });
  // updateUniverse re-runs sanitizers; pull the merged entry back out by
  // id so the response reflects the canonical persisted shape.
  const persisted = (updated[bibleField] || []).find((e) => e.id === sanitized.id) || sanitized;

  console.log(
    `✨ Universe Builder promote complete — universe=${universeId.slice(0, 8)} entry=${persisted.id} (${targetKind}) runId=${runId.slice(0, 8)}`,
  );

  return {
    universe: updated,
    entry: persisted,
    targetKind,
    removed: { category: categoryKey, label: variation.label },
    runId,
    llm: { provider: provider.id, model: selectedModel || null },
  };
}

// Test seam.
export const __testing = {
  buildPromotePrompt,
  extractEntryJson,
};
