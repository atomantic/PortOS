// LM Studio streaming chat — SSE parser yielding token deltas via onDelta callback.

const LM_STUDIO_BASE = () => (process.env.LM_STUDIO_URL || 'http://localhost:1234')
  .replace(/\/+$/, '').replace(/\/v1$/, '');

// Approximate parameter count from LM Studio model id so 'auto' avoids a 70B
// when smaller, faster models are available. Returns Infinity for non-matches
// and utility models so they sort last rather than silently winning ties.
// Accepts "7B", "7 B", "7b", "1.5B" plus MoE ids like "8x7B" (ranked by total
// experts × per-expert size; checked first so the naive `\d+\s*b\b` match
// doesn't silently rank "8x7B" as 7B). Utility-model filter runs first and is
// case-insensitive so "BAAI/bge-embed" / "Cohere/rerank" are excluded even
// when they happen to contain a size token.
const sizeRank = (id) => {
  const normalized = String(id).toLowerCase();
  if (/embed|rerank/.test(normalized)) return Infinity;
  const moe = normalized.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
  const m = normalized.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (m) return parseFloat(m[1]);
  return Infinity;
};

const resolveModel = async (requested) => {
  const res = await fetch(`${LM_STUDIO_BASE()}/v1/models`).catch(() => null);
  if (!res || !res.ok) return requested && requested !== 'auto' ? requested : null;
  const body = await res.json();
  const ids = (body?.data || []).map((m) => m.id);
  if (requested && requested !== 'auto') {
    return ids.includes(requested) ? requested : ids[0] || null;
  }
  // 'auto' → smallest non-utility model, or first if no size info
  const sorted = ids.slice().sort((a, b) => sizeRank(a) - sizeRank(b));
  return sorted[0] || null;
};

/**
 * Stream an LM Studio chat completion. Text deltas are forwarded via onDelta
 * for TTS; tool_call fragments are buffered per-index and returned at the end
 * so the pipeline can execute them and loop.
 *
 * @param {Array<object>} messages
 * @param {object} opts
 * @param {string} [opts.model='auto']
 * @param {AbortSignal} [opts.signal]
 * @param {(delta: string) => void} [opts.onDelta]
 * @param {Array<object>} [opts.tools]  OpenAI-format tool specs (optional)
 * @returns {Promise<{ text: string, toolCalls: Array<object>, model: string|null, ttfbMs: number|null, totalMs: number, finishReason: string|null }>}
 */
export const streamChat = async (messages, opts = {}) => {
  const model = await resolveModel(opts.model);
  if (!model) throw new Error('No LM Studio model available');

  const started = Date.now();
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.5,
    max_tokens: opts.maxTokens ?? 250,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

  const res = await fetch(`${LM_STUDIO_BASE()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`LM Studio chat failed: ${res.status} ${errBody.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let text = '';
  let ttfbMs = null;
  let finishReason = null;
  // Tool calls stream as fragments keyed by index; accumulate until [DONE].
  const toolCallFrags = new Map();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        const toolCalls = [...toolCallFrags.values()].sort((a, b) => a.index - b.index);
        return { text, toolCalls, model, ttfbMs, totalMs: Date.now() - started, finishReason };
      }
      // Malformed SSE frames (proxy keep-alive, truncated write) would otherwise
      // abort the whole turn; skip the line and keep streaming.
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (delta.content) {
        if (ttfbMs === null) ttfbMs = Date.now() - started;
        text += delta.content;
        opts.onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const frag = toolCallFrags.get(tc.index) || {
          index: tc.index,
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (tc.id) frag.id = tc.id;
        if (tc.type) frag.type = tc.type;
        // `name` is sent once per tool call per the OpenAI spec; set-once
        // rather than concatenate so a split fragment can't produce garbage.
        if (tc.function?.name && !frag.function.name) frag.function.name = tc.function.name;
        if (tc.function?.arguments) frag.function.arguments += tc.function.arguments;
        toolCallFrags.set(tc.index, frag);
      }
    }
  }
  const toolCalls = [...toolCallFrags.values()].sort((a, b) => a.index - b.index);
  return { text, toolCalls, model, ttfbMs, totalMs: Date.now() - started, finishReason };
};
