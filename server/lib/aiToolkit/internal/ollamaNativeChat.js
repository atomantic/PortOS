import { isOllamaBackedProvider, ollamaBaseFromProvider } from './ollamaBacked.js';

/**
 * Ollama's native `/api/chat` transport for API runs that carry a `numCtx`.
 *
 * Ollama's OpenAI-compatible `/v1/chat/completions` has no way to set the
 * context window: it ignores both a top-level `num_ctx` and an `options`
 * object, so every `/v1` request loads the model at the daemon default
 * (`OLLAMA_CONTEXT_LENGTH`, 4096 when unset) and the daemon silently keeps
 * only the prompt's tail (`truncating input prompt limit=2050 …`). A
 * configured `numCtx` therefore never took effect for a `/v1` run, and a model
 * loaded at a wider window by another caller was reloaded back down by the
 * next `/v1` request. The native endpoint honors `options.num_ctx`, so a run
 * whose provider asks for a window goes there instead. Runs with no `numCtx`
 * stay on `/v1`, where the daemon default is exactly what they asked for.
 *
 * The native stream is NDJSON (`{message:{content,thinking},done,done_reason}`
 * per line, `{error}` on failure) rather than SSE; {@link ollamaNativeFrameToChunk}
 * reshapes each frame into the OpenAI chunk the runner's reader already
 * consumes, so cancellation, stall bounds, reasoning salvage and finalization
 * are shared with the `/v1` path rather than restated.
 *
 * Self-contained like the rest of this directory (see ../AGENTS.md).
 */

/** The configured window as a positive integer, or `null`. */
function requestedNumCtx(provider) {
  const n = Number(provider?.numCtx);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * The native chat URL to use for this provider's API run, or `null` to keep
 * the OpenAI-compatible `/v1/chat/completions` request. Only an Ollama daemon
 * with an explicit `numCtx` moves: that is the one setting `/v1` cannot carry.
 *
 * @param {object|null|undefined} provider
 * @returns {string|null}
 */
export function ollamaNativeChatUrl(provider) {
  if (!requestedNumCtx(provider) || !provider?.endpoint) return null;
  if (!isOllamaBackedProvider(provider)) return null;
  return `${ollamaBaseFromProvider({ endpoint: provider.endpoint })}/api/chat`;
}

/** `data:image/png;base64,AAAA` → `AAAA`; native messages take bare base64. */
function bareBase64(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma !== -1 ? s.slice(comma + 1) : s;
}

/**
 * One OpenAI-style user message (string or content-part array) as a native
 * Ollama message: text joined into `content`, images into `images`.
 */
function toNativeMessage(messageContent) {
  if (!Array.isArray(messageContent)) return { role: 'user', content: String(messageContent ?? '') };
  const text = [];
  const images = [];
  for (const part of messageContent) {
    if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
    else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) images.push(bareBase64(url));
    }
  }
  return { role: 'user', content: text.join('\n'), ...(images.length ? { images } : {}) };
}

/**
 * The native `/api/chat` body equivalent to the runner's `/v1` body.
 * `generation` is the `apiGenerationOptions(provider)` result: sampling knobs
 * move under `options`, Ollama's own `think` flag stays top-level.
 *
 * @param {{ model: string, messageContent: string|Array<object>, provider: object, generation?: object, maxTokens?: number }} args
 */
export function buildOllamaNativeChatBody({ model, messageContent, provider, generation = {}, maxTokens }) {
  const { think, temperature, top_p: topP } = generation;
  return {
    model,
    messages: [toNativeMessage(messageContent)],
    stream: true,
    ...(typeof think === 'boolean' ? { think } : {}),
    options: {
      num_ctx: requestedNumCtx(provider),
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { num_predict: maxTokens } : {}),
    },
  };
}

/**
 * One parsed native stream frame as the OpenAI chunk shape the runner reads
 * (`choices[0].delta.{content,thinking}` + `finish_reason`). A frame carrying
 * `error` throws so the run finalizes as a stream error instead of a silent,
 * empty success.
 *
 * @param {object} frame
 * @returns {object}
 */
export function ollamaNativeFrameToChunk(frame) {
  if (frame?.error) throw new Error(`Ollama stream error: ${String(frame.error)}`);
  const message = frame?.message || {};
  const delta = {};
  if (typeof message.content === 'string' && message.content) delta.content = message.content;
  if (typeof message.thinking === 'string' && message.thinking) delta.thinking = message.thinking;
  const finishReason = frame?.done === true ? (frame.done_reason || 'stop') : null;
  return { choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] };
}
