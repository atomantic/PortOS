import { ServerError } from '../lib/errorHandler.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { ensureBackendProvider } from './localLlm.js';
import { getProviderById } from './providers.js';
import { markProviderAvailable } from './providerStatus.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
// The SSE read loop lives in `lib/openAiChatStream.js` so the assessments
// service can measure a bare loopback daemon that has no provider record.
import { buildMessages, streamOllamaChat, streamOpenAiChat } from '../lib/openAiChatStream.js';
import { assertSecretEndpoint } from '../lib/aiToolkit/internal/endpointGuard.js';

const PROVIDER_BY_BACKEND = { ollama: 'ollama', lmstudio: 'lmstudio' };

// Human-readable record of what was asked, stored on the run for /runs replay.
// This is NOT the wire format — the API receives the structured `buildMessages`
// array; the synthetic "System instructions:/User prompt:" framing here exists
// only so the run viewer shows one readable blob.
export function buildPrompt({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  if (!system) return prompt;
  return `System instructions:\n${system}\n\nUser prompt:\n${prompt}`;
}

/**
 * Collapse one generation's clock readings (and, when the daemon reported them,
 * its token counts) into the numbers PortOS records.
 *
 * ## Why tokens/s is decode-only
 *
 * `tokensPerSecond` divides the completion tokens by the time spent GENERATING
 * them — wall clock minus time-to-first-token — because that is what "tokens per
 * second" means everywhere else in the local-LLM world (llama.cpp's `eval time`,
 * Ollama's `eval_count / eval_duration`). Including prefill would make the same
 * model look several times slower at 16k context than at 512 for a reason that
 * has nothing to do with its decode speed, and TTFT is already reported beside
 * it. Prefill gets its own honest number, `promptTokensPerSecond`.
 *
 * @param {{ completionTokens: number|null, promptTokens: number|null, estimated: boolean }} [usage]
 *   token counts from `streamOpenAiChat`'s `onStats`. Absent entirely for a
 *   caller that does not track usage, which records `null` — not zero.
 */
export function summarizeTimings({ startedAt, firstChunkAt, endedAt, text, usage }) {
  const totalMs = endedAt - startedAt;
  const ttftMs = firstChunkAt ? firstChunkAt - startedAt : null;
  const chars = text.length;
  // A sub-millisecond total makes a rate meaningless — report n/a (null)
  // rather than `chars`, which would surface the char COUNT as a chars/sec rate.
  const charsPerSecond = totalMs > 0 ? Number((chars / (totalMs / 1000)).toFixed(2)) : null;

  const completionTokens = Number.isFinite(usage?.completionTokens) ? usage.completionTokens : null;
  const promptTokens = Number.isFinite(usage?.promptTokens) ? usage.promptTokens : null;
  // Decode window: everything after the first token arrived. Falls back to the
  // full wall clock when TTFT was never observed (a non-streamed response), which
  // understates the rate rather than inventing a prefill split that wasn't seen.
  const reportedDecodeMs = Number.isFinite(usage?.completionMs) && usage.completionMs > 0
    ? usage.completionMs
    : null;
  const reportedPromptMs = Number.isFinite(usage?.promptMs) && usage.promptMs > 0
    ? usage.promptMs
    : null;
  const decodeMs = reportedDecodeMs ?? (Number.isFinite(ttftMs) ? totalMs - ttftMs : totalMs);
  const rate = (tokens, ms) =>
    (Number.isFinite(tokens) && tokens > 0 && ms > 0 ? Number((tokens / (ms / 1000)).toFixed(2)) : null);

  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    ttftMs,
    totalMs,
    chars,
    charsPerSecond,
    // `null` throughout = the daemon reported no usage and nothing streamed to
    // count. Never 0, which a reader would take for a measured standstill.
    completionTokens,
    promptTokens,
    tokensPerSecond: rate(completionTokens, decodeMs),
    // Prompt processing (prefill) speed: how fast the daemon chewed through the
    // context before the first token. Needs BOTH a prompt-token count and a
    // measured TTFT, so it is null on a non-streamed response.
    promptTokensPerSecond: reportedPromptMs
      ? rate(promptTokens, reportedPromptMs)
      : (Number.isFinite(ttftMs) ? rate(promptTokens, ttftMs) : null),
    // Native Ollama reports these directly. Keeping them in the sample makes
    // the report auditable and avoids forcing readers to reverse the rates.
    decodeMs: reportedDecodeMs,
    promptMs: reportedPromptMs,
    // Whether the token count came from the daemon's own tokenizer (`false`) or
    // from counting streamed frames (`true`). `null` = no token count at all.
    // A consumer must label an estimate as one — PortOS has no tokenizer, and
    // presenting a frame count as a measurement is the thing this flag prevents.
    tokensEstimated: completionTokens === null ? null : Boolean(usage?.estimated),
  };
}

