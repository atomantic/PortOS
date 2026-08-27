/**
 * One streaming `POST {base}/chat/completions` against an OpenAI-compatible
 * endpoint.
 *
 * Sibling of `openAiModelsProbe.js`: that module answers "is anything serving
 * here, and what does it serve?", this one answers "generate against it and tell
 * me what streamed". Both exist because PortOS talks to five local daemons
 * (llama.cpp, Ollama, LM Studio, MTPLX, vLLM) that share exactly one wire
 * protocol and nothing else.
 *
 * Two callers, deliberately:
 *   - `services/localLlmPlayground.js` — a provider-backed run with a `/runs`
 *     record, for the backends PortOS configures as providers.
 *   - `services/localModelAssessments.js` — a measurement against a bare
 *     loopback daemon that has no provider record at all.
 *
 * Keeping the SSE read loop here means the reasoning-channel handling, the
 * skip-a-malformed-frame rule, and the partial-output-on-abort behavior are one
 * decision rather than two copies that drift.
 */

import { readResponseJson } from './readResponseJson.js';
import { fetchWithPreHeaderRetry, isReplaySafeLocalRequest } from './aiToolkit/internal/preHeaderRetry.js';

/**
 * Parse one OpenAI-style SSE `data:` line into its content/reasoning delta and,
 * when the daemon sent one, its `usage` block.
 *
 * Returns null for non-data lines, the `[DONE]`/`✅` sentinels, or a malformed
 * frame: a single bad frame must SKIP, not abort the stream — one non-JSON
 * keep-alive would otherwise throw out of the read loop and discard every
 * token already received.
 *
 * `usage` rides on a terminal frame that carries an EMPTY `choices` array (that
 * is how `stream_options.include_usage` reports it), so a frame can legitimately
 * carry a usage block and no delta at all.
 */
export function parseStreamFrame(rawLine) {
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
  const frame = {
    content: delta?.content || '',
    // llama.cpp/MTPLX commonly name the hidden channel `reasoning_content`;
    // normalize it beside the OpenAI `reasoning` spelling so a reasoning-only
    // answer is not reduced to a stray newline and scored as a one-character
    // generation.
    reasoning: delta?.reasoning || delta?.reasoning_content || delta?.thinking || '',
    // `null` = this frame reported no usage, which is every frame but the last.
    usage: parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : null,
  };
  // llama.cpp puts its authoritative prompt/decode timings on the terminal
  // chunk rather than inside OpenAI's usage object. MTPLX carries a richer
  // sibling stats block. Keep both optional so ordinary OpenAI frames retain
  // the small stable shape callers already consume.
  if (parsed?.timings && typeof parsed.timings === 'object') frame.timings = parsed.timings;
  if (parsed?.mtplx_stats && typeof parsed.mtplx_stats === 'object') frame.mtplxStats = parsed.mtplx_stats;
  return frame;
}

// Endpoints that answered 4xx to `stream_options`. A sweep runs hundreds of
// samples against the same daemon, and re-discovering its incompatibility on
// every one would double the prefill cost of each — including a 16k-token
// context. Absent from the set = never rejected (which covers "never tried"),
// the same "validate, don't infer" shape the local-LLM model caches use.
const usageUnsupportedEndpoints = new Set();

/** Test seam: forget which endpoints rejected `stream_options`. */
export function __resetUsageSupport() {
  usageUnsupportedEndpoints.clear();
}

/**
 * Normalize a provider `usage` block into the token counts PortOS records.
 *
 * Every OpenAI-compatible local daemon reports snake_case (`completion_tokens`),
 * but Ollama's native passthrough and a few forks use camelCase — accept both
 * rather than silently recording "no tokens" for half the runtimes.
 *
 * `null` on either field means NOT REPORTED. It never means zero: a zero-token
 * completion is a real (failed) measurement, and collapsing the two would let a
 * daemon that reports nothing masquerade as one that generated nothing.
 */
export function normalizeUsage(usage) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = usage?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
    return null;
  };
  return {
    completionTokens: pick('completion_tokens', 'completionTokens', 'eval_count'),
    promptTokens: pick('prompt_tokens', 'promptTokens', 'prompt_eval_count'),
  };
}

