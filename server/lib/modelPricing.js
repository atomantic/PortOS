/**
 * Per-model API billing rates for the "what would this have cost" estimates on
 * /devtools/usage. PortOS runs on provider subscriptions, so these numbers are
 * informational only — they answer "what would the recorded usage have cost
 * under API billing," never an actual bill.
 *
 * Rates are USD per 1M tokens. Standard input/output come from the table below;
 * the prompt-cache tiers are derived from the input rate by the multipliers in
 * `CACHE_MULTIPLIERS` (every vendor publishes caching as a fixed ratio of the
 * base input rate, so one multiplier per family beats 4 hand-maintained numbers
 * per model). Batch and long-context tier discounts are still ignored, and the
 * UI discloses the approximation.
 *
 * Cache tiers are NOT a rounding detail: for agentic CLI use, cache reads are
 * >90% of input volume, so pricing them at the standard input rate (or, as
 * PortOS did before #3124, not counting the tokens at all) is the single largest
 * source of error in the estimate. Verified against the official pricing pages
 * on PRICING_AS_OF:
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

export const PRICING_AS_OF = '2026-09-01';

/**
 * Every shipped Claude Opus generation bills at the same published rate, so the
 * tier owns one [input, output] pair rather than a hand-copied literal per row.
 * `OPUS_MODEL_IDS` is ordered NEWEST FIRST: its head is the id the `/opus/i`
 * family rule reports for opus ids the table doesn't list, so an opus bump is a
 * single prepend here — the family rule no longer has to be re-pointed by hand
 * (it was, at every bump through migration 206, for zero behavioral effect).
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
 * Fable 5.1 (2026-09-01) keeps Fable 5's input/output rates — only its cache
 * tiers changed (see CACHE_MULTIPLIER_RULES) — but it's its own EXACT_RATES row
 * rather than folded into OPUS-style array sharing, since `claude-fable-5`
 * stays a distinct historical entry rather than being renamed. Ordered NEWEST
 * FIRST, same convention as OPUS_MODEL_IDS: its head is what the `/fable/i`
 * family rule reports for a fable id the table doesn't list.
 */
const FABLE_MODEL_IDS = ['claude-fable-5-1', 'claude-fable-5'];

