/**
 * Per-model API billing rates for informational cost estimates.
 *
 * Subscription plans and local providers do not expose a bill per benchmark run, so these rates answer
 * "what would the recorded tokens cost under API billing," never the actual subscription allowance
 * consumed or a local inference bill.
 *
 * Rates are USD per 1M tokens. Standard input/output come from the table below;
 * the prompt-cache tiers are derived from the input rate by the multipliers in
 * `CACHE_MULTIPLIERS` (every vendor publishes caching as a fixed ratio of the
 * base input rate, so one multiplier per family beats 4 hand-maintained numbers
 * per model, except Grok rows whose cached-input price is not that ratio).
 * Batch discounts are still ignored. Grok's ≥200k doubling is NOT a second
 * rate in this table: it is a per-request subset the usage report prices once
 * more at these base rates (see GROK_LONG_CONTEXT_PROMPT_TOKENS). Transcript-
 * confirmed Fast and Ultrafast are the same kind of subset (`serviceTierExtra`):
 * the extra factor is applied only to tokens the transcript marked, and only
 * for a rate model with a published schedule. Subscription credit multipliers
 * (Codex Fast 2.5× included usage, Ultrafast 8×) are not the API estimate.
 * Verified 2026-11-11 against the OpenAI pricing page and the Grok 4.7 Fast
 * card. The UI discloses the approximation.
 *
 * Cache tiers matter: for agentic CLI use cache reads are >90% of input volume,
 * so mispricing them is the largest source of estimate error. Verified against
 * the official pricing pages on PRICING_AS_OF, newer models noted below:
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   - https://developers.openai.com/api/docs/pricing
 *   - https://docs.x.ai/docs/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 *   - https://inference-docs.cerebras.ai/models/openai-oss
 *
 * Model ids arrive in many shapes (full ids, CLI sentinels like `opus`, the
 * `*-configured-default` sentinels from providerModels.js, Bedrock-prefixed
 * ids), so resolution is exact-id first, then ordered family regexes, then a
 * per-provider default, then a generic fallback — `matched` reports which tier
 * answered so the UI can flag approximate rows.
 */

import { isLoopbackEndpoint } from './localEndpoint.js';
import { hasLocalRuntimeMarker } from './aiToolkit/internal/localRuntimeMarkers.js';

export const PRICING_AS_OF = '2026-09-01';

const MODEL_RATE_AS_OF = Object.freeze({
  'claude-fable-5-2': '2026-11-03',
  'claude-haiku-5-5': '2026-10-07',
  'claude-sonnet-5-5': '2026-10-07',
  'claude-opus-5-5': '2026-09-23',
  'gemini-4-argon': '2026-10-17',
  'gpt-6.1-sol': '2026-09-29',
  'gpt-6.1-terra': '2026-10-27',
  'gpt-6-sol': '2026-09-22',
  'gpt-6-luna': '2026-09-22',
  'gpt-5.6-sol': '2026-09-22',
  'gpt-5.6-luna': '2026-09-22',
  // https://docs.x.ai/docs/models — text cache rates and Imagine headline tiers.
  'grok-4.7': '2026-10-24',
  'grok-4.6': '2026-10-24',
  'grok-4.5': '2026-10-24',
  'grok-4.3': '2026-10-24',
  'grok-4.20': '2026-10-24',
  'grok-build-0.1': '2026-10-24',
  'grok-imagine-image': '2026-10-24',
  'grok-imagine-image-2.0': '2026-10-24',
  'grok-imagine-image-quality': '2026-10-24',
  'grok-imagine-video': '2026-10-24',
  'grok-imagine-video-1.5': '2026-10-24',
  'grok-imagine-video-1.5-lite': '2026-10-24',
});

/**
 * xAI doubles every token price, including cached input, on a request whose
 * prompt reaches this size. The doubling applies to that request only — a
 * day's summed tokens are not a prompt — so the rate table stays at the short
 * tier and the usage report adds one extra base-rate charge for the subset.
 */
export const GROK_LONG_CONTEXT_PROMPT_TOKENS = 200_000;

