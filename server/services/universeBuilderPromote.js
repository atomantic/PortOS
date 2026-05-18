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
  joinInfluenceList,
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
import { resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';

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
const isSettingShape = (o) =>
  o && typeof o === 'object' && (typeof o.name === 'string' || typeof o.slugline === 'string');
const isObjectShape = isCharacterShape;

const SHAPE_PREDICATE = {
  characters: isCharacterShape,
  settings: isSettingShape,
  objects: isObjectShape,
};

const buildPromotePrompt = ({
  targetKind,
  variation,
  category,
  universe,
}) => {
  const embraceTokens = joinInfluenceList(universe.influences?.embrace);
  const styleContext = [
    universe.logline ? `LOGLINE: ${universe.logline}` : null,
    universe.styleNotes ? `STYLE NOTES: ${universe.styleNotes}` : null,
    embraceTokens ? `EMBRACE INFLUENCES: ${embraceTokens}` : null,
  ].filter(Boolean).join('\n\n');
  const styleSection = styleContext
    ? `\n# Universe context — keep the new canon entry consistent with this established setting\n${styleContext}\n`
    : '';

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
  } else if (targetKind === 'settings') {
    outputContract = `Return a SINGLE JSON object describing one SETTING / PLACE. Required fields:
- name: string (max ${BIBLE_LIMITS.NAME_MAX} chars). Human label like "Foundry City". Default the variation label when no clearer name is implied.
- slugline: string (max ${BIBLE_LIMITS.SLUGLINE_MAX} chars). Screenplay-style location header like "EXT. FOUNDRY CITY — DAY". Leave empty string when no obvious slugline applies.
- description: string (max ${BIBLE_LIMITS.SETTING_DESCRIPTION_MAX} chars). What the place looks like + feels like.
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
 * @param {'characters'|'settings'|'objects'} [options.targetKind] — required
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
        `Bucket "${categoryKey}" has kind "${bucket.kind || 'other'}" — pass targetKind (characters|settings|objects) to promote variations from it`,
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
  // settings (kind whose identity is slugline-keyed via MERGE_CONFIG), also
  // match the variation label against existing entries' `slugline` so a
  // dash-variant or slug-vs-name promotion doesn't slip past name-only
  // matching.
  const existingCanon = Array.isArray(universe[bibleField]) ? universe[bibleField] : [];
  let collision = findBibleEntryByName(existingCanon, variation.label);
  if (!collision && targetKind === 'settings') {
    const needleSlug = normalizeSlugline(variation.label);
    if (needleSlug) {
      collision = existingCanon.find((e) => {
        if (!e || typeof e !== 'object') return false;
        if (normalizeSlugline(e.slugline) === needleSlug) return true;
        if (normalizeSlugline(e.name) === needleSlug) return true;
        return false;
      });
    }
  }
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
  if (!provider) {
    throw new ServerError('No AI provider available for variation promotion', {
      status: 503, code: 'UNIVERSE_PROMOTE_NO_PROVIDER',
    });
  }

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
  const nextCanon = [...existingCanon, sanitized];
  const nextVariations = variations.filter((_, i) => i !== sourceIdx);
  const patch = {
    [bibleField]: nextCanon,
    categories: {
      [categoryKey]: { kind: bucket.kind, variations: nextVariations },
    },
  };
  const updated = await updateUniverse(universeId, patch);
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