/** USD per 1M tokens: [input, output]. Exact model-id matches. */
const EXACT_RATES = {
  // Anthropic
  'claude-fable-5-1': [10.0, 50.0],
  'claude-fable-5': [10.0, 50.0],
  'claude-mythos-5': [10.0, 50.0],
  // Cloned per row so each key owns its pair exactly as the hand-written rows
  // above and below do — sharing one array across five keys would make any
  // future edit to one opus row silently rewrite the whole tier.
  ...Object.fromEntries(OPUS_MODEL_IDS.map((id) => [id, [...OPUS_TIER_RATES]])),
  // The scheduled 2026-09-01 bump to $3/$15 was cancelled — Anthropic confirmed
  // 2026-08-10 that the $2/$10 intro rate is now the permanent standard rate.
  'claude-sonnet-5': [2.0, 10.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-5': [3.0, 15.0],
  'claude-haiku-4-5': [1.0, 5.0],
  // OpenAI (Codex CLI)
  'gpt-5.6-sol': [5.0, 30.0],
  'gpt-5.6-terra': [2.5, 15.0],
  'gpt-5.6-luna': [1.0, 6.0],
  'gpt-5.5': [5.0, 30.0],
  'gpt-5.5-pro': [30.0, 180.0],
  'gpt-5.4': [2.5, 15.0],
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-5.3-codex': [1.75, 14.0],
  // xAI
  'grok-4.5': [2.0, 6.0],
  'grok-4.3': [1.25, 2.5],
  'grok-build-0.1': [1.0, 2.0],
  // Google (Antigravity)
  'gemini-3.1-pro-preview': [2.0, 12.0], // ≤200k-token tier
  'gemini-3.5-flash': [1.5, 9.0],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  // Open-weights rate anchor, not a matchable id — reached only via the
  // `/gpt-oss/i` family rule and the `cerebras` provider default below, so it
  // always reports as approximate. `gpt-oss-*` is open-weights: unlike the
  // vendor-locked ids above, the model id does NOT identify the host, and rates
  // differ per host — so no bare `gpt-oss` id may claim `matched: 'exact'` (that
  // suppresses the UI's `~` marker). Cerebras's published rate is the anchor
  // because Cerebras is the only gpt-oss host PortOS ships; it is a far better
  // estimate for any host than the `/gpt/i` rule's $2.50/$15.00 GPT-5.4 rates,
  // which is where these ids landed before (~10-20x too high).
  'gpt-oss-120b (cerebras)': [0.35, 0.75],
};

// Exact keys sorted longest-first for the substring pass in
// resolveModelRates — a suffixed/prefixed variant of a known id
// (`gpt-5.6-terra-2026-06-01`, `global.anthropic.claude-opus-5`) resolves to
// its base rates without needing a hand-written regex per model, and
// longest-first makes `gpt-5.5-pro` win over `gpt-5.5`. (Keys are all
// lowercase, so matching against a lowercased id needs no re-mapping.)
const EXACT_KEYS_BY_LENGTH = Object.keys(EXACT_RATES).sort((a, b) => b.length - a.length);

/**
 * Ordered family rules — first regex that matches the model id wins. Covers
 * CLI shorthand (`opus`, `sonnet`), family names the exact table doesn't
 * list, and the `*-configured-default` sentinels (the sentinel strings
 * contain their provider family name).
 */
const FAMILY_RULES = [
  { test: /fable|mythos/i, rateModel: FABLE_MODEL_IDS[0] },
  // Reports the newest listed opus id (see OPUS_MODEL_IDS) — the whole tier
  // shares one rate pair, so the pointer only supplies the label, and deriving
  // it means an opus bump never has to edit this line.
  { test: /opus/i, rateModel: OPUS_MODEL_IDS[0] },
  { test: /sonnet[-.]?5/i, rateModel: 'claude-sonnet-5' },
  { test: /sonnet/i, rateModel: 'claude-sonnet-4-5' },
  { test: /haiku/i, rateModel: 'claude-haiku-4-5' },
  { test: /codex/i, rateModel: 'gpt-5.3-codex' },
  // `gpt-oss-*` is open-weights and hosted cheaply everywhere — it must win over
  // the proprietary `/gpt/i` rule below, which would bill it at ~10-20x. Every
  // size/host lands here (never `exact`) since the id alone can't price it.
  { test: /gpt-oss/i, rateModel: 'gpt-oss-120b (cerebras)' },
  { test: /gpt/i, rateModel: 'gpt-5.4' },
  { test: /grok-build/i, rateModel: 'grok-build-0.1' },
  { test: /grok-4\.20/i, rateModel: 'grok-4.3' },
  { test: /grok/i, rateModel: 'grok-4.5' },
  { test: /gemini|antigravity/i, rateModel: 'gemini-3.1-pro-preview' },
];

/** Per-provider default when the model id resolves to no known family. */
const PROVIDER_DEFAULT_RULES = [
  { test: /claude/i, rateModel: 'claude-sonnet-4-5' },
  { test: /codex|openai/i, rateModel: 'gpt-5.3-codex' },
  { test: /grok|xai/i, rateModel: 'grok-4.5' },
  { test: /antigravity|agy|gemini|google/i, rateModel: 'gemini-3.1-pro-preview' },
  // Cerebras hosts a small, uniformly cheap catalog; its flagship's rates are a
  // far better estimate for an unrecognized id (e.g. a preview model picked up
  // by "Refresh models") than the generic $3/$15 fallback.
  { test: /cerebras/i, rateModel: 'gpt-oss-120b (cerebras)' },
];

// Legacy blended estimate (the old flat usage.js rate) — the last resort for a
// provider/model pair nothing above recognizes.
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
 *   - OpenAI: 0.1x cached input; only gpt-5.6 lists a separate cache-write rate
 *     (~1.25x), and Codex reports no cache-write tokens at all.
 *   - xAI: cached prompt tokens run 0.15-0.20x depending on the model (0.15x on
 *     grok-4.5); no published cache-write surcharge.
 *   - Google: 0.1x cached input, plus an hourly storage fee we do not model
 *     (PortOS records no cache duration to price it against).
 *
 * The default matches Anthropic/OpenAI (0.1x / 1.25x), which covers every
 * provider that actually reports cache tokens to PortOS today — Claude Code and
 * Codex are the only CLIs that write per-message cache counts to disk (see
 * `lib/providerTranscriptUsage.js`), so any other family's multiplier applies to
 * a token count that is currently always 0.
 *
 * Fable 5.1 is a one-off exception to that default: its cache-read rate dropped
 * 75% ($1.00 -> $0.25 per 1M, i.e. 0.1x -> 0.025x its $10 input rate) while
 * cache-write stayed at the standard 1.25x — Fable 5's own cache tiers are
 * unchanged, so the override is scoped to the `-5-1` id rather than the whole
 * `/fable/i` family.
 */
const DEFAULT_CACHE_MULTIPLIERS = { read: 0.1, write: 1.25 };
const CACHE_MULTIPLIER_RULES = [
  { test: /^grok/, read: 0.15, write: 1.25 },
  { test: /^claude-fable-5-1/, read: 0.025, write: 1.25 },
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
  const { read, write } = cacheMultipliers(rates.rateModel);
  return {
    ...rates,
    cacheReadPer1M: rates.inputPer1M * read,
    cacheWritePer1M: rates.inputPer1M * write,
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
 *   matched: 'exact'|'family'|'providerDefault'|'fallback' }}
 */
export function resolveModelRates(providerId, model) {
  const id = typeof model === 'string' ? model.trim() : '';
  if (id && EXACT_RATES[id]) {
    return { ...toRates(id), matched: 'exact' };
  }
  if (id) {
    const lower = id.toLowerCase();
    const embedded = EXACT_KEYS_BY_LENGTH.find((key) => lower.includes(key));
    if (embedded) {
      return { ...toRates(embedded), matched: 'family' };
    }
    for (const rule of FAMILY_RULES) {
      if (rule.test.test(id)) {
        return { ...toRates(rule.rateModel), matched: 'family' };
      }
    }
  }
  const pid = typeof providerId === 'string' ? providerId : '';
  for (const rule of PROVIDER_DEFAULT_RULES) {
    if (rule.test.test(pid)) {
      return { ...toRates(rule.rateModel), matched: 'providerDefault' };
    }
  }
  return { ...withCacheRates(FALLBACK_RATES), matched: 'fallback' };
}

// Mirrors promptRunner.js's LOCAL_ENDPOINT_RE (scheme optional, unbracketed
// ::1 accepted) so the concurrency gate and the cost report agree on what
// "local" means. Duplicated rather than imported because modelPricing must
// stay a leaf module — promptRunner pulls in the whole runner/provider graph.
const LOCALHOST_ENDPOINT = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
const FREE_ID = /ollama|lmstudio|lm-studio/i;

// Ollama/LM Studio name their models `family:tag` — `qwen3.6:35b`,
// `llama3.1:8b-instruct-q8_0` — or `org/repo` for a pulled GGUF.
//
// A bare `:` test is NOT safe: Bedrock model ids carry a `:0` version suffix
// (`us.anthropic.claude-opus-4-5-20251101-v1:0`), so matching any colon would
// price real, paid Bedrock usage at $0. The distinguishing feature is what
// follows the colon — an Ollama tag is a size/quantization label
// (`qwen3.6:35b`, `llama3.1:8b-instruct-q8_0`), never a bare integer version
// the way a Bedrock `-v1:0` suffix is. Requiring at least one letter after the
// colon separates the two. (Ollama family names may contain dots — `qwen3.6` —
// so the prefix must allow them.)
const LOCAL_TAGGED_MODEL = /^[\w.-]+:[\w.-]*[a-z][\w.-]*$/i;

// The `org/repo` GGUF form is NOT a local marker on its own: paid hosted
// catalogs use the same shape (`cohere/command-r`, OpenRouter's
// `provider/model`), and pricing an unknown one at $0 under-bills real usage.
// Only the tagged form above is self-evidently an Ollama/LM Studio id, so a
// slash-form id needs corroborating evidence from the PROVIDER — which is what
// `isFreeProvider` already supplies — rather than being inferred from syntax.

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
  // A hosted id we have a real rate for is never local, whatever its shape.
  if (EXACT_RATES[id]) return false;
  // Nor is one that resolves to a known hosted family (covers Bedrock-prefixed
  // and suffixed variants of every id in the table).
  if (resolveModelRates(null, id).matched !== 'fallback') return false;
  if (FREE_ID.test(id)) return true;
  return LOCAL_TAGGED_MODEL.test(id);
}

/**
 * True when a provider's usage is free — local inference (Ollama, LM Studio,
 * any Ollama-/MTPLX-/llama-/vLLM-backed CLI wrapper, or an API provider pointed at localhost).
 * Accepts a provider config object or a bare provider-id string (usage records
 * can outlive their provider config).
 * @param {object|string|null|undefined} providerOrId
 * @returns {boolean}
 */
export function isFreeProvider(providerOrId) {
  if (providerOrId == null) return false;
  if (typeof providerOrId === 'string') return FREE_ID.test(providerOrId);
  const p = providerOrId;
  if (p.ollamaBacked === true || p.mtplxBacked === true || p.llamaBacked === true || p.vllmBacked === true || p.sglangBacked === true) return true;
  if (FREE_ID.test(p.id || '') || FREE_ID.test(p.command || '')) return true;
  if (typeof p.endpoint === 'string' && LOCALHOST_ENDPOINT.test(p.endpoint.trim())) return true;
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
 *
 * The cache argument is optional so the three-positional-argument form keeps
 * working for records that predate cache capture (absent = 0, no cache cost).
 *
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
