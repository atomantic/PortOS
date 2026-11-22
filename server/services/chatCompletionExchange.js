/**
 * One bounded (non-streaming) OpenAI-compatible chat completion: the request a
 * caller makes when it wants a whole answer back with its own sampling and a
 * wall-clock deadline, plus the single recovery retry that goes with it.
 *
 * This is the wire half only. It writes no run record and no usage: the shared
 * runner (`apiCompletionRun.js`, reached through
 * `promptRunner.runPromptThroughProvider({ completion })`) owns those. Only
 * toolkit-less callers use this exchange directly without a run store.
 *
 * The request body is exactly `{ model, messages, temperature, max_tokens }`, plus OpenRouter's
 * `provider` routing object when the endpoint is OpenRouter and one is configured.
 * The streaming executor adds `stream` and provider-level sampling defaults and
 * reports no token counts; none of that may change under a caller that already
 * depends on this shape, so the two request shapes stay distinct.
 *
 * The one exception is an Ollama provider with a `numCtx`: `/v1/chat/completions`
 * cannot carry a context window, so the daemon would load the model at its
 * default and silently keep only the prompt's tail. That request goes to native
 * `/api/chat` with `options.num_ctx` instead, exactly as the streamed runner
 * does (`lib/aiToolkit/internal/ollamaNativeChat.js`), and its reply is read
 * into the same `{ text | error }` shape.
 */

import { readResponseJson } from '../lib/readResponseJson.js';
import { normalizeReviewFinishReason } from '../lib/reviewerHealth.js';
import { normalizeChatCompletionUsage } from '../lib/chatCompletionUsage.js';
import { evaluateSecretEndpoint } from '../lib/aiToolkit/endpointGuard.js';
import { buildOllamaNativeChatBody, ollamaNativeChatUrl } from '../lib/aiToolkit/internal/ollamaNativeChat.js';
import { contextWindowRejection } from '../lib/aiToolkit/providerStatus.js';
import { withOllamaRuntimeContextWindow } from '../lib/ollamaContext.js';
import { openRouterBodyFragment } from '../lib/aiToolkit/internal/generationOptions.js';
import { estimateTokens } from '../lib/contextBudget.js';

/**
 * The provider's reported token counts as usage-ledger fields, or `null` when
 * it reported none. A missing count stays missing: the caller estimates, it
 * never records a measured zero.
 */
function reportedUsageFields(normalized) {
  if (!normalized || !(normalized.inputTokens || normalized.outputTokens || normalized.cacheReadTokens)) return null;
  return {
    tokensIn: normalized.inputTokens,
    tokensOut: normalized.outputTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    cacheWriteTokens: normalized.cacheWriteTokens,
    ...(normalized.longContext ? {
      longTokensIn: normalized.inputTokens,
      longTokensOut: normalized.outputTokens,
      longCacheReadTokens: normalized.cacheReadTokens,
      longCacheWriteTokens: normalized.cacheWriteTokens,
    } : {}),
    source: 'measured',
  };
}

/**
 * Why this prompt provably cannot fit the provider's known context window, as
 * the message to refuse it with (naming both numbers), or `null`.
 *
 * The streamed path's pre-dispatch rule (`promptRunner.assertRequestFitsContext`)
 * on the prompt alone, since a completion declares no output reserve. It reads
 * only configured windows (`contextWindow`, the model catalog, `numCtx`, the
 * ambient Ollama ceiling) and skips that path's local `/models` probe, so a
 * completion sends nothing beyond its own request. An unknown window is never a
 * refusal. The prompt is refused whole, never cut.
 */
export function completionContextRefusal(provider, model, prompt) {
  const reason = contextWindowRejection(withOllamaRuntimeContextWindow(provider), model, { requiredContextTokens: estimateTokens(prompt) });
  if (!reason) return null;
  const message = `${provider.name || provider.id}${model ? ` (${model})` : ''}: ${reason}`;
  console.log(`📏 Refused before dispatch: ${message}`);
  return message;
}

/**
 * Where the completion goes, what it carries, and how its reply reads as the
 * OpenAI shape the classifier below expects.
 */
function completionWire(provider, model, prompt, { temperature, max_tokens }) {
  const nativeUrl = ollamaNativeChatUrl(provider);
  if (!nativeUrl) {
    return {
      url: `${provider.endpoint}/chat/completions`,
      body: { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens, ...openRouterBodyFragment(provider, model) },
      read: (data) => data,
    };
  }
  return {
    url: nativeUrl,
    body: {
      ...buildOllamaNativeChatBody({ model, messageContent: prompt, provider, generation: { temperature }, maxTokens: max_tokens }),
      stream: false,
    },
    // Native replies carry `message` and the counts at top level; a body
    // without `message` stays malformed rather than reading as an empty answer.
    read: (data) => ({
      choices: data?.message ? [{ message: data.message, finish_reason: data.done_reason }] : undefined,
      usage: {
        ...(Number.isFinite(data?.prompt_eval_count) ? { prompt_tokens: data.prompt_eval_count } : {}),
        ...(Number.isFinite(data?.eval_count) ? { completion_tokens: data.eval_count } : {}),
      },
    }),
  };
}

