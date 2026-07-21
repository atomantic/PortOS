import { ServerError } from '../lib/errorHandler.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { ensureBackendProvider } from './localLlm.js';
import { getProviderById } from './providers.js';
import { markProviderAvailable } from './providerStatus.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
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

export function summarizeTimings({ startedAt, firstChunkAt, endedAt, text }) {
  const totalMs = endedAt - startedAt;
  const ttftMs = firstChunkAt ? firstChunkAt - startedAt : null;
  const chars = text.length;
  // A sub-millisecond total makes a rate meaningless — report n/a (null)
  // rather than `chars`, which would surface the char COUNT as a chars/sec rate.
  const charsPerSecond = totalMs > 0 ? Number((chars / (totalMs / 1000)).toFixed(2)) : null;
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    ttftMs,
    totalMs,
    chars,
    charsPerSecond,
  };
}

// Parse one OpenAI-style SSE `data:` line into its content/reasoning delta.
// Returns null for non-data lines, the [DONE]/✅ sentinels, or a malformed
// frame: a single bad frame must SKIP, not abort the stream — one non-JSON
// keep-alive would otherwise throw out of the read loop and discard every
// token already received.
export function extractStreamDelta(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]' || data === '✅') return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  return { content: delta?.content || '', reasoning: delta?.reasoning || '' };
}

export function buildMessages({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ];
}

// Resolve the text to surface from a (possibly interrupted) stream: prefer the
// visible content, fall back to reasoning when no content arrived (some models
// emit only a reasoning channel), and '' when neither did. Used on both the
// normal-finish path and the partial-output-on-throw path so a timed-out run
// still shows what streamed before the abort.
export function resolvePartialOutput({ output = '', reasoning = '' }) {
  if (output.trim()) return output;
  if (reasoning.trim()) return reasoning;
  return '';
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

async function streamChatCompletion({ provider, backend, modelId, prompt, systemPrompt, temperature, maxTokens, signal, onChunk }) {
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

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelId,
      messages: buildMessages({ systemPrompt, prompt }),
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...(Number(provider.numCtx) > 0 ? { num_ctx: Number(provider.numCtx) } : {}),
    }),
  }).catch((err) => ({ ok: false, status: 0, error: err.message }));

  if (!response.ok) {
    const body = response.text ? await response.text().catch(() => '') : response.error || '';
    throw new Error(`Provider returned ${response.status || 0}: ${body || response.error || response.statusText || 'request failed'}`);
  }

  if (!response.body?.getReader) {
    // Sentinel fallback: a non-JSON/blank 200 body must throw (caught by
    // runLocalLlmTest → finalizeRunRecord success:false), not return '' — which
    // line 205 would persist as a successful empty run. Mirrors the pre-helper
    // response.json() throw; a valid body with empty content is unchanged.
    const data = await readResponseJson(response, { fallback: null, emptyValue: null });
    if (!data) {
      throw new Error(`Provider returned a non-JSON response (${response.status})`);
    }
    const text = data.choices?.[0]?.message?.content || '';
    if (text) await onChunk(text, 'content');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoning = '';

  const consumeLine = async (rawLine) => {
    const delta = extractStreamDelta(rawLine);
    if (!delta) return;
    if (delta.content) {
      output += delta.content;
      await onChunk(delta.content, 'content');
    }
    // Stream reasoning live too, on its own channel, so a reasoning-only model
    // (deepseek-r1, qwq, …) renders its chain-of-thought as it arrives instead
    // of sitting on "Waiting for the first token…" until the whole run lands.
    // Kept distinct from content so the live panel can label it and so the
    // final content-only `text` doesn't inherit reasoning prose.
    if (delta.reasoning) {
      reasoning += delta.reasoning;
      await onChunk(delta.reasoning, 'reasoning');
    }
  };

  // Always release the reader (and tear down the socket) on every exit path —
  // a normal finish, an abort via the timeout signal, or a throw mid-stream.
  // On a throw (e.g. an AbortError from the timeout) surface the tokens already
  // streamed by attaching them to the error, so runLocalLlmTest can render the
  // partial output alongside the timeout message instead of discarding it.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await consumeLine(line);
    }
    if (buffer.trim()) await consumeLine(buffer);
  } catch (err) {
    err.partialOutput = resolvePartialOutput({ output, reasoning });
    throw err;
  } finally {
    await reader.cancel().catch(() => {});
  }

  // Both channels already streamed live via onChunk, so there's no end-of-stream
  // re-emit here — re-pushing `resolved` would double the reasoning-only output
  // the client just received. We only resolve the final text for the result record.
  return resolvePartialOutput({ output, reasoning });
}

export async function runLocalLlmTest({
  backend,
  modelId,
  prompt,
  systemPrompt = '',
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
  signal: clientSignal,
  // Optional per-token callback `onToken(delta, kind)` where kind is 'content'
  // or 'reasoning'. When provided (streaming route), each delta is forwarded as
  // it arrives so the client can render live output (reasoning on its own
  // channel). The returned result is unchanged, so non-streaming callers ignore
  // this entirely.
  onToken,
}) {
  const provider = await resolveLocalProvider(backend);
  const fullPrompt = buildPrompt({ systemPrompt, prompt });
  const startedAt = Date.now();
  let firstChunkAt = null;
  let runId = null;

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
      temperature,
      maxTokens,
      signal,
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
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text }),
      options: { temperature, maxTokens, timeoutMs },
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
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text: partialText }),
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