/**
 * Extra factor on top of the standard rate for one service tier. 1 prices the
 * subset once more (2×). 1.5 is gpt-5.5 Fast (2.5×). 5 is Ultrafast (6×) on
 * the two models that publish it. 0 means the tier was recorded and no Fast
 * schedule exists for that rate model — the subset stays on the row and is
 * not given an invented price. Unpublished models (gpt-5.4-nano, gpt-5.5-pro,
 * grok-4.6 and older, grok-build-0.1) are absent on purpose.
 * https://developers.openai.com/api/docs/pricing (2026-11-11).
 */
const FAST_EXTRA_BY_RATE_MODEL = Object.freeze({
  'gpt-6-astra': 1,
  'gpt-6.1-sol': 1,
  'gpt-6.1-terra': 1,
  'gpt-6-sol': 1,
  'gpt-6-luna': 1,
  'gpt-5.6-sol': 1,
  'gpt-5.6-terra': 1,
  'gpt-5.6-luna': 1,
  'gpt-5.5': 1.5,
  'gpt-5.4': 1,
  'gpt-5.4-mini': 1,
  'gpt-5.3-codex': 1,
  'grok-4.7': 1,
});
const ULTRAFAST_EXTRA_BY_RATE_MODEL = Object.freeze({
  'gpt-6-astra': 5,
  'gpt-6.1-sol': 5,
});

/**
 * Increment over the standard rate for `tier` ('fast' or 'ultrafast') on a
 * resolved rate model. 0 for standard, unknown, or a model with no published
 * schedule. The usage report multiplies `estimateCostUsd` of the subset by
 * this factor; the subset is already inside the base token counts.
 * @param {string|null|undefined} rateModel
 * @param {'fast'|'ultrafast'|string|null|undefined} tier
 * @returns {number}
 */
export function serviceTierExtra(rateModel, tier) {
  const id = typeof rateModel === 'string' ? rateModel : '';
  if (tier === 'fast') return FAST_EXTRA_BY_RATE_MODEL[id] || 0;
  if (tier === 'ultrafast') return ULTRAFAST_EXTRA_BY_RATE_MODEL[id] || 0;
  return 0;
}

/** Ledger names for the Fast and Ultrafast subsets. Absent means zero. */
export const SPEED_LEDGER_FIELDS = Object.freeze([
  'fastTokensIn', 'fastTokensOut', 'fastCacheReadTokens', 'fastCacheWriteTokens',
  'ultrafastTokensIn', 'ultrafastTokensOut', 'ultrafastCacheReadTokens', 'ultrafastCacheWriteTokens',
]);

/** Docs' recommended Imagine models, and what the Grok CLI bills when it names none. */
export const GROK_IMAGINE_IMAGE_MODEL = 'grok-imagine-image-2.0';
export const GROK_IMAGINE_VIDEO_MODEL = 'grok-imagine-video-1.5';

/** Recommended Antigravity image model. */
export const AGY_IMAGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

/**
 * Headline / lowest-resolution Imagine rates (USD). Higher resolutions cost
 * more; PortOS does not request a resolution, so the estimate is this tier.
 * Longest id first: `grok-imagine-image` is a prefix of the 2.0 and quality ids.
 */
const GROK_IMAGINE_RATES = Object.freeze([
  { id: 'grok-imagine-video-1.5-lite', kind: 'video', perSecond: 0.02, perInputImage: 0.01 },
  { id: 'grok-imagine-image-quality', kind: 'image', perImage: 0.05, perInputImage: 0.01 },
  { id: 'grok-imagine-image-2.0', kind: 'image', perImage: 0.04, perInputImage: 0.01 },
  { id: 'grok-imagine-video-1.5', kind: 'video', perSecond: 0.08, perInputImage: 0.01 },
  { id: 'grok-imagine-image', kind: 'image', perImage: 0.02, perInputImage: 0.002 },
  { id: 'grok-imagine-video', kind: 'video', perSecond: 0.05, perInputImage: 0.002 },
].sort((a, b) => b.id.length - a.id.length));

/** The Imagine rate row a model id names, or null. Longest published id wins. */
function grokImagineRate(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id.includes('grok-imagine-')) return null;
  return GROK_IMAGINE_RATES.find((row) => id === row.id || id.includes(row.id)) || null;
}

/**
 * Google Imagen 3 rates (USD). Published rate: $0.030 per image.
 * https://ai.google.dev/gemini-api/docs/pricing
 */