async function resolveLocalProvider(backend) {
  const providerId = PROVIDER_BY_BACKEND[backend];
  if (!providerId) {
    throw new ServerError(`Unsupported local LLM backend: ${backend}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  await ensureBackendProvider(backend);
  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new ServerError(`Local provider "${providerId}" is not configured`, { status: 503, code: 'LOCAL_LLM_PROVIDER_MISSING' });
  }
  if (provider.type !== 'api') {
    throw new ServerError(`Local provider "${providerId}" must be an API provider`, { status: 503, code: 'LOCAL_LLM_PROVIDER_INVALID' });
  }
  await markProviderAvailable(provider.id).catch(() => {});
  return provider;
}

async function streamChatCompletion({ provider, backend, modelId, prompt, systemPrompt, images, temperature, maxTokens, extraBody = {}, signal, onChunk, onStats, nativeOllamaUsage = false }) {
  if (backend === 'ollama') {
    const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      throw new Error(`Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`);
    }
  }

  // Guard before attaching the API key so a hostile/mistyped endpoint on the
  // (normally keyless) ollama/lmstudio provider records can't harvest a key
  // or reach a cloud-metadata service (SSRF). No-ops when apiKey is unset.
  assertSecretEndpoint(provider.endpoint, {
    hasSecret: Boolean(provider.apiKey),
    allowCustomEndpoint: provider.allowCustomEndpoint === true,
  });

  const stream = backend === 'ollama' && nativeOllamaUsage ? streamOllamaChat : streamOpenAiChat;
  return stream({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: modelId,
    messages: buildMessages({ systemPrompt, prompt, images }),
    temperature,
    maxTokens,
    // The caller's knobs win over the provider default, so a caller measuring a
    // specific value is never silently run at the provider's. (Ollama is not one
    // of those callers: its OpenAI-compatible endpoint drops unknown body fields,
    // so its context window is a daemon-restart knob — see the transport rule in
    // `lib/localModelTuning.js` and `ollamaManager.ensureContextWindow`.)
    extraBody: { ...(Number(provider.numCtx) > 0 ? { num_ctx: Number(provider.numCtx) } : {}), ...extraBody },
    signal,
    onChunk,
    // Registering `onStats` is what asks the daemon for token counts; a runtime
    // that does not support the ask is handled inside `streamOpenAiChat`.
    onStats,
  });
}

export async function runLocalLlmTest({
  backend,
  modelId,
  prompt,
  systemPrompt = '',
  // Base64 data URLs sent alongside the prompt as `image_url` parts — how the
  // vision capability test asks a model to look at the fixture. Empty for every
  // text-only caller, which keeps the plain string `content` shape.
  images,
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
  // Backend-specific request knobs merged into the chat-completions body (see
  // `lib/localModelTuning.js#requestBody`). Empty for a plain playground run.
  extraBody = {},
  signal: clientSignal,
  // Optional per-token callback `onToken(delta, kind)` where kind is 'content'
  // or 'reasoning'. When provided (streaming route), each delta is forwarded as
  // it arrives so the client can render live output (reasoning on its own
  // channel). The returned result is unchanged, so non-streaming callers ignore
  // this entirely.
  onToken,
  // The Performance page opts into Ollama's native API so exact eval counts and
  // decode/prefill durations survive. Normal playground runs stay on the same
  // OpenAI-compatible path OpenCode uses.
  nativeOllamaUsage = false,
}) {
  const provider = await resolveLocalProvider(backend);
  const fullPrompt = buildPrompt({ systemPrompt, prompt });
  const startedAt = Date.now();
  let firstChunkAt = null;
  let runId = null;
  // Filled by the stream's terminal usage frame (or the frame-count fallback).
  // Stays null until then so a run that died before any frame records "no token
  // count" rather than a fabricated zero.
  let usage = null;
  const onStats = (stats) => { usage = stats; };

  try {
    const run = await createRun({
      providerId: provider.id,
      model: modelId,
      prompt: fullPrompt,
      source: 'local-llm-playground',
      timeout: timeoutMs,
    });
    runId = run.runId;
    if (run.usedFallback || run.provider?.id !== provider.id) {
      throw new Error(`Local LLM playground refused fallback provider for ${provider.id}`);
    }

    // The timeout controller aborts the upstream read (its plain AbortError keeps
    // the "Timed out after Xms" mapping below). A client disconnect — the user hit
    // Cancel, closing the browser fetch — aborts `clientSignal`; `anyAbortSignal`
    // composes both so whichever fires first tears down the upstream reader instead
    // of running on to the full timeout with no one listening.
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = anyAbortSignal([clientSignal, timeoutController.signal]);
    const text = await streamChatCompletion({
      provider,
      backend,
      modelId,
      prompt,
      systemPrompt,
      images,
      temperature,
      maxTokens,
      extraBody,
      signal,
      nativeOllamaUsage,
      onStats,
      onChunk: (chunk, kind = 'content') => {
        // First token of EITHER channel marks TTFT: for a reasoning model the
        // first thing it emits is reasoning, so timing it from that chunk is the
        // honest time-to-first-token (previously reasoning-only runs reported a
        // null TTFT because reasoning never reached this callback).
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
        // Await the consumer so socket backpressure from the streaming route
        // propagates back up to the upstream read loop (pauses reading until the
        // client drains). Non-streaming callers pass no onToken, so this no-ops.
        if (chunk) return onToken?.(chunk, kind);
        return undefined;
      },
    }).finally(() => clearTimeout(timeoutHandle));

    const endedAt = Date.now();
    await finalizeRunRecord({ runId, output: text, exitCode: 0, success: true, startTime: startedAt });
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      text,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text, usage }),
      options: { temperature, maxTokens, timeoutMs, nativeOllamaUsage },
    };
  } catch (err) {
    const endedAt = Date.now();
    const error = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || 'Local LLM test failed';
    // A timeout/abort mid-stream still has tokens worth keeping — surface what the
    // model already streamed (attached to the error by streamChatCompletion) instead
    // of discarding it. Persist it on the failed run record too so /runs replay shows it.
    // (TTFT is recorded even for a reasoning-only partial now, since reasoning deltas
    // mark first-chunk timing too.)
    const partialText = typeof err?.partialOutput === 'string' ? err.partialOutput : '';
    if (runId) {
      await finalizeRunRecord({
        runId,
        output: partialText,
        exitCode: 1,
        success: false,
        error,
        startTime: startedAt,
      }).catch(() => {});
    }
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      error,
      text: partialText,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text: partialText, usage }),
      options: { temperature, maxTokens, timeoutMs, nativeOllamaUsage },
    };
  }
}

