/**
 * Universe Builder — Auto-sort with AI.
 *
 * Bulk-classifies every `kind: 'other'` bucket on a universe into one of the
 * three canon trunks (characters / settings / objects) via a single LLM call.
 * Optionally surfaces a `suggestedKey` rename per bucket the UI can present
 * to the user — only the `kind` change is auto-applied here so a stray
 * rename can't silently break an in-flight reference or collide with an
 * existing bucket. (Renames stay an explicit, opt-in follow-up.)
 *
 * Atomic write: one `updateUniverse` patch carries every reclassified bucket
 * so a partial failure either commits the full classification or leaves the
 * universe untouched.
 */

import {
  getUniverse,
  updateUniverse,
  normalizeCategoryKey,
  joinInfluenceList,
} from './universeBuilder.js';
import { VALID_TARGET_KINDS } from './universeBuilderPromote.js';
import { ServerError } from '../lib/errorHandler.js';
import { extractJson as extractJsonShared } from '../lib/jsonExtract.js';
import { resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';

// The 3 real trunks — derived from BIBLE_FIELD via universeBuilderPromote so
// adding a new canon kind reaches this resolver automatically.
const SORTABLE_KINDS = VALID_TARGET_KINDS;

const VARIATION_SAMPLE_PER_BUCKET = 10;

const buildAutoSortPrompt = ({ buckets, universe }) => {
  const embraceTokens = joinInfluenceList(universe.influences?.embrace);
  const styleContext = [
    universe.logline ? `LOGLINE: ${universe.logline}` : null,
    universe.styleNotes ? `STYLE NOTES: ${universe.styleNotes}` : null,
    embraceTokens ? `EMBRACE INFLUENCES: ${embraceTokens}` : null,
  ].filter(Boolean).join('\n\n');
  const styleSection = styleContext
    ? `\n# Universe context\n${styleContext}\n`
    : '';

  const bucketBlock = buckets.map(({ key, variations }) => {
    const sample = variations
      .slice(0, VARIATION_SAMPLE_PER_BUCKET)
      .map((v) => `  - ${v.label}`)
      .join('\n');
    const body = sample || '  (no variations yet)';
    return `## ${key}\n${body}`;
  }).join('\n\n');

  return `You are organizing a story-bible template. The user has these custom buckets that aren't yet tagged to a canon trunk. For each bucket, decide whether it represents CHARACTERS (people, beings, factions of people), SETTINGS (places, environments, locations, regions), or OBJECTS (props, vehicles, weapons, artifacts, technology). Optionally suggest a clearer snake_case bucket key when the original is ambiguous.
${styleSection}
# Buckets to classify
${bucketBlock}

# Output contract
Return a JSON object: { "classifications": [{ "key": "<original bucket key, unchanged>", "kind": "characters" | "settings" | "objects", "suggestedKey": "<optional snake_case alternative>" }] }

# Rules
- "kind" MUST be one of: characters, settings, objects. Never "other".
- "key" MUST exactly match an input bucket key from the list above.
- "suggestedKey" is OPTIONAL — include only when the original is ambiguous or unclear. lowercase snake_case, max 64 chars, no spaces. Omit when the original is fine.
- Output ONLY the JSON object. No commentary, no markdown, no code fences.`;
};

const isClassificationsShape = (o) => {
  if (!o || typeof o !== 'object') return false;
  if (!Array.isArray(o.classifications)) return false;
  return o.classifications.every(
    (c) => c && typeof c === 'object'
      && typeof c.key === 'string'
      && SORTABLE_KINDS.includes(c.kind),
  );
};

const extractClassifications = (raw) => {
  if (!raw || typeof raw !== 'string') throw new Error('Empty LLM response');
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: isClassificationsShape,
  });
  if (value !== undefined) return value.classifications;
  throw new ServerError(
    'LLM returned invalid JSON for bucket classification. Try a different model or rerun.',
    {
      status: 502,
      code: 'LLM_INVALID_JSON',
      context: {
        details: {
          reason: lastError?.message || 'no matching JSON found',
          preview: lastPreview || '',
        },
      },
    },
  );
};

/**
 * Auto-sort every `kind: 'other'` bucket on a universe.
 *
 * Returns `{ universe, results, llm, runId }`. `results` is one entry per
 * bucket the LLM classified: `{ sourceKey, kind, suggestedKey? }`.
 * Buckets the LLM omitted, or returned with an unknown key/kind, are
 * dropped silently (no partial-failure for the rest of the batch).
 *
 * @param {string} universeId
 * @param {object} [options]
 * @param {string} [options.providerId]
 * @param {string} [options.model]
 */