const AGY_IMAGEN_RATES = Object.freeze([
  { id: 'imagen-3.0-generate-002', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-3.0-fast-generate-001', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-3.0-generate', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-3.0', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-3-fast', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-3', kind: 'image', perImage: 0.03, perInputImage: 0 },
  { id: 'imagen-2', kind: 'image', perImage: 0.02, perInputImage: 0 },
  { id: 'imagen', kind: 'image', perImage: 0.03, perInputImage: 0 },
].sort((a, b) => b.id.length - a.id.length));

/** The Imagen rate row a model id names, or null. */
function agyImagenRate(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id.includes('imagen')) return null;
  return AGY_IMAGEN_RATES.find((row) => id === row.id || id.includes(row.id)) || null;
}

/**
 * USD for one Antigravity Imagen bucket. Token rates do not apply.
 * @param {string|null|undefined} model
 * @param {{ images?: number, inputImages?: number }} [units]
 * @returns {number}
 */
export function estimateAgyImageCost(model, units = null) {
  const rate = agyImagenRate(model);
  if (!rate) return 0;
  return (units?.images || 0) * (rate.perImage || 0)
    + (units?.inputImages || 0) * (rate.perInputImage || 0);
}

/**
 * USD for one Imagine bucket. Token rates do not apply; input-image fees use
 * the same model's published input price. Unknown ids cost nothing here so a
 * text row cannot pick up an image price by substring accident.
 * @param {string|null|undefined} model
 * @param {{ images?: number, videoSeconds?: number, inputImages?: number }} [units]
 * @returns {number}
 */
export function estimateGrokImagineCost(model, units = null) {
  const rate = grokImagineRate(model);
  if (!rate) return 0;
  return (units?.images || 0) * (rate.perImage || 0)
    + (units?.videoSeconds || 0) * (rate.perSecond || 0)
    + (units?.inputImages || 0) * (rate.perInputImage || 0);
}

export const pricingAsOfForModel = (model) =>
  MODEL_RATE_AS_OF[String(model || '').trim().toLowerCase()] || PRICING_AS_OF;

/**
 * Every shipped Opus generation bills at one published [input, output] pair.
 * `OPUS_MODEL_IDS` is NEWEST FIRST: its head is what the `/opus/i` family rule
 * reports for unlisted opus ids, so a bump is a single prepend.
 */
const OPUS_TIER_RATES = [5.0, 25.0];
const OPUS_MODEL_IDS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
];

/**
 * Fable 5.1 keeps Fable 5's input/output rates (only cache tiers changed), but
 * `claude-fable-5` stays a distinct entry. NEWEST FIRST: the head is what the
 * `/fable/i` family rule reports for unlisted fable ids.
 */
const FABLE_MODEL_IDS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5'];

