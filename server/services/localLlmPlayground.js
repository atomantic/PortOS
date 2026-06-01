import { ServerError } from '../lib/errorHandler.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { ensureBackendProvider } from './localLlm.js';
import { getProviderById } from './providers.js';
import { markProviderAvailable } from './providerStatus.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';
import { readResponseJson } from '../lib/readResponseJson.js';

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
    if (text) onChunk(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoning = '';

  const consumeLine = (rawLine) => {
    const delta = extractStreamDelta(rawLine);
    if (!delta) return;
    if (delta.content) {
      output += delta.content;
      onChunk(delta.content);
    }
    if (delta.reasoning) reasoning += delta.reasoning;
  };

  // Always release the reader (and tear down the socket) on every exit path —
  // a normal finish, an abort via the timeout signal, or a throw mid-stream.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!output.trim() && reasoning.trim()) {
    output = reasoning;
    onChunk(reasoning);
  }
  return output;
}

export async function runLocalLlmTest({
  backend,
  modelId,
  prompt,
  systemPrompt = '',
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
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

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const text = await streamChatCompletion({
      provider,
      backend,
      modelId,
      prompt,
      systemPrompt,
      temperature,
      maxTokens,
      signal: controller.signal,
      onChunk: (chunk) => {
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
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
    if (runId) {
      await finalizeRunRecord({
        runId,
        output: '',
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
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text: '' }),
      options: { temperature, maxTokens, timeoutMs },
    };
  }
}

export async function compareLocalLlmModels({ targets, prompt, mode = 'round-robin', options = {} }) {
  const runOne = (target) => runLocalLlmTest({ ...options, ...target, prompt });
  const results = [];

  if (mode === 'parallel') {
    return {
      mode,
      prompt,
      results: await Promise.all(targets.map(runOne)),
    };
  }

  for (const target of targets) {
    results.push(await runOne(target));
  }
  return { mode: 'round-robin', prompt, results };
}
