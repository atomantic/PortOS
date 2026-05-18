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

// Collapse newlines + control chars in user-supplied free text before embedding
// in the prompt. Variation labels + logline + styleNotes are user-owned strings
// that pass sanitization but aren't newline-stripped — without this a label
// containing "\n# Output contract\n..." could redirect the LLM's structure.
// Downstream gates (per-entry kind filter, byKey lookup) keep the blast radius
// bounded even if injection lands, but stripping at the embed layer is the
// cheap defense.
const escapePromptText = (s) =>
  typeof s === 'string' ? s.replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ').trim() : '';

const kindUnionForPrompt = SORTABLE_KINDS.map((k) => `"${k}"`).join(' | ');
const kindListForPrompt = SORTABLE_KINDS.join(', ');

const buildAutoSortPrompt = ({ buckets, universe }) => {
  const embraceTokens = joinInfluenceList(universe.influences?.embrace);
  const styleContext = [
    universe.logline ? `LOGLINE: ${escapePromptText(universe.logline)}` : null,
    universe.styleNotes ? `STYLE NOTES: ${escapePromptText(universe.styleNotes)}` : null,
    embraceTokens ? `EMBRACE INFLUENCES: ${escapePromptText(embraceTokens)}` : null,
  ].filter(Boolean).join('\n\n');
  const styleSection = styleContext
    ? `\n# Universe context\n${styleContext}\n`
    : '';

  const bucketBlock = buckets.map(({ key, variations }) => {
    const sample = variations
      .slice(0, VARIATION_SAMPLE_PER_BUCKET)
      .map((v) => `  - ${escapePromptText(v.label)}`)
      .join('\n');
    const body = sample || '  (no variations yet)';
    return `## ${key}\n${body}`;
  }).join('\n\n');

  return `You are organizing a story-bible template. The user has these custom buckets that aren't yet tagged to a canon trunk. For each bucket, decide whether it represents one of these trunks: ${kindListForPrompt}. Optionally suggest a clearer snake_case bucket key when the original is ambiguous.
${styleSection}
# Buckets to classify
${bucketBlock}

# Output contract
Return a JSON object: { "classifications": [{ "key": "<original bucket key, unchanged>", "kind": ${kindUnionForPrompt}, "suggestedKey": "<optional snake_case alternative>" }] }

# Rules
- "kind" MUST be one of: ${kindListForPrompt}. Never "other".
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
  // Surface empty/non-string responses through the same typed 502 path as
  // malformed JSON — without this, a successful run with empty `text` would
  // throw an untyped Error that the route would normalize to a generic 500.
  if (!raw || typeof raw !== 'string') {
    throw new ServerError(
      'LLM returned an empty response for bucket classification. Try a different model or rerun.',
      { status: 502, code: 'LLM_INVALID_JSON' },
    );
  }
  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: isClassificationsShape,
  });
  // extractJson returns the first parseable block as a fallback even when
  // shapePredicate fails — so `value` could be `{ classifications: null }`
  // or `{ error: "..." }`. Re-gate on the array shape so downstream
  // iteration can't throw a generic 500.
  if (value !== undefined && Array.isArray(value?.classifications)) {
    return value.classifications;
  }
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

  // Snapshot the un-classified buckets in insertion order — used only to
  // build the prompt body. The actual write below re-fetches the latest
  // universe state so concurrent edits aren't overwritten.
  const otherBuckets = Object.entries(categories)
    .filter(([, c]) => c && c.kind === 'other')
    .map(([key, c]) => ({
      key,
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

  // Re-fetch the latest universe state immediately before the write so
  // concurrent edits made to OTHER buckets (in another tab) during the
  // LLM call aren't overwritten. We still build the patch keyed only on
  // the buckets the LLM classified, but each bucket's spread uses the
  // freshest persisted shape — so a variation added mid-LLM-call to a
  // bucket that's about to be reclassified is preserved.
  const latest = await getUniverse(universeId);
  const latestCategories = latest.categories || {};
  const byKey = new Map(
    Object.entries(latestCategories)
      .filter(([, c]) => c && c.kind === 'other')
      .map(([key, c]) => [key, c]),
  );
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
    // Drop classifications for buckets that no longer exist or are no
    // longer kind:'other' on the latest state — a concurrent assignBucketKind
    // or removeCategory call would otherwise be silently reverted here.
    const latestBucket = byKey.get(sourceKey);
    if (!latestBucket) continue;
    seenSourceKeys.add(sourceKey);

    // updateUniverse does per-key replacement on categories (not per-field
    // merge), so spread the whole latest bucket record to preserve any
    // variations / fields added mid-flight.
    categoriesPatch[sourceKey] = { ...latestBucket, kind: c.kind };

    const suggested = typeof c.suggestedKey === 'string' ? normalizeCategoryKey(c.suggestedKey) : '';
    const suggestedKey = (suggested && suggested !== sourceKey) ? suggested : null;

    results.push({ sourceKey, kind: c.kind, suggestedKey });
  }

  if (results.length === 0) {
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
