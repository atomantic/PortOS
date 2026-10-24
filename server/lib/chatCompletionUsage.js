/**
 * OpenAI-compatible `usage` objects do not all include tokens the same way.
 *
 * xAI's chat-completions example is prompt_tokens 32 + completion_tokens 9 +
 * reasoning_tokens 94 = total_tokens 135, so reasoning is OUTSIDE completion
 * and has to be added. OpenAI includes reasoning inside completion_tokens;
 * adding it there would bill it twice. Cached tokens are a subset of
 * prompt_tokens on both (xAI's prompt-caching guide: a later turn can report
 * prompt 120 of which 50 are cached).
 *
 * A parsed endpoint host wins over the model id. `api.x.ai` and `us.api.x.ai`
 * are xAI. Any other host is not, even when the model id starts with `grok`
 * (a proxy in front of a different vendor). With no parseable endpoint, a
 * `grok*` model is xAI. A provider id alone is not a signal.
 */

import { GROK_LONG_CONTEXT_PROMPT_TOKENS } from './modelPricing.js';

const XAI_HOSTS = new Set(['api.x.ai', 'us.api.x.ai']);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function endpointHost(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return '';
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isXaiChatUsage({ endpoint, model } = {}) {
  const host = endpointHost(endpoint);
  if (host) return XAI_HOSTS.has(host);
  return /^grok/i.test(String(model || '').trim());
}

/**
 * Split one chat-completions `usage` body into the ledger's buckets.
 * @param {object|null|undefined} usage
 * @param {{ model?: string, endpoint?: string }} [context]
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, promptTokens: number, longContext: boolean,
 *   source: 'measured' }|null} null when the body carries no finite counts.
 */
export function normalizeChatCompletionUsage(usage, { model, endpoint } = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const promptField = usage.prompt_tokens;
  const completionField = usage.completion_tokens;
  const cachedField = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
  const reasoningField = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const present = [promptField, completionField, cachedField, reasoningField]
    .some((value) => typeof value === 'number' && Number.isFinite(value));
  if (!present) return null;

  const prompt = num(promptField);
  const completion = num(completionField);
  const cached = Math.min(prompt, Math.max(0, num(cachedField)));
  const reasoning = Math.max(0, num(reasoningField));
  const xai = isXaiChatUsage({ endpoint, model });
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: xai ? completion + reasoning : completion,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    promptTokens: prompt,
    longContext: xai && prompt >= GROK_LONG_CONTEXT_PROMPT_TOKENS,
    source: 'measured',
  };
}