/** USD per 1M tokens: [input, output]. Exact model-id matches. */
const EXACT_RATES = {
  // Anthropic
  // Fable 5.2 is the successor to 5.1 at a lower price ($8/$40).
  'claude-fable-5-2': [8.0, 40.0],
  'claude-fable-5-1': [10.0, 50.0],
  // Opus 5.5 launched below the $5/$25 Opus tier rate, so it is its own row
  // rather than a member of OPUS_MODEL_IDS.
  'claude-opus-5-5': [4.0, 20.0],
  'claude-fable-5': [10.0, 50.0],
  'claude-mythos-5': [10.0, 50.0],
  ...Object.fromEntries(OPUS_MODEL_IDS.map((id) => [id, [...OPUS_TIER_RATES]])),
  'claude-sonnet-5-5': [2.0, 10.0],
  'claude-sonnet-5': [2.0, 10.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-5': [3.0, 15.0],
  // Haiku 5.5 base tier (prompts <=100k tokens); >100k is $0.50/$2.50 and not modeled.
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1.0, 5.0],
  // OpenAI (Codex CLI). GPT-6 Sol/Luna and updated GPT-5.6 Sol/Luna rates were
  // verified against the 2026-09-22 model launch:
  // https://openai.com/index/introducing-gpt-6-sol-and-luna/
  'gpt-6-astra': [10.0, 50.0],
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  'gpt-6.1-sol': [2.0, 10.0],
  // https://developers.openai.com/api/docs/models/gpt-6.1-terra
  'gpt-6.1-terra': [1.0, 5.0],
  'gpt-6-sol': [2.0, 10.0],
  'gpt-6-luna': [0.1, 0.5],
  'gpt-5.6-sol': [4.0, 20.0],
  'gpt-5.6-terra': [2.5, 15.0],
  'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.5': [5.0, 30.0],
  'gpt-5.5-pro': [30.0, 180.0],
  'gpt-5.4': [2.5, 15.0],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.3-codex': [1.75, 14.0],
  // xAI. Short-context (prompt <200k) rates. The ≥200k doubling is
  // GROK_LONG_CONTEXT_PROMPT_TOKENS, applied per request by the usage report.
  // Verified 2026-10-24: https://docs.x.ai/docs/models
  'grok-4.7': [2.0, 6.0],
  'grok-4.6': [2.0, 6.0],
  'grok-4.5': [2.0, 6.0],
  'grok-4.3': [1.25, 2.5],
  'grok-build-0.1': [1.0, 2.0],
  // Google (Antigravity)
  // Introductory standard rate through 2026-11-30; doubles to $4/$20 on 2026-12-01.
  'gemini-4-argon': [2.0, 10.0],
  'gemini-3.1-pro-preview': [2.0, 12.0], // ≤200k-token tier
  'gemini-3.8-flash': [1.5, 9.0],
  'gemini-3.6-flash': [1.5, 9.0],
  'gemini-3.5-flash': [1.5, 9.0],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  // Rate anchor, not a matchable id (reached via the `/gpt-oss/i` rule and the
  // `cerebras` default, so always approximate). Open-weights ids do not identify
  // the host, so none may claim `matched: 'exact'`; Cerebras is the only host shipped.
  'gpt-oss-120b (cerebras)': [0.35, 0.75],
};

// Exact keys longest-first for the substring pass in resolveModelRates, so
// suffixed/prefixed variants resolve to base rates and `gpt-5.5-pro` beats `gpt-5.5`.
const EXACT_KEYS_BY_LENGTH = Object.keys(EXACT_RATES).sort((a, b) => b.length - a.length);

/**
 * Ordered family rules — first regex that matches the model id wins. Covers
 * CLI shorthand (`opus`, `sonnet`), family names the exact table doesn't
 * list, and the `*-configured-default` sentinels (the sentinel strings
 * contain their provider family name).
 */
const FAMILY_RULES = [
  { test: /fable|mythos/i, rateModel: FABLE_MODEL_IDS[0] },
  // Newest listed opus id; the tier shares one rate pair, so this only supplies the label.
  { test: /opus/i, rateModel: OPUS_MODEL_IDS[0] },
  { test: /sonnet[-.]?5/i, rateModel: 'claude-sonnet-5' },
  { test: /sonnet/i, rateModel: 'claude-sonnet-4-5' },
  { test: /haiku-5/i, rateModel: 'claude-haiku-5-5' },
  { test: /haiku/i, rateModel: 'claude-haiku-4-5' },
  { test: /codex/i, rateModel: 'gpt-5.3-codex' },
  // Open-weights: must win over the proprietary `/gpt/i` rule (~10-20x too high); never `exact`.
  { test: /gpt-oss/i, rateModel: 'gpt-oss-120b (cerebras)' },
  { test: /astra/i, rateModel: 'gpt-6-astra' },
  { test: /gpt/i, rateModel: 'gpt-5.4' },
  { test: /grok-build/i, rateModel: 'grok-build-0.1' },
  { test: /grok-4\.20/i, rateModel: 'grok-4.3' },
  { test: /grok/i, rateModel: 'grok-4.7' },
  { test: /gemini|antigravity/i, rateModel: 'gemini-3.1-pro-preview' },
];

/** Per-provider default when the model id resolves to no known family. */
const PROVIDER_DEFAULT_RULES = [
  { test: /claude/i, rateModel: 'claude-sonnet-4-5' },
  { test: /codex|openai/i, rateModel: 'gpt-5.3-codex' },
  { test: /grok|xai/i, rateModel: 'grok-4.7' },
  { test: /antigravity|agy|gemini|google/i, rateModel: 'gemini-3.1-pro-preview' },
  // Cerebras hosts a small, uniformly cheap catalog; its flagship beats the generic fallback.
  { test: /cerebras/i, rateModel: 'gpt-oss-120b (cerebras)' },
];