/**
 * Normalize runtime-specific timing blocks into milliseconds and counts.
 *
 * The OpenAI-compatible surface does not standardize decode timing: llama.cpp
 * uses `predicted_ms`, while MTPLX reports seconds in `mtplx_stats`. Without
 * this translation the generic clock fallback subtracts TTFT from a one-frame
 * response and can report absurd rates such as tens of thousands of tokens/s.
 * Missing fields stay absent so the caller can preserve the null sentinel.
 */
export function normalizeRuntimeTiming(timings, mtplxStats) {
  const t = timings && typeof timings === 'object' ? timings : {};
  const s = mtplxStats && typeof mtplxStats === 'object' ? mtplxStats : {};
  const firstFinite = (...values) => values.find((value) => Number.isFinite(value) && value >= 0);
  const result = {};
  const promptTokens = firstFinite(t.prompt_n, t.prompt_tokens, s.prompt_tokens);
  const completionTokens = firstFinite(t.predicted_n, t.completion_tokens, s.completion_tokens, s.generated_tokens);
  const promptMs = firstFinite(t.prompt_ms, t.prompt_eval_ms,
    Number.isFinite(s.prompt_eval_time_s) ? s.prompt_eval_time_s * 1000 : null);
  const completionMs = firstFinite(t.predicted_ms, t.completion_ms,
    Number.isFinite(s.decode_elapsed_s) ? s.decode_elapsed_s * 1000 : null,
    Number.isFinite(s.elapsed_s) ? s.elapsed_s * 1000 : null);
  if (promptTokens !== undefined) result.promptTokens = promptTokens;
  if (completionTokens !== undefined) result.completionTokens = completionTokens;
  if (promptMs !== undefined) result.promptMs = promptMs;
  if (completionMs !== undefined) result.completionMs = completionMs;
  return result;
}

/**
 * Parse one native Ollama `/api/chat` NDJSON frame.
 *
 * Ollama reports exact tokenizer counts and nanosecond timings on the terminal
 * `done` frame, but its OpenAI-compatible shim does not consistently forward
 * those fields. Keep this parser next to the SSE parser so the assessment
 * service can choose the native path without growing a second streaming loop.
 * A malformed line is skipped for the same reason as a malformed SSE frame:
 * one keep-alive or proxy fragment must not discard the output already read.
 */
export function parseOllamaStreamFrame(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const message = parsed?.message && typeof parsed.message === 'object' ? parsed.message : {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.thinking === 'string'
      ? message.thinking
      : (typeof message.reasoning === 'string' ? message.reasoning : ''),
    usage: parsed && typeof parsed === 'object' ? parsed : null,
    done: parsed?.done === true,
  };
}

/**
 * Resolve the text to surface from a (possibly interrupted) stream: prefer the
 * visible content, fall back to reasoning when no content arrived (some models
 * emit only a reasoning channel), and `''` when neither did. Used on both the
 * normal-finish path and the partial-output-on-throw path so a timed-out run
 * still shows what streamed before the abort.
 */
export function resolvePartialOutput({ output = '', reasoning = '' }) {
  if (output.trim()) return output;
  if (reasoning.trim()) return reasoning;
  return '';
}

export function buildMessages({ systemPrompt, prompt, images }) {
  const system = String(systemPrompt || '').trim();
  // A vision request is the same chat call with a multi-part user `content`,
  // in the OpenAI wire shape. Empty/absent `images` keeps the plain string form
  // rather than wrapping the prompt in a one-element array — several local
  // daemons accept only the string shape on a text-only call, so the wrapper is
  // not free.
  //
  // NOTE: this builder feeds BOTH transports. Ollama's native `/api/chat`
  // (`streamOllamaChat`) wants `{content: string, images: [bare base64]}`, not
  // `image_url` parts, so `toOllamaMessages` below converts on the way out.
  // Producing a payload one consumer cannot read is how images end up silently
  // dropped with no error.
  const parts = (Array.isArray(images) ? images : []).filter((url) => typeof url === 'string' && url);
  const content = parts.length
    ? [...parts.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }]
    : prompt;
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content },
  ];
}