export async function autoSortOtherBuckets(universeId, options = {}) {
  const { providerId, model } = options;
  const universe = await getUniverse(universeId);
  const categories = universe.categories || {};

  // Snapshot the un-classified buckets in insertion order. Retain the full
  // bucket record (not just `variations`) so the patch below can spread it
  // and preserve any future per-bucket fields (locked flags, customPrompt,
  // etc.) added beyond the current `kind`+`variations` shape.
  const otherBuckets = Object.entries(categories)
    .filter(([, c]) => c && c.kind === 'other')
    .map(([key, c]) => ({
      key,
      bucket: c,
      variations: Array.isArray(c.variations) ? c.variations : [],
    }));

  if (otherBuckets.length === 0) {
    return {
      universe,
      results: [],
      llm: { provider: null, model: null },
      runId: null,
    };
  }

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  if (!provider) {
    throw new ServerError('No AI provider available for auto-sort', {
      status: 503,
      code: 'UNIVERSE_AUTOSORT_NO_PROVIDER',
    });
  }

  const prompt = buildAutoSortPrompt({ buckets: otherBuckets, universe });
  console.log(
    `🪄 Universe Builder auto-sort — universe=${universeId.slice(0, 8)} buckets=${otherBuckets.length} via ${provider.name}/${selectedModel || 'default'}`,
  );

  const { text: raw, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    prompt,
    source: 'universe-builder-auto-sort',
  });
  console.log(`🪄 Universe Builder auto-sort raw — runId=${runId} length=${raw?.length || 0}`);

  const classifications = extractClassifications(raw);

  // Build a lookup of the buckets we actually asked about; the LLM may
  // hallucinate a key not in our list and we should ignore those rather
  // than blindly creating a new bucket. Keys are pre-normalized in the
  // universe sanitizer so a direct equality check is safe.
  const byKey = new Map(otherBuckets.map((b) => [b.key, b]));
  const categoriesPatch = {};
  const results = [];
  const seenSourceKeys = new Set();

  for (const c of classifications) {
    // Defensive per-entry kind gate. The shape predicate above only filters
    // which parsed block extractJson returns — when only one block parses,
    // it's returned as a fallback even if its entries fail the predicate.
    // Without this guard a hallucinated `kind: "magic"` would flow into the
    // categories patch and the universe sanitizer would silently coerce it
    // to 'other', undoing the auto-sort the user just ran.
    if (!c || typeof c !== 'object') continue;
    if (typeof c.key !== 'string') continue;
    if (!SORTABLE_KINDS.includes(c.kind)) continue;
    const sourceKey = normalizeCategoryKey(c.key);
    if (!sourceKey || seenSourceKeys.has(sourceKey)) continue;
    const bucket = byKey.get(sourceKey);
    if (!bucket) continue;
    seenSourceKeys.add(sourceKey);

    // Emit the per-bucket patch keyed by sourceKey (no rename auto-applied —
    // see file-level comment). updateUniverse does per-key replacement on
    // categories (not per-field merge), so we spread the whole bucket
    // record to avoid dropping any non-kind fields.
    categoriesPatch[sourceKey] = { ...bucket.bucket, kind: c.kind };

    // Surface suggestedKey only when it's a real, distinct, normalized
    // suggestion — drop empties / unchanged values so the UI doesn't
    // render no-op "Rename to <same thing>" suggestions.
    const suggested = typeof c.suggestedKey === 'string' ? normalizeCategoryKey(c.suggestedKey) : '';
    const suggestedKey = (suggested && suggested !== sourceKey) ? suggested : null;

    results.push({ sourceKey, kind: c.kind, suggestedKey });
  }

  if (results.length === 0) {
    // No bucket survived classification (rare — LLM returned only hallucinated
    // keys or only invalid kinds). Surface this so the UI can fall back to
    // "try another model" guidance rather than silently no-op'ing.
    throw new ServerError(
      'LLM returned no valid classifications for any bucket. Try a different model or rerun.',
      { status: 502, code: 'UNIVERSE_AUTOSORT_NO_CLASSIFICATIONS' },
    );
  }

  const updated = await updateUniverse(universeId, { categories: categoriesPatch });

  console.log(
    `🪄 Universe Builder auto-sort complete — universe=${universeId.slice(0, 8)} classified=${results.length} runId=${runId.slice(0, 8)}`,
  );

  return {
    universe: updated,
    results,
    llm: { provider: provider.id, model: selectedModel || null },
    runId,
  };
}

// Test seam.
export const __testing = {
  buildAutoSortPrompt,
  extractClassifications,
  isClassificationsShape,
};