// Legacy blended estimate: last resort when nothing above recognizes the pair.
const FALLBACK_RATES = { rateModel: null, inputPer1M: 3.0, outputPer1M: 15.0 };

/**
 * Prompt-cache rates as multipliers of a model's BASE INPUT rate. Every vendor
 * publishes caching as a fixed ratio rather than a standalone number, so one
 * pair per family stays correct when a model's input rate changes and avoids
 * four hand-maintained columns per row in EXACT_RATES.
 *
 * `read` is a cache hit; `write` is the surcharge for first storing content.
 * Verified on PRICING_AS_OF against the pages listed in the header:
 *   - Anthropic: 0.1x read, 1.25x 5-minute write (2x for the 1-hour TTL, which
 *     Claude Code does not use — `cache_creation_input_tokens` is 5-minute).
 *   - OpenAI: 0.1x cached input by default, with model-specific overrides;
 *     writes are estimated at 1.25x (Terra's 30-minute rate). Codex reports no
 *     cache-write tokens; longer retention rates are not modeled.
 *   - xAI (2026-10-24, https://docs.x.ai/docs/models): cached input is a
 *     published price, not one ratio. grok-4.7 and grok-4.6 are $0.50 (0.25x
 *     of $2), grok-4.5 is $0.30 (0.15x), grok-4.3 / grok-4.20 and
 *     grok-build-0.1 are $0.20 (absolute — 0.20 is not a binary fraction of
 *     $1.25). xAI publishes no cache-write product; creation is ordinary
 *     input, so every Grok write multiplier is 1. An unknown grok* id uses
 *     the grok-4.7 pair.
 *   - Google: 0.1x cached input, plus an hourly storage fee we do not model
 *     (PortOS records no cache duration to price it against).
 *
 * The default matches Anthropic/OpenAI; Claude Code and Codex are the only CLIs
 * that write per-message cache counts (`lib/provider/providerTranscriptUsage.js`), so other
 * families' multipliers apply to counts that are currently 0.
 *
 * Fable 5.1 cut cache reads to 0.025x while write stayed 1.25x; the override is
 * scoped to its id, not the `/fable/i` family.
 */
const DEFAULT_CACHE_MULTIPLIERS = { read: 0.1, write: 1.25 };
const CACHE_MULTIPLIER_RULES = [
  // GPT-6.1 Sol cached input is $0.10/MTok against a $2 input rate.
  { test: /^gpt-6\.1-sol$/, read: 0.05, write: 1.25 },
  // GPT-6.1 Terra cached input is $0.05/MTok against a $1 input rate.
  { test: /^gpt-6\.1-terra$/, read: 0.05, write: 1.25 },
  { test: /^grok-4\.7$/, read: 0.25, write: 1 },
  { test: /^grok-4\.6$/, read: 0.25, write: 1 },
  { test: /^grok-4\.5$/, read: 0.15, write: 1 },
  // $0.20 cached input against $1.25 (grok-4.3) and $1 (grok-build-0.1).
  { test: /^grok-4\.3$/, cacheReadPer1M: 0.20, write: 1 },
  { test: /^grok-build-0\.1$/, cacheReadPer1M: 0.20, write: 1 },
  { test: /^grok/, read: 0.25, write: 1 },
  { test: /^claude-fable-5-1/, read: 0.025, write: 1.25 },
  // Fable 5.2 cache reads are $0.20/MTok against an $8 input rate.
  { test: /^claude-fable-5-2/, read: 0.025, write: 1.25 },
  // Opus 5.5 cache reads are $0.20/MTok against a $4 input rate.
  { test: /^claude-opus-5-5/, read: 0.05, write: 1.25 },
  // Sonnet 5.5 cache reads were halved to $0.10/MTok (2026-10-07) against a $2 input rate:
  // https://x.com/claudeai/status/2107894060229034197
  { test: /^claude-sonnet-5-5/, read: 0.05, write: 1.25 },
];

const cacheMultipliers = (rateModel) => {
  const id = typeof rateModel === 'string' ? rateModel : '';
  return CACHE_MULTIPLIER_RULES.find((rule) => rule.test.test(id)) || DEFAULT_CACHE_MULTIPLIERS;
};