/**
 * Stream a chat completion and return the final text.
 *
 * @param {object} options
 * @param {string} options.endpoint OpenAI-compatible base ending in `/v1`
 * @param {string} [options.apiKey] attached as a bearer token when set
 * @param {string} options.model
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {object} [options.extraBody] merged into the request body — how a
 *   caller passes a backend-specific knob (Ollama's `num_ctx`) without this
 *   module growing a per-backend branch.
 * @param {AbortSignal} [options.signal]
 * @param {(chunk: string, kind: 'content'|'reasoning') => any} [options.onChunk]
 *   awaited, so a consumer's backpressure reaches the upstream read loop.
 * @param {(stats: object) => void} [options.onStats] registering one is what
 *   asks the daemon for a terminal usage frame (`stream_options.include_usage`);
 *   a daemon that rejects the key is retried once without it and remembered, so
 *   no caller has to know which runtimes support it. Called exactly once, before
 *   this resolves or throws, with `{ completionTokens, promptTokens, estimated }`.
 *   Token counts are `null` when the daemon reported none AND nothing streamed
 *   to estimate from — never 0, which would read as "generated nothing".
 * @returns {Promise<string>} the streamed text. Throws on transport/HTTP
 *   failure; an abort mid-stream throws with `.partialOutput` carrying whatever
 *   had already streamed.
 */
