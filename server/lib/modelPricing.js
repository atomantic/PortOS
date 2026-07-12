/**
 * Per-model API billing rates for the "what would this have cost" estimates on
 * /devtools/usage. PortOS runs on provider subscriptions, so these numbers are
 * informational only — they answer "what would the recorded usage have cost
 * under API billing," never an actual bill.
 *
 * Rates are USD per 1M tokens (standard input/output only — prompt-caching,
 * batch, and long-context tier discounts are deliberately ignored; PortOS does
 * not capture cache hits, and the UI discloses the approximation). Verified
 * against the official pricing pages on PRICING_AS_OF:
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   - https://developers.openai.com/api/docs/pricing
 *   - https://docs.x.ai/docs/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 *
 * Model ids arrive in many shapes (full ids, CLI sentinels like `opus`, the
 * `*-configured-default` sentinels from providerModels.js, Bedrock-prefixed
 * ids), so resolution is exact-id first, then ordered family regexes, then a
 * per-provider default, then a generic fallback — `matched` reports which tier
 * answered so the UI can flag approximate rows.
 */

export const PRICING_AS_OF = '2026-07-12';

/** USD per 1M tokens: [input, output]. Exact model-id matches. */
const EXACT_RATES = {
  // Anthropic
  'claude-fable-5': [10.0, 50.0],
  'claude-mythos-5': [10.0, 50.0],
  'claude-opus-4-8': [5.0, 25.0],
  'claude-opus-4-7': [5.0, 25.0],
  'claude-opus-4-6': [5.0, 25.0],
  'claude-opus-4-5': [5.0, 25.0],
  'claude-sonnet-5': [2.0, 10.0], // intro pricing through 2026-08-31 ($3/$15 after)
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
};

// Exact keys sorted longest-first for the substring pass in
// resolveModelRates — a suffixed/prefixed variant of a known id
// (`gpt-5.6-terra-2026-06-01`, `global.anthropic.claude-opus-4-8`) resolves to
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
  { test: /fable|mythos/i, rateModel: 'claude-fable-5' },
  { test: /opus/i, rateModel: 'claude-opus-4-8' },
  { test: /sonnet[-.]?5/i, rateModel: 'claude-sonnet-5' },
  { test: /sonnet/i, rateModel: 'claude-sonnet-4-5' },
  { test: /haiku/i, rateModel: 'claude-haiku-4-5' },
  { test: /codex/i, rateModel: 'gpt-5.3-codex' },
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
];

// Legacy blended estimate (the old flat usage.js rate) — the last resort for a
// provider/model pair nothing above recognizes.
const FALLBACK_RATES = { rateModel: null, inputPer1M: 3.0, outputPer1M: 15.0 };

const toRates = (rateModel) => ({
  rateModel,
  inputPer1M: EXACT_RATES[rateModel][0],
  outputPer1M: EXACT_RATES[rateModel][1],
});

/**
 * Resolve billing rates for a (providerId, model) pair.
 * @param {string|null|undefined} providerId
 * @param {string|null|undefined} model
 * @returns {{ rateModel: string|null, inputPer1M: number, outputPer1M: number,
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
  return { ...FALLBACK_RATES, matched: 'fallback' };
}

// Mirrors promptRunner.js's LOCAL_ENDPOINT_RE (scheme optional, unbracketed
// ::1 accepted) so the concurrency gate and the cost report agree on what
// "local" means. Duplicated rather than imported because modelPricing must
// stay a leaf module — promptRunner pulls in the whole runner/provider graph.
const LOCALHOST_ENDPOINT = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
const FREE_ID = /ollama|lmstudio|lm-studio/i;

/**
 * True when a provider's usage is free — local inference (Ollama, LM Studio,
 * any `ollamaBacked` CLI wrapper, or an API provider pointed at localhost).
 * Accepts a provider config object or a bare provider-id string (usage records
 * can outlive their provider config).
 * @param {object|string|null|undefined} providerOrId
 * @returns {boolean}
 */
export function isFreeProvider(providerOrId) {
  if (providerOrId == null) return false;
  if (typeof providerOrId === 'string') return FREE_ID.test(providerOrId);
  const p = providerOrId;
  if (p.ollamaBacked === true) return true;
  if (FREE_ID.test(p.id || '') || FREE_ID.test(p.command || '')) return true;
  if (typeof p.endpoint === 'string' && LOCALHOST_ENDPOINT.test(p.endpoint.trim())) return true;
  return false;
}

/**
 * Estimated USD cost for a token count under the given rates. Returns the raw
 * float — callers round for display.
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {{inputPer1M: number, outputPer1M: number}} rates
 * @returns {number}
 */
export function estimateCostUsd(tokensIn, tokensOut, rates) {
  const input = ((tokensIn || 0) / 1_000_000) * (rates?.inputPer1M || 0);
  const output = ((tokensOut || 0) / 1_000_000) * (rates?.outputPer1M || 0);
  return input + output;
}