/**
 * Expand a base input/output rate pair with its derived cache-tier rates. Used
 * for both table hits and the generic fallback so every rate object carries the
 * same four fields — a caller can price cache tokens without checking which
 * tier answered.
 */
const withCacheRates = (rates) => {
  const rule = cacheMultipliers(rates.rateModel);
  const read = rule.cacheReadPer1M != null
    ? rule.cacheReadPer1M
    : rates.inputPer1M * (rule.read ?? DEFAULT_CACHE_MULTIPLIERS.read);
  const write = rates.inputPer1M * (rule.write ?? DEFAULT_CACHE_MULTIPLIERS.write);
  return {
    ...rates,
    cacheReadPer1M: read,
    cacheWritePer1M: write,
  };
};

const toRates = (rateModel) => withCacheRates({
  rateModel,
  inputPer1M: EXACT_RATES[rateModel][0],
  outputPer1M: EXACT_RATES[rateModel][1],
});

/**
 * Resolve billing rates for a (providerId, model) pair. `cacheReadPer1M` /
 * `cacheWritePer1M` are derived from the input rate (see CACHE_MULTIPLIER_RULES).
 * @param {string|null|undefined} providerId
 * @param {string|null|undefined} model
 * @returns {{ rateModel: string|null, inputPer1M: number, outputPer1M: number,
 *   cacheReadPer1M: number, cacheWritePer1M: number,
 *   matched: 'exact'|'family'|'providerDefault'|'fallback',
 *   pricedBy: 'published'|'fallback' }}
 */
export function resolveModelRates(providerId, model) {
  const id = typeof model === 'string' ? model.trim() : '';
  // Before `/grok/i`, which would price an Imagine id as grok-4.7 text; media rows keep zero token rates.
  const imagine = grokImagineRate(id);
  if (imagine) {
    return {
      rateModel: imagine.id,
      inputPer1M: 0,
      outputPer1M: 0,
      cacheReadPer1M: 0,
      cacheWritePer1M: 0,
      matched: id.toLowerCase() === imagine.id ? 'exact' : 'family',
      pricedBy: 'fallback',
    };
  }
  const imagen = agyImagenRate(id);
  if (imagen) {
    return {
      rateModel: imagen.id,
      inputPer1M: 0,
      outputPer1M: 0,
      cacheReadPer1M: 0,
      cacheWritePer1M: 0,
      matched: id.toLowerCase() === imagen.id ? 'exact' : 'family',
      pricedBy: 'fallback',
    };
  }
  if (id && EXACT_RATES[id]) {
    return { ...toRates(id), matched: 'exact', pricedBy: 'published' };
  }
  if (id) {
    const lower = id.toLowerCase();
    const embedded = EXACT_KEYS_BY_LENGTH.find((key) => lower.includes(key));
    if (embedded) {
      return { ...toRates(embedded), matched: 'family', pricedBy: 'published' };
    }
    for (const rule of FAMILY_RULES) {
      if (rule.test.test(id)) {
        return { ...toRates(rule.rateModel), matched: 'family', pricedBy: 'fallback' };
      }
    }
  }
  const pid = typeof providerId === 'string' ? providerId : '';
  for (const rule of PROVIDER_DEFAULT_RULES) {
    if (rule.test.test(pid)) {
      return { ...toRates(rule.rateModel), matched: 'providerDefault', pricedBy: 'fallback' };
    }
  }
  return { ...withCacheRates(FALLBACK_RATES), matched: 'fallback', pricedBy: 'fallback' };
}

const FREE_ID = /ollama|lmstudio|lm-studio/i;

// A record from a service instance carries the DECLARED plan, which beats every
// inference below (free and paid tiers share endpoint and model ids).
const FREE_SERVICE_PLANS = new Set(['free', 'local']);

// OpenCode Zen is a free-tier quota, not API billing, so its rows resolve to $0.
// Narrow on purpose: a bare `zen` substring would match unrelated paid ids.
const ZEN_PROVIDER_ID = /opencode-zen/i;
const ZEN_ENDPOINT = /opencode\.ai\/zen/i;