export async function streamOpenAiChat({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  extraBody = {},
  signal,
  onChunk,
  onStats,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${String(endpoint || '').replace(/\/+$/, '')}/chat/completions`;
  // Ask for usage whenever anyone is listening — unless this endpoint already
  // told us it does not understand the key.
  const includeUsage = typeof onStats === 'function' && !usageUnsupportedEndpoints.has(url);

  const post = (withUsage) => fetchWithPreHeaderRetry(() => fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...(withUsage ? { stream_options: { include_usage: true } } : {}),
      ...extraBody,
    }),
  }), {
    signal,
    allowReplay: isReplaySafeLocalRequest({ endpoint, apiKey }),
  }).catch((err) => ({ ok: false, status: 0, error: err.message }));

  let response = await post(includeUsage);
  // `stream_options` is standard OpenAI, but a stricter daemon (or an older
  // build) can reject an unknown body key outright. Token counts are a
  // nice-to-have; the generation is not — so drop the ask and retry once rather
  // than failing a run over a metric. Narrowed to the two codes that actually
  // mean "I did not like this body": a 401 (key-gated vLLM), a 404, a 5xx, or a
  // transport error all say nothing about `stream_options`, and retrying them
  // would double every real failure.
  let responseErrorBody = '';
  const mayRejectUsage = !response.ok
    && includeUsage
    && (response.status === 400 || response.status === 422)
    && !signal?.aborted;
  if (mayRejectUsage) {
    // A bad model or request can also be a 400/422. Inspect the body before
    // caching endpoint capability, otherwise one unrelated failure disables
    // exact usage collection for every later sample on this daemon.
    responseErrorBody = typeof response.clone === 'function'
      ? await response.clone().text().catch(() => '')
      : (response.text ? await response.text().catch(() => '') : response.error || '');
    if (/stream_options|include_usage/i.test(responseErrorBody)) {
      console.log(`⚠️  Local LLM: ${model} rejected stream_options (${response.status}) — retrying without usage reporting`);
      usageUnsupportedEndpoints.add(url);
      // Drain the rejected response so its socket is released before the retry.
      await response.body?.cancel?.().catch(() => {});
      responseErrorBody = '';
      response = await post(false);
    }
  }

  if (!response.ok) {
    const body = responseErrorBody || (response.text ? await response.text().catch(() => '') : response.error || '');
    throw new Error(`Provider returned ${response.status || 0}: ${body || response.error || response.statusText || 'request failed'}`);
  }

  // A stats listener must fire on EVERY exit path, including the abort/throw one
  // — a timed-out run still measured real tokens up to the cut, and dropping
  // them would report "not measured" for a sample that was in fact measured.
  // Guarded because a broken listener must not take down a live generation.
  const emitStats = (stats) => {
    if (typeof onStats !== 'function') return;
    try { onStats(stats); }
    catch (err) { console.error(`❌ Local LLM: usage listener failed: ${err.message}`); }
  };

  if (!response.body?.getReader) {
    // A non-streaming 200 (some daemons ignore `stream: true`). Read it whole
    // rather than reporting an empty generation, which a caller would persist as
    // a successful run that produced nothing — hence the `null` sentinel on both
    // a blank and an unparseable body, which throws rather than returning ''.
    const data = await readResponseJson(response, { fallback: null, emptyValue: null });
    if (!data) throw new Error(`Provider returned a non-JSON response (${response.status})`);
    const text = data.choices?.[0]?.message?.content || '';
    // A whole-body response reports usage the same way a non-streamed call does.
    // There is no per-chunk fallback here — nothing streamed — so an absent usage
    // block stays `null` rather than being estimated from a count we never made.
    emitStats({ ...normalizeUsage(data.usage), estimated: false });
    if (text) await onChunk?.(text, 'content');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoning = '';
  // Token counts as the daemon reported them, plus the streamed-frame fallback.
  // A frame carrying content is one decode step on every local runtime PortOS
  // talks to, so counting frames approximates the completion length closely —
  // but it is an ESTIMATE and is labelled as one, never merged into the reported
  // figure. `null` until a usage frame arrives keeps "reported none" distinct
  // from "reported zero".
  //
  // CONTENT frames only, deliberately: the text this returns is content-only
  // (`resolvePartialOutput` prefers it), so counting reasoning frames too would
  // report a tokens/s figure covering more output than the chars/s figure beside
  // it — the two would disagree systematically on every reasoning model.
  let usage = null;
  let contentFrames = 0;
  let runtimeTimings = null;
  let mtplxStats = null;

  const consumeLine = async (rawLine) => {
    const delta = parseStreamFrame(rawLine);
    if (!delta) return;
    if (delta.usage) usage = delta.usage;
    if (delta.timings) runtimeTimings = delta.timings;
    if (delta.mtplxStats) mtplxStats = delta.mtplxStats;
    if (delta.content) contentFrames += 1;
    if (delta.content) {
      output += delta.content;
      await onChunk?.(delta.content, 'content');
    }
    // Reasoning streams on its own channel so a reasoning-only model
    // (deepseek-r1, qwq, …) renders as it arrives instead of sitting on
    // "waiting for the first token", and so the final content-only text does
    // not inherit reasoning prose.
    if (delta.reasoning) {
      reasoning += delta.reasoning;
      await onChunk?.(delta.reasoning, 'reasoning');
    }
  };

  // Always release the reader (and tear down the socket) on every exit path — a
  // normal finish, an abort via a timeout signal, or a throw mid-stream. On a
  // throw, surface the tokens already streamed (attached to the error) instead
  // of discarding them.
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
    const reported = normalizeUsage(usage);
    const runtime = normalizeRuntimeTiming(runtimeTimings, mtplxStats);
    emitStats(reported.completionTokens !== null
      ? { ...reported, ...runtime, estimated: false }
      // No usage block: fall back to the streamed-frame count, which is the only
      // token-shaped evidence we have. `null` when nothing streamed at all —
      // reporting 0 would file a transport failure as a zero-token generation.
      : {
        completionTokens: runtime.completionTokens ?? (contentFrames > 0 ? contentFrames : null),
        promptTokens: runtime.promptTokens ?? reported.promptTokens,
        ...(runtime.promptMs !== undefined ? { promptMs: runtime.promptMs } : {}),
        ...(runtime.completionMs !== undefined ? { completionMs: runtime.completionMs } : {}),
        estimated: runtime.completionTokens === undefined && contentFrames > 0,
      });
    await reader.cancel().catch(() => {});
  }

  return resolvePartialOutput({ output, reasoning });
}

/**
 * Stream Ollama's native `/api/chat` endpoint.
 *
 * This is intentionally an assessment-only transport. OpenCode and the local
 * playground use the OpenAI-compatible endpoint because that is the provider
 * contract they exercise; the Performance page uses this native route only to
 * obtain Ollama's exact `eval_count`, `prompt_eval_count`, `eval_duration`, and
 * `prompt_eval_duration` values. `extraBody.num_ctx` is translated into the
 * native `options.num_ctx` field, matching Ollama's API rather than the shim.
 *
 * @returns {Promise<string>} visible content, or reasoning when content is
 *   absent; an interrupted stream throws with `.partialOutput`.
 */
/**
 * OpenAI-shaped messages → Ollama's native `/api/chat` shape.
 *
 * The two differ on exactly one thing: an image rides as an `image_url` content
 * PART on the OpenAI wire and as a sibling `images: [bare base64]` array on
 * Ollama's, with the text back in `content`. `buildMessages` produces the
 * OpenAI shape for both transports, so without this the native path posts a
 * content array Ollama does not read and the images vanish with no error.
 *
 * The `data:` wrapper is stripped because Ollama wants raw base64; a text-only
 * message passes through untouched.
 */
export function toOllamaMessages(messages) {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const text = message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
    const images = message.content
      .filter((part) => part?.type === 'image_url')
      .map((part) => String(part?.image_url?.url || '').replace(/^data:[^;]+;base64,/, ''))
      .filter(Boolean);
    return { ...message, content: text, ...(images.length ? { images } : {}) };
  });
}

export async function streamOllamaChat({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  extraBody = {},
  signal,
  onChunk,
  onStats,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const base = String(endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const url = `${base}/api/chat`;
  const { num_ctx: numCtx, think, ...nativeExtra } = extraBody || {};
  const options = {
    ...nativeExtra,
    ...(Number.isFinite(Number(numCtx)) && Number(numCtx) > 0 ? { num_ctx: Number(numCtx) } : {}),
    ...(Number.isFinite(Number(temperature)) ? { temperature: Number(temperature) } : {}),
    ...(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? { num_predict: Number(maxTokens) } : {}),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages: toOllamaMessages(messages),
      stream: true,
      ...(Object.keys(options).length ? { options } : {}),
      ...(typeof think === 'boolean' ? { think } : {}),
    }),
  }).catch((err) => ({ ok: false, status: 0, error: err.message }));

  if (!response.ok) {
    const body = response.text ? await response.text().catch(() => '') : response.error || '';
    throw new Error(`Ollama returned ${response.status || 0}: ${body || response.error || response.statusText || 'request failed'}`);
  }

  const emitStats = (stats) => {
    if (typeof onStats !== 'function') return;
    try { onStats(stats); }
    catch (err) { console.error(`❌ Local LLM: Ollama usage listener failed: ${err.message}`); }
  };

  let output = '';
  let reasoning = '';
  let usage = null;
  let contentFrames = 0;
  let promptMs = null;
  let completionMs = null;
  let reader = null;

  const consumeLine = async (rawLine) => {
    const frame = parseOllamaStreamFrame(rawLine);
    if (!frame) return;
    if (frame.usage) usage = frame.usage;
    if (Number.isFinite(frame.usage?.prompt_eval_duration)) {
      promptMs = frame.usage.prompt_eval_duration / 1e6;
    }
    if (Number.isFinite(frame.usage?.eval_duration)) {
      completionMs = frame.usage.eval_duration / 1e6;
    }
    if (frame.content) {
      contentFrames += 1;
      output += frame.content;
      await onChunk?.(frame.content, 'content');
    }
    if (frame.reasoning) {
      reasoning += frame.reasoning;
      await onChunk?.(frame.reasoning, 'reasoning');
    }
  };

  try {
    if (!response.body?.getReader) {
      const body = await response.text?.() || '';
      for (const line of body.split(/\r?\n/)) await consumeLine(line);
    } else {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) await consumeLine(line);
      }
      if (buffer.trim()) await consumeLine(buffer);
    }
  } catch (err) {
    err.partialOutput = resolvePartialOutput({ output, reasoning });
    throw err;
  } finally {
    const reported = normalizeUsage(usage);
    emitStats({
      ...reported,
      // Ollama's durations are nanoseconds. Keep the converted milliseconds
      // beside the counts so the caller can calculate decode and prefill rates
      // without subtracting two clocks that include different work.
      ...(Number.isFinite(completionMs) ? { completionMs } : {}),
      ...(Number.isFinite(promptMs) ? { promptMs } : {}),
      estimated: reported.completionTokens === null && contentFrames > 0,
      ...(reported.completionTokens === null && contentFrames > 0 ? { completionTokens: contentFrames } : {}),
    });
    await reader?.cancel?.().catch(() => {});
  }

  return resolvePartialOutput({ output, reasoning });
}