/**
 * POST one completion and classify the reply.
 *
 * @returns {Promise<
 *   { text: string, finishReason: string|null, tokens?: number, usage?: object, reportedUsage?: object }
 *   | { error: string, status?: number, body?: string, stallPhase?: 'no-response'|'response-body' }>}
 *   `usage` is the caller-facing projection; `reportedUsage` is the same counts
 *   as usage-ledger fields.
 */
async function requestChatCompletion(provider, model, prompt, { temperature, max_tokens, timeout, signal }) {
  const wire = completionWire(provider, model, prompt, { temperature, max_tokens });
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    // Never send the API key to an arbitrary/metadata host (SSRF / key
    // exfiltration). Keyless local-LLM calls skip this guard entirely.
    const guard = evaluateSecretEndpoint(provider.endpoint, {
      allowCustomEndpoint: provider.allowCustomEndpoint === true,
    });
    if (!guard.allowed) {
      return { error: `Provider endpoint blocked: ${guard.reason}` };
    }
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  // Distinguishes the deadline from a caller cancel, and records how far the
  // exchange got, so a stalled provider reports WHERE it stalled (#13133).
  let timedOut = false;
  let stallPhase = 'no-response';
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  // The caller's cancellation, folded into the same controller as the deadline.
  // Without it, pressing Stop leaves the request running to its full timeout.
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    controller.signal.throwIfAborted();
    response = await fetch(wire.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(wire.body)
    });
    stallPhase = 'response-body';

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return { error: `Provider returned ${response.status}: ${errorText}`, status: response.status, body: errorText };
    }

    const data = wire.read(await readResponseJson(response));
    // A valid completion always carries `choices`; its absence means the 200 body
    // wasn't the expected JSON (e.g. a proxy HTML page). Surface that as an error
    // rather than masquerading a malformed body as an empty-but-successful reply.
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { error: 'Provider returned a malformed (non-JSON or unexpected) response body' };
    }
    // An empty/whitespace-only completion is unusable output, not a successful call —
    // same class as the malformed body above. Classifying it here keeps the `ai:status`
    // stream honest (a call that produced nothing must not report "done") and gives
    // callers a single "the provider failed" signal to test: `result.error`.
    if (!content.trim()) {
      return { error: 'Provider returned an empty completion' };
    }
    // OpenAI-compatible bodies report token counts under `usage`; surface the completion
    // token count so the AI Core landmark can size its activity beam by output volume
    // (tokens/sec). Absent on some providers — callers treat a missing count as "unknown".
    const normalized = normalizeChatCompletionUsage(data.usage, { model, endpoint: provider.endpoint });
    const reportedUsage = reportedUsageFields(normalized);
    const completionTokens = normalized ? normalized.outputTokens : (Number.isFinite(data.usage?.completion_tokens) ? data.usage.completion_tokens : NaN);
    return {
      text: content,
      finishReason: normalizeReviewFinishReason(data?.choices?.[0]?.finish_reason),
      tokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
      ...(normalized
        ? { usage: {
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          cacheReadTokens: normalized.cacheReadTokens,
          source: normalized.source,
        } }
        : {}),
      ...(reportedUsage ? { reportedUsage } : {}),
    };
  } catch (err) {
    // undici wraps the real network error in `fetch failed`; the actionable
    // detail (ECONNRESET, model-specific transport quirk, etc.) lives in
    // `err.cause` and is otherwise silently discarded (#7669).
    const cause = err.cause;
    const causeDetail = cause ? ` (cause: ${[cause.code, cause.message].filter(Boolean).join(' ')})` : '';
    const stalled = timedOut
      ? ` — timed out after ${timeout}ms ${stallPhase === 'no-response'
        ? 'before the provider sent response headers (connect or first byte)'
        : 'after response headers while the body was still streaming'}`
      : '';
    return { error: `Provider request failed: ${err.message}${causeDetail}${stalled}`, ...(timedOut ? { stallPhase } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Run one completion, with at most one recovery retry.
 *
 * `recover(failure, { signal })` is the caller's repair step for a failed first
 * attempt (a local backend with no model loaded, a model id that is not
 * installed). It resolves to the model id to retry with, or a falsy value to
 * leave the failure as the answer. The retry is part of the same call, so a
 * tracked run stays one run however the first attempt went. An aborted
 * `signal` ends the call at the first failure: no repair is started, a repair
 * in progress is handed the signal, and no retry is sent.
 *
 * @returns {Promise<object>} the reply `requestChatCompletion` gave, plus
 *   `model` (the id the answering request used) and `retried`.
 */
export async function runChatCompletion({ provider, model, prompt, temperature, maxTokens, timeout, signal, recover }) {
  const opts = { temperature, max_tokens: maxTokens, timeout, signal };
  const first = await requestChatCompletion(provider, model, prompt, opts);
  if (!first.error || typeof recover !== 'function' || signal?.aborted) return { ...first, model, retried: false };
  const retryModel = await recover(first, { signal });
  if (!retryModel || signal?.aborted) return { ...first, model, retried: false };
  // The caller judged only the first model's window; a repaired model may
  // have a smaller one, and its retry is refused rather than cut the same way.
  const refusal = completionContextRefusal(provider, retryModel, prompt);
  if (refusal) return { error: refusal, model: retryModel, retried: false };
  const retry = await requestChatCompletion(provider, retryModel, prompt, opts);
  return { ...retry, model: retryModel, retried: true };
}