// Ollama/LM Studio name models `family:tag` (`qwen3.6:35b`). A bare `:` test is
// NOT safe: Bedrock ids carry a `:0` version suffix and would be priced at $0.
// An Ollama tag is a size/quantization label, so require a letter after the colon.
const LOCAL_TAGGED_MODEL = /^[\w.-]+:[\w.-]*[a-z][\w.-]*$/i;

// `org/repo` is not a local marker on its own (paid catalogs share the shape), so
// slash ids need provider corroboration via `isFreeProvider`. Exceptions: the
// harness's own `opencode/*` namespace (Zen free tier) and an explicit `-free`
// suffix are provider-side labels that win over the family-guess rules.
const FREE_TIER_MODEL = /^opencode\/.+|[^/]*-free$/i;

/**
 * True when a MODEL id is local-inference (free), independent of which provider
 * ran it. Needed because a Claude-Code-flavored CLI can be pointed at an Ollama
 * backend: its transcript records `qwen3.6:35b`, which would otherwise resolve
 * through the `claude` provider default and be billed at Sonnet rates.
 *
 * Deliberately conservative — a hosted id we can't classify must fall through to
 * normal (paid) pricing, because under-billing a paid model is the more
 * expensive mistake for a report whose whole purpose is "what did this cost".
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isFreeModelId(model) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id) return false;
  if (EXACT_RATES[id]) return false;
  // An explicit free-tier label beats the family guesses below.
  if (FREE_TIER_MODEL.test(id)) return true;
  // Nor one resolving to a known hosted family (incl. Bedrock-prefixed variants).
  if (resolveModelRates(null, id).matched !== 'fallback') return false;
  if (FREE_ID.test(id)) return true;
  return LOCAL_TAGGED_MODEL.test(id);
}

/**
 * True when a provider's usage is free — local inference (Ollama, LM Studio,
 * any Ollama-/MTPLX-/llama-/vLLM-backed CLI wrapper, or an API provider pointed at localhost),
 * or a free-tier quota (OpenCode Zen: the `opencode-zen*` provider ids or the
 * `opencode.ai/zen` endpoint). A record carrying a declared `servicePlan`
 * (#7563) answers from that alone. Accepts a provider config object or a bare
 * provider-id string (usage records can outlive their provider config).
 * @param {object|string|null|undefined} providerOrId
 * @returns {boolean}
 */
export function isFreeProvider(providerOrId) {
  if (providerOrId == null) return false;
  if (typeof providerOrId === 'string') return FREE_ID.test(providerOrId) || ZEN_PROVIDER_ID.test(providerOrId);
  const p = providerOrId;
  if (typeof p.servicePlan === 'string') return FREE_SERVICE_PLANS.has(p.servicePlan);
  if (hasLocalRuntimeMarker(p)) return true;
  if (FREE_ID.test(p.id || '') || FREE_ID.test(p.command || '')) return true;
  if (ZEN_PROVIDER_ID.test(p.id || '')) return true;
  if (typeof p.endpoint === 'string' && (isLoopbackEndpoint(p.endpoint) || ZEN_ENDPOINT.test(p.endpoint.trim()))) return true;
  return false;
}

/**
 * Estimated USD cost for a token count under the given rates. Returns the raw
 * float — callers round for display.
 *
 * `tokensIn` is the UNCACHED input only; cache reads and writes are billed at
 * their own tiers via the optional 4th argument. Passing them as `tokensIn`
 * would overcharge a cache read by 10x — for agentic CLI runs, where cache reads
 * are >90% of input volume, that dwarfs every other error in the estimate.
 * @param {number} tokensIn uncached input tokens
 * @param {number} tokensOut
 * @param {{inputPer1M: number, outputPer1M: number, cacheReadPer1M?: number, cacheWritePer1M?: number}} rates
 * @param {{cacheReadTokens?: number, cacheWriteTokens?: number}} [cache]
 * @returns {number}
 */
export function estimateCostUsd(tokensIn, tokensOut, rates, cache = null) {
  const perMillion = (tokens, rate) => ((tokens || 0) / 1_000_000) * (rate || 0);
  return perMillion(tokensIn, rates?.inputPer1M)
    + perMillion(tokensOut, rates?.outputPer1M)
    + perMillion(cache?.cacheReadTokens, rates?.cacheReadPer1M)
    + perMillion(cache?.cacheWriteTokens, rates?.cacheWritePer1M);
}