/**
 * Measure one generation against a bare OpenAI-compatible loopback daemon —
 * llama.cpp, MTPLX, or vLLM — that PortOS does NOT hold a provider record for.
 *
 * Returns the same shape as `runLocalLlmTest` (text / error / timings) so the
 * assessment sampler treats every runtime identically. What it deliberately
 * does NOT do is create a `/runs` record: `createRun` resolves a configured
 * provider, and inventing one for a daemon the user started outside PortOS
 * would put a phantom provider in the runs history.
 *
 * @param {object} options
 * @param {string} options.runtime runtime id, echoed back on the result
 * @param {string} options.endpoint OpenAI-compatible base ending in `/v1`
 */
export async function runEndpointLlmTest({
  runtime,
  endpoint,
  // Empty for the usual unauthenticated loopback daemon; set for a vLLM
  // container started behind `VLLM_API_KEY`, which 401s without it.
  apiKey = '',
  modelId,
  prompt,
  systemPrompt = '',
  // See `runLocalLlmTest` — base64 data URLs for a vision request.
  images,
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
  extraBody = {},
  signal: clientSignal,
  onToken,
}) {
  const startedAt = Date.now();
  let firstChunkAt = null;
  let usage = null;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = anyAbortSignal([clientSignal, timeoutController.signal]);

  try {
    const text = await streamOpenAiChat({
      endpoint,
      apiKey,
      model: modelId,
      messages: buildMessages({ systemPrompt, prompt, images }),
      temperature,
      maxTokens,
      extraBody,
      signal,
      onStats: (stats) => { usage = stats; },
      onChunk: (chunk, kind = 'content') => {
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
        if (chunk) return onToken?.(chunk, kind);
        return undefined;
      },
    }).finally(() => clearTimeout(timeoutHandle));
    return {
      backend: runtime,
      modelId,
      endpoint,
      text,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt: Date.now(), text, usage }),
      options: { temperature, maxTokens, timeoutMs },
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    const error = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || 'Local LLM test failed';
    const partialText = typeof err?.partialOutput === 'string' ? err.partialOutput : '';
    return {
      backend: runtime,
      modelId,
      endpoint,
      error,
      text: partialText,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt: Date.now(), text: partialText, usage }),
      options: { temperature, maxTokens, timeoutMs },
    };
  }
}

export async function compareLocalLlmModels({ targets, prompt, mode = 'round-robin', options = {}, signal }) {
  const runOne = (target) => runLocalLlmTest({ ...options, ...target, prompt, signal });
  const results = [];

  if (mode === 'parallel') {
    return {
      mode,
      prompt,
      results: await Promise.all(targets.map(runOne)),
    };
  }

  for (const target of targets) {
    // `runLocalLlmTest` swallows aborts into a result object rather than throwing,
    // so without this guard a cancel mid-sequence would still kick off every
    // remaining model. Stop the round-robin once the client has hung up.
    if (signal?.aborted) break;
    results.push(await runOne(target));
  }
  return { mode: 'round-robin', prompt, results };
}
